// ─────────────────────────────────────────────
//  Passphrase / key-agreement guard (onboarding footgun)
// ─────────────────────────────────────────────
//
//  A device whose passphrase (or salt) derives a different key than the vault was
//  established with must fail LOUDLY and actionably — a `KeyMismatchError` thrown
//  before it decrypts a single remote op or pushes under its divergent key — rather
//  than wedging the vault into two key regimes or dying on a raw AES decrypt
//  exception mid-pull. The first device to touch a vault stamps a key-check record;
//  every device confirms it before trusting/pushing.
//
//  Drives the genuine ServerSyncClient round against the fake server.

import { describe, test, expect } from 'vitest';
import { ServerSyncClient, KeyMismatchError } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([1, 1, 2, 3, 5, 8, 13, 21, 1, 1, 2, 3, 5, 8, 13, 21]);

async function crypto(passphrase: string): Promise<VaultCrypto> {
  const vc = new VaultCrypto();
  await vc.deriveFromPassphrase(passphrase, SALT);
  return vc;
}

const client = (api: FakeSyncServer, vc: VaultCrypto, d: TestDevice) =>
  new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

describe('key-check guard: a mismatched passphrase fails clean, not silent', () => {
  test('a wrong-key device joining an established vault rejects with KeyMismatchError and pushes nothing', async () => {
    const server = new FakeSyncServer();
    const right = await crypto('correct horse battery staple');
    const wrong = await crypto('correct horse battery stapl');   // one char off

    // ── A (correct key) establishes the vault: pushes a file + stamps the key-check. ──
    const A = await TestDevice.create('dev-a');
    await A.seedFile('note.md', 'hello\n', 1000);
    await client(server, right, A).runSync();
    const opsAfterA = server.opCount;

    // ── B (wrong key) has its own local edit and tries to sync. ──
    const B = await TestDevice.create('dev-b');
    await B.seedFile('mine.md', 'draft\n', 2000);

    // It must reject with a *clean* KeyMismatchError — NOT a raw AES/GCM exception
    // from decrypting A's op, and NOT a silent push under the divergent key.
    await expect(client(server, wrong, B).runSync()).rejects.toBeInstanceOf(KeyMismatchError);

    // Nothing of B's landed on the server; its work survives locally for retry.
    expect(server.opCount).toBe(opsAfterA);
    expect(B.pendingOps.length).toBeGreaterThan(0);
  });

  test('a wrong-key device that claims an EMPTY vault first still lets the correct device fail clean', async () => {
    const server = new FakeSyncServer();
    const wrong = await crypto('typo-on-first-device');
    const right = await crypto('the-intended-passphrase');

    // ── B (mistyped) is first into the empty vault: it claims the key-check under
    //    its divergent key and pushes its ops. (It can't know it's wrong — nothing
    //    to check against yet.) ──
    const B = await TestDevice.create('dev-b');
    await B.seedFile('note.md', 'oops\n', 1000);
    await client(server, wrong, B).runSync();
    expect(server.opCount).toBe(1);

    // ── A (intended key) joins. It must get the clean KeyMismatchError, not a raw
    //    decrypt exception on B's op. ──
    const A = await TestDevice.create('dev-a');
    await expect(client(server, right, A).runSync()).rejects.toBeInstanceOf(KeyMismatchError);
  });

  test('two devices sharing the same passphrase converge normally through the guard', async () => {
    const server = new FakeSyncServer();
    const vc = await crypto('shared secret');

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', 'body\n', 1000);
    await client(server, vc, A).runSync();       // A establishes + stamps the key-check
    await client(server, vc, B).runSync();       // B verifies and pulls

    expect(new TextDecoder().decode((await B.files.read('note.md'))!)).toBe('body\n');

    // A returning device re-verifies each round without re-stamping (idempotent).
    await B.editFile('note.md', 'body\nmore\n', 2000);
    await client(server, vc, B).runSync();
    await client(server, vc, A).runSync();
    expect(new TextDecoder().decode((await A.files.read('note.md'))!)).toBe('body\nmore\n');
  });
});
