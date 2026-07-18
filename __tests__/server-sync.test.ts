// ─────────────────────────────────────────────
//  Tests — Server transport client (Phase 3)
//  Full pull→merge→push round against the in-memory fake; cursor advancement;
//  blob dedup; idempotent append; remote-state reconstruction.
// ─────────────────────────────────────────────

import { describe, test, expect, beforeAll } from 'vitest';
import {
  ServerSyncClient,
  reconstructRemoteState,
  VaultSyncHost,
} from '../src/network/server-sync';
import { FakeSyncServer, MissingBlobError } from '../src/network/fake-server';
import { VaultCrypto } from '../src/network/encryption';
import { HybridLogicalClock } from '../src/core/hlc';
import { VaultState, FileEntry, MergeAction, Operation, HLC } from '../src/types';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

async function sha256Hex(content: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', content);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** An in-memory VaultSyncHost that also applies merge actions to its own state,
 *  so a device converges across successive rounds. */
class MemoryHost implements VaultSyncHost {
  fileEntries = new Map<string, FileEntry>();
  content = new Map<string, Uint8Array>();
  pendingOps: Operation[] = [];
  cursor = 0;
  applied: MergeAction[] = [];

  constructor(private deviceId: string) {}

  async buildLocalState(): Promise<VaultState> {
    return {
      deviceId: this.deviceId,
      hlc: { wallTime: 0, counter: 0, deviceId: this.deviceId },
      fileEntries: new Map(this.fileEntries),
      pendingOps: [...this.pendingOps],
      contentStore: new Map(this.content),
    };
  }

  async applyMerge(actions: MergeAction[]): Promise<void> {
    this.applied.push(...actions);
    for (const a of actions) {
      if (a.type === 'write_local') {
        const hash = await sha256Hex(a.content);
        this.content.set(hash, a.content);
        this.fileEntries.set(a.fileId, {
          id: a.fileId, path: a.path, contentHash: hash,
          hlcTimestamp: a.hlc, deleted: false, ancestorContentHash: hash,
        });
      } else if (a.type === 'delete_local') {
        const e = this.fileEntries.get(a.fileId);
        if (e) this.fileEntries.set(a.fileId, { ...e, deleted: true });
      }
    }
  }

  async clearPendingOps(): Promise<void> { this.pendingOps = []; }
  async loadCursor(): Promise<number> { return this.cursor; }
  async saveCursor(c: number): Promise<void> { this.cursor = c; }
}

function client(api: FakeSyncServer, crypto: VaultCrypto, host: MemoryHost, deviceId: string): ServerSyncClient {
  return new ServerSyncClient({ api, crypto, host, hlc: new HybridLogicalClock(deviceId) });
}

/** Seed a host with one freshly-created file + its pending create op. */
async function seedFile(host: MemoryHost, deviceId: string, fileId: string, path: string, text: string, wall: number): Promise<{ hash: string }> {
  const content = new TextEncoder().encode(text);
  const hash = await sha256Hex(content);
  const hlc: HLC = { wallTime: wall, counter: 0, deviceId };
  host.content.set(hash, content);
  host.fileEntries.set(fileId, { id: fileId, path, contentHash: hash, hlcTimestamp: hlc, deleted: false, ancestorContentHash: null });
  host.pendingOps.push({ id: `${deviceId}-op-${fileId}`, deviceId, hlcTimestamp: hlc, fileId, type: 'create', path, contentHash: hash });
  return { hash };
}

describe('reconstructRemoteState', () => {
  const base = (fileId: string, type: Operation['type'], hash: string, wall: number, counter = 0): Operation => ({
    id: `op-${wall}-${counter}`, deviceId: 'dev-x', hlcTimestamp: { wallTime: wall, counter, deviceId: 'dev-x' },
    fileId, type, path: `${fileId}.md`, contentHash: hash,
  });

  test('latest op per file wins by HLC', () => {
    const state = reconstructRemoteState([
      base('f1', 'create', 'h-old', 100),
      base('f1', 'update', 'h-new', 200),
    ]);
    expect(state.fileEntries.get('f1')!.contentHash).toBe('h-new');
    expect(state.fileEntries.size).toBe(1);
  });

  test('out-of-order ops still resolve to the highest HLC', () => {
    const state = reconstructRemoteState([
      base('f1', 'update', 'h-new', 200),
      base('f1', 'create', 'h-old', 100),
    ]);
    expect(state.fileEntries.get('f1')!.contentHash).toBe('h-new');
  });

  test('a delete op marks the entry deleted', () => {
    const state = reconstructRemoteState([
      base('f1', 'create', 'h1', 100),
      base('f1', 'delete', 'h1', 300),
    ]);
    expect(state.fileEntries.get('f1')!.deleted).toBe(true);
  });

  test('empty log yields an empty projection', () => {
    const state = reconstructRemoteState([]);
    expect(state.fileEntries.size).toBe(0);
  });
});

describe('FakeSyncServer', () => {
  test('append is idempotent by clientOpId', async () => {
    const s = new FakeSyncServer();
    const rec = { clientOpId: 'c1', ciphertext: 'x', blobRefs: [] };
    const r1 = await s.appendOps(0, [rec]);
    const r2 = await s.appendOps(0, [rec]);
    expect(r1.assigned[0]!.seq).toBe(r2.assigned[0]!.seq);
    expect(s.opCount).toBe(1);
  });

  test('append 422s when a referenced blob is missing', async () => {
    const s = new FakeSyncServer();
    await expect(s.appendOps(0, [{ clientOpId: 'c1', ciphertext: 'x', blobRefs: ['missing'] }]))
      .rejects.toBeInstanceOf(MissingBlobError);
  });

  test('pull paginates with hasMore', async () => {
    const s = new FakeSyncServer();
    for (let i = 0; i < 3; i++) await s.appendOps(0, [{ clientOpId: `c${i}`, ciphertext: `ct${i}`, blobRefs: [] }]);
    const p1 = await s.pullOps(0, 2);
    expect(p1.ops.map(o => o.seq)).toEqual([1, 2]);
    expect(p1.hasMore).toBe(true);
    const p2 = await s.pullOps(p1.nextCursor, 2);
    expect(p2.ops.map(o => o.seq)).toEqual([3]);
    expect(p2.hasMore).toBe(false);
  });
});

describe('ServerSyncClient — full round against the fake', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('A pushes a file; B pulls, merges, and converges; cursor advances', async () => {
    const server = new FakeSyncServer();
    const hostA = new MemoryHost('dev-a');
    const hostB = new MemoryHost('dev-b');
    const { hash } = await seedFile(hostA, 'dev-a', 'f1', 'groceries.md', '# Groceries\nmilk\n', 1000);

    // ── Round on A: push the create ──────────────────────────────────────────
    await client(server, vc, hostA, 'dev-a').runSync();
    expect(server.opCount).toBe(1);
    expect(server.blobCount).toBe(1);
    expect(hostA.pendingOps).toHaveLength(0);
    expect(hostA.cursor).toBe(0); // nothing pulled this round; our own op re-pulls next round

    // ── Round on B: pull the create, fetch the blob, write it locally ────────
    await client(server, vc, hostB, 'dev-b').runSync();
    expect(hostB.cursor).toBe(1);
    const wrote = hostB.applied.find(a => a.type === 'write_local');
    expect(wrote).toBeTruthy();
    expect(hostB.fileEntries.get('f1')!.contentHash).toBe(hash);
    const stored = hostB.content.get(hash);
    expect(stored && new TextDecoder().decode(stored)).toBe('# Groceries\nmilk\n');
  });

  test('re-running a device does not double-append and settles its cursor', async () => {
    const server = new FakeSyncServer();
    const hostA = new MemoryHost('dev-a');
    await seedFile(hostA, 'dev-a', 'f1', 'a.md', 'hello', 1000);

    await client(server, vc, hostA, 'dev-a').runSync(); // pushes op, cursor stays 0
    await client(server, vc, hostA, 'dev-a').runSync(); // re-pulls own op → no-op, cursor → 1

    expect(server.opCount).toBe(1);       // no duplicate append
    expect(hostA.cursor).toBe(1);
    // The re-pulled own op is a no_op (same content) — no write applied.
    expect(hostA.applied.some(a => a.type === 'write_local')).toBe(false);
  });

  test('blobs are deduplicated across devices via blobs:check', async () => {
    const server = new FakeSyncServer();
    const hostA = new MemoryHost('dev-a');
    const hostB = new MemoryHost('dev-b');
    // Identical content on both devices, different fileIds.
    await seedFile(hostA, 'dev-a', 'f1', 'a.md', 'shared body', 1000);
    await seedFile(hostB, 'dev-b', 'f2', 'b.md', 'shared body', 1000);

    await client(server, vc, hostA, 'dev-a').runSync();
    await client(server, vc, hostB, 'dev-b').runSync();

    expect(server.opCount).toBe(2);   // two ops
    expect(server.blobCount).toBe(1); // but one shared blob (dedup held)
  });
});
