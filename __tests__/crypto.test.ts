// ─────────────────────────────────────────────
//  Tests — VaultCrypto (E2E vault encryption)
//  Phase 2: op + blob envelopes, hash blinding, key verification
// ─────────────────────────────────────────────

import { describe, test, expect, beforeAll } from 'vitest';
import { VaultCrypto } from '../src/network/encryption';

// Mirror of content-store's hashContent (imported directly would pull in the
// `obsidian` module, which isn't resolvable under the test runner).
async function hashContent(content: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', content);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const SALT_2 = new Uint8Array([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

// Deriving keys runs PBKDF2 (600k iters) — do it once and share across a describe.
async function crypto1(): Promise<VaultCrypto> {
  const c = new VaultCrypto();
  await c.deriveFromPassphrase('correct horse battery staple', SALT);
  return c;
}

describe('VaultCrypto — op envelope', () => {
  let vc: VaultCrypto;
  beforeAll(async () => { vc = await crypto1(); });

  test('round-trips a serializable op record', async () => {
    const op = {
      id: 'op-1', deviceId: 'dev-a', type: 'update',
      path: 'notes/secret.md', contentHash: 'abc123',
      hlcTimestamp: { wallTime: 1721300000000, counter: 3, deviceId: 'dev-a' },
    };
    const envelope = await vc.encryptOp(op);
    expect(typeof envelope).toBe('string');
    expect(await vc.decryptOp(envelope)).toEqual(op);
  });

  test('ciphertext leaks neither plaintext nor a fixed prefix (random nonce)', async () => {
    const op = { path: 'notes/secret.md' };
    const a = await vc.encryptOp(op);
    const b = await vc.encryptOp(op);
    expect(a).not.toBe(b);                       // fresh nonce each time
    expect(atob(a)).not.toContain('secret.md');  // plaintext not visible
  });

  test('decrypt fails under a different key', async () => {
    const other = new VaultCrypto();
    await other.deriveFromPassphrase('a different passphrase', SALT);
    const envelope = await vc.encryptOp({ path: 'x.md' });
    await expect(other.decryptOp(envelope)).rejects.toThrow();
  });
});

describe('VaultCrypto — blob envelope', () => {
  let vc: VaultCrypto;
  beforeAll(async () => { vc = await crypto1(); });

  test('round-trips arbitrary binary content (bytes > 127, zeros)', async () => {
    const content = new Uint8Array(512);
    for (let i = 0; i < content.length; i++) content[i] = (i * 37) % 256;
    content[0] = 0; content[1] = 255;
    const envelope = await vc.encryptBlob(content);
    expect(envelope).toBeInstanceOf(Uint8Array);
    expect(envelope.length).toBeGreaterThan(content.length); // nonce + GCM tag overhead
    expect(await vc.decryptBlob(envelope)).toEqual(content);
  });

  test('round-trips empty content', async () => {
    const empty = new Uint8Array(0);
    expect(await vc.decryptBlob(await vc.encryptBlob(empty))).toEqual(empty);
  });

  test('a flipped byte in the envelope fails authentication', async () => {
    const envelope = await vc.encryptBlob(new TextEncoder().encode('hello'));
    const last = envelope.length - 1;
    envelope[last] = envelope[last]! ^ 0x01;
    await expect(vc.decryptBlob(envelope)).rejects.toThrow();
  });
});

describe('VaultCrypto — hash blinding (spec §9.1)', () => {
  test('is deterministic under a fixed key → dedup is preserved', async () => {
    const vc = await crypto1();
    const raw = await hashContent(new TextEncoder().encode('shared note body'));
    expect(await vc.blindHash(raw)).toBe(await vc.blindHash(raw));
  });

  test('two devices sharing a passphrase produce the same blinded key', async () => {
    const a = new VaultCrypto();
    const b = new VaultCrypto();
    await a.deriveFromPassphrase('team vault pw', SALT);
    await b.deriveFromPassphrase('team vault pw', SALT);
    const raw = await hashContent(new TextEncoder().encode('shared'));
    expect(await a.blindHash(raw)).toBe(await b.blindHash(raw)); // cross-device dedup holds
  });

  test('distinct content hashes map to distinct blinded keys', async () => {
    const vc = await crypto1();
    const h1 = await hashContent(new TextEncoder().encode('one'));
    const h2 = await hashContent(new TextEncoder().encode('two'));
    expect(await vc.blindHash(h1)).not.toBe(await vc.blindHash(h2));
  });

  test('a different key blinds the same hash differently (unlinkable across vaults)', async () => {
    const a = await crypto1();
    const b = new VaultCrypto();
    await b.deriveFromPassphrase('another vault pw', SALT);
    const raw = await hashContent(new TextEncoder().encode('same bytes'));
    expect(await a.blindHash(raw)).not.toBe(await b.blindHash(raw));
  });

  test('blinded key is a 64-char hex string and not the raw hash', async () => {
    const vc = await crypto1();
    const raw = await hashContent(new TextEncoder().encode('x'));
    const blinded = await vc.blindHash(raw);
    expect(blinded).toMatch(/^[0-9a-f]{64}$/);
    expect(blinded).not.toBe(raw);
  });
});

describe('VaultCrypto — key verification', () => {
  test('same passphrase + salt → same fingerprint', async () => {
    const a = new VaultCrypto();
    const b = new VaultCrypto();
    await a.deriveFromPassphrase('pw', SALT);
    await b.deriveFromPassphrase('pw', SALT);
    expect(a.fingerprint()).toBe(b.fingerprint());
  });

  test('a mistyped passphrase yields a different fingerprint', async () => {
    const a = new VaultCrypto();
    const b = new VaultCrypto();
    await a.deriveFromPassphrase('pw', SALT);
    await b.deriveFromPassphrase('pW', SALT);
    expect(a.fingerprint()).not.toBe(b.fingerprint());
  });

  test('the same passphrase under a different salt yields a different fingerprint', async () => {
    const a = new VaultCrypto();
    const b = new VaultCrypto();
    await a.deriveFromPassphrase('pw', SALT);
    await b.deriveFromPassphrase('pw', SALT_2);
    expect(a.fingerprint()).not.toBe(b.fingerprint());
  });
});

describe('VaultCrypto — key-check record (passphrase/key-agreement guard)', () => {
  test('a record built under a key verifies true only under the same passphrase+salt', async () => {
    const a = new VaultCrypto();
    const same = new VaultCrypto();
    const wrongPass = new VaultCrypto();
    const wrongSalt = new VaultCrypto();
    await a.deriveFromPassphrase('pw', SALT);
    await same.deriveFromPassphrase('pw', SALT);
    await wrongPass.deriveFromPassphrase('pW', SALT);
    await wrongSalt.deriveFromPassphrase('pw', SALT_2);

    const record = await a.buildKeyCheck();

    expect(await a.verifyKeyCheck(record)).toBe(true);          // self
    expect(await same.verifyKeyCheck(record)).toBe(true);        // peer with the same key
    expect(await wrongPass.verifyKeyCheck(record)).toBe(false);  // GCM auth fails — wrong key
    expect(await wrongSalt.verifyKeyCheck(record)).toBe(false);
  });

  test('verifyKeyCheck returns false (never throws) on garbage bytes', async () => {
    const a = new VaultCrypto();
    await a.deriveFromPassphrase('pw', SALT);
    expect(await a.verifyKeyCheck(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toBe(false);
  });

  test('the record before derivation throws', async () => {
    const vc = new VaultCrypto();
    await expect(vc.buildKeyCheck()).rejects.toThrow();
    await expect(vc.verifyKeyCheck(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('VaultCrypto — guards', () => {
  test('operations before derivation throw', async () => {
    const vc = new VaultCrypto();
    expect(vc.isReady()).toBe(false);
    expect(() => vc.fingerprint()).toThrow();
    await expect(vc.encryptOp({})).rejects.toThrow();
    await expect(vc.encryptBlob(new Uint8Array(1))).rejects.toThrow();
    await expect(vc.blindHash('deadbeef')).rejects.toThrow();
  });

  test('isReady() is true after derivation', async () => {
    const vc = await crypto1();
    expect(vc.isReady()).toBe(true);
  });
});
