// ─────────────────────────────────────────────
// Tests — round interruption & durability (spec Part 2, C1–C4)
// ─────────────────────────────────────────────
//
// What survives a plugin restart / crash, and does a re-run after a crash stay
// safe (no lost edits, no duplicate ops, no spurious conflict)?
//
// Driven through the REAL device stack (TestDevice) over the in-memory fakes.
// A "restart" is `device.reload()` — a fresh stack over the SAME vault bytes +
// `.vault-sync/*` metadata, seeded from the persisted HLC, so everything durable
// (registry, oplog, cursor, sync-state, logical time) survives and only
// in-memory-only state is dropped. After a reload the old instance is defunct.
//
// A true mid-`runSync` interrupt isn't reachable — the method is atomic to a
// caller. So each crash seam is modelled by injecting a throw at exactly that
// seam (a wrapper host/api) or by reproducing the persisted state a crash would
// leave behind (a cursor rewind), then asserting the recovery. Where a seam can't
// be injected, the comment says so and the test pins the property recovery leans on.

import { describe, test, expect, beforeAll } from 'vitest';
import {
  ServerSyncClient,
  VaultSyncHost,
  ServerApi,
  PullOpsResult,
  AppendOp,
  AppendResult,
} from '../src/network/server-sync';
import { FakeSyncServer } from '../src/network/fake-server';
import { VaultCrypto } from '../src/network/encryption';
import { VaultState, MergeAction, Operation } from '../src/types';
import { VersionDag } from '../src/core/version-dag';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

const text = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);

/**
 * Wraps the real VaultSyncHost so the FIRST `clearPendingOps` throws — modelling a
 * crash *after* the round pushed its ops to the server but *before* it cleared the
 * local oplog. The append already landed; the pending log was never cleared, so a
 * restart must re-push and rely on append idempotency (clientOpId) to avoid a
 * duplicate. Every other call delegates.
 */
class CrashOnFirstClearHost implements VaultSyncHost {
  private armed = true;
  constructor(private readonly inner: VaultSyncHost) {}
  buildLocalState(): Promise<VaultState> { return this.inner.buildLocalState(); }
  applyMerge(a: MergeAction[], l: VaultState, r: VaultState): Promise<{ deferred: Set<string>; converged: Set<string> }> { return this.inner.applyMerge(a, l, r); }
  async clearPendingOps(): Promise<void> {
    if (this.armed) { this.armed = false; throw new Error('simulated crash after push, before clearOps'); }
    return this.inner.clearPendingOps();
  }
  loadCursor(): Promise<number> { return this.inner.loadCursor(); }
  saveCursor(c: number): Promise<void> { return this.inner.saveCursor(c); }
  recordVersionEdges(ops: Operation[]): Promise<VersionDag> { return this.inner.recordVersionEdges(ops); }
}

/**
 * Wraps a FakeSyncServer so the FIRST `appendOps` throws — modelling a crash
 * *after* the blob was uploaded (`putBlob` already ran) but *before* the op was
 * appended. A restart must not re-upload a duplicate blob (`blobs:check` sees it)
 * and must land the op exactly once. Every other call delegates.
 */
class CrashOnFirstAppendServer implements ServerApi {
  private armed = true;
  constructor(private readonly inner: FakeSyncServer) {}
  pullOps(since: number, limit: number): Promise<PullOpsResult> { return this.inner.pullOps(since, limit); }
  async appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
    if (this.armed) { this.armed = false; throw new Error('simulated crash after putBlob, before appendOps'); }
    return this.inner.appendOps(baseCursor, ops);
  }
  checkBlobs(hashes: string[]): Promise<{ missing: string[] }> { return this.inner.checkBlobs(hashes); }
  putBlob(hash: string, bytes: Uint8Array): Promise<void> { return this.inner.putBlob(hash, bytes); }
  getBlob(hash: string): Promise<Uint8Array | null> { return this.inner.getBlob(hash); }
}

describe('round interruption & durability (C1–C4)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const client = (api: ServerApi, device: TestDevice): ServerSyncClient =>
    new ServerSyncClient({ api, crypto: vc, host: device.host, hlc: device.hlc });

  // ── C3(a) — a fully-synced device survives a restart intact ──────────────────
  test('C3a: cursor, registry and content survive a restart; a fresh sync is a clean no-op', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    const id1 = await A.seedFile('one.md', 'first\n', 1000);
    const id2 = await A.seedFile('two.md', 'second\n', 1000);
    const h1 = A.entry(id1)!.contentHash;
    const h2 = A.entry(id2)!.contentHash;

    await client(server, A).runSync();  // push both ops (cursor stays 0)
    await client(server, A).runSync();  // re-pull our own two ops → no-op, cursor → 2
    expect(await A.cursor()).toBe(2);
    expect(A.pendingOps).toHaveLength(0);

    // ── Restart. Everything durable must come back exactly as it was. ──
    const A2 = await A.reload();
    expect(await A2.cursor()).toBe(2);                       // cursor survived
    expect(A2.entry(id1)!.contentHash).toBe(h1);            // registry survived
    expect(A2.entry(id2)!.contentHash).toBe(h2);
    expect(text(await A2.content(h1))).toBe('first\n');     // content survived
    expect(text(await A2.content(h2))).toBe('second\n');
    expect(A2.pendingOps).toHaveLength(0);

    // A fresh round after the restart changes nothing on the server…
    await client(server, A2).runSync();
    expect(server.opCount).toBe(2);
    expect(await A2.cursor()).toBe(2);
    expect(A2.pendingOps).toHaveLength(0);

    // …and B still converges to both files.
    await client(server, B).runSync();
    expect(text(await B.files.read('one.md'))).toBe('first\n');
    expect(text(await B.files.read('two.md'))).toBe('second\n');
  });

  // ── C3(b) — an UNSYNCED oplog survives a restart and still ships ─────────────
  test('C3b: un-synced pending ops survive a restart and are pushed on the next sync', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // A makes edits but never syncs — the ops sit in .vault-sync/oplog.json only.
    await A.seedFile('draft.md', 'unsynced work\n', 1000);
    await A.seedFile('notes.md', 'more unsynced\n', 1000);
    expect(A.pendingOps).toHaveLength(2);
    expect(server.opCount).toBe(0); // nothing reached the server

    // ── Restart before ever syncing. The un-pushed work must survive. ──
    const A2 = await A.reload();
    expect(A2.pendingOps).toHaveLength(2);
    expect(A2.pendingOps.map(op => op.path).sort()).toEqual(['draft.md', 'notes.md']);

    // The reloaded device pushes them, and B receives the content — no edit lost
    // to the restart.
    await client(server, A2).runSync();
    expect(server.opCount).toBe(2);
    await client(server, B).runSync();
    expect(text(await B.files.read('draft.md'))).toBe('unsynced work\n');
    expect(text(await B.files.read('notes.md'))).toBe('more unsynced\n');
  });

  // ── C2 — crash after apply/clearOps but before saveCursor ────────────────────
  test('C2: a cursor that never advanced re-pulls the same ops and merges to a no-op', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    const id = await A.seedFile('note.md', 'body\n', 1000);
    const hash = A.entry(id)!.contentHash;
    await client(server, A).runSync();

    // B pulls, applies, and advances its cursor to 1.
    await client(server, B).runSync();
    expect(await B.cursor()).toBe(1);
    expect(text(await B.files.read('note.md'))).toBe('body\n');

    // Model the crash: apply happened (file on disk, pending ops cleared) but the
    // saveCursor write never landed, so on restart the cursor is still at its
    // pre-round value. Rewind it to reproduce that persisted state.
    await B.cursorStore.save(0);

    // The recovery re-pulls A's op (seq 1). Because B already holds that content
    // under the same id + ancestor, the merge is a pure no-op — NOT a spurious
    // conflict, NOT a re-write. This is the D1 CRDT-replay property the real
    // crash-before-saveCursor point relies on for safety.
    const appliedBefore = B.applied.length;

    await client(server, B).runSync();

    const replay = B.applied.slice(appliedBefore);
    expect(replay.every(a => a.type === 'no_op')).toBe(true); // no write_local / conflict
    expect(await B.cursor()).toBe(1);                          // cursor re-advances
    expect(text(await B.files.read('note.md'))).toBe('body\n'); // content unchanged
    expect(B.entry(id)!.contentHash).toBe(hash);
    expect(B.pendingOps).toHaveLength(0);
  });

  // ── C1 — crash after push, before the local oplog was cleared ────────────────
  test('C1: a crash after push (oplog not cleared) re-pushes idempotently after restart — no duplicate', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', 'hello\n', 1000);
    expect(A.pendingOps).toHaveLength(1);

    // Inject the crash exactly at clearPendingOps: the append succeeds, then the
    // clear throws, so runSync rejects with the op on the server but still pending
    // locally (and still in oplog.json — the clear never ran).
    const crashHost = new CrashOnFirstClearHost(A.host);
    const crashing = new ServerSyncClient({ api: server, crypto: vc, host: crashHost, hlc: A.hlc });
    await expect(crashing.runSync()).rejects.toThrow('simulated crash after push');
    expect(server.opCount).toBe(1);          // the op DID land
    expect(A.pendingOps).toHaveLength(1);     // but the oplog was NOT cleared

    // ── Restart: the un-cleared op survives and is re-pushed. Append is idempotent
    //    by clientOpId, so the server does NOT gain a duplicate. ──
    const A2 = await A.reload();
    expect(A2.pendingOps).toHaveLength(1);
    await client(server, A2).runSync();
    expect(server.opCount).toBe(1);           // still ONE op, not two
    expect(A2.pendingOps).toHaveLength(0);    // now cleared

    // B sees exactly one file — the crash+restart didn't duplicate it.
    await client(server, B).runSync();
    expect(B.activeEntries()).toHaveLength(1);
    expect(text(await B.files.read('note.md'))).toBe('hello\n');
  });

  // ── C4 — crash after putBlob, before appendOps ───────────────────────────────
  test('C4: a crash between blob upload and op append recovers without a duplicate blob', async () => {
    const inner = new FakeSyncServer();
    const crashOnce = new CrashOnFirstAppendServer(inner);
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', 'payload\n', 1000);

    // First round: pushPendingOps uploads the blob, then the append throws — the
    // blob is on the server, the op is not, and the oplog wasn't cleared.
    const crashing = new ServerSyncClient({ api: crashOnce, crypto: vc, host: A.host, hlc: A.hlc });
    await expect(crashing.runSync()).rejects.toThrow('simulated crash after putBlob');
    expect(inner.blobCount).toBe(1);
    expect(inner.opCount).toBe(0);
    expect(A.pendingOps).toHaveLength(1);

    // ── Restart and retry against a healthy server: blobs:check sees the blob
    //    already present (no re-upload), and the op lands exactly once. ──
    const A2 = await A.reload();
    await new ServerSyncClient({ api: inner, crypto: vc, host: A2.host, hlc: A2.hlc }).runSync();
    expect(inner.blobCount).toBe(1);  // no duplicate blob
    expect(inner.opCount).toBe(1);    // op landed once
    expect(A2.pendingOps).toHaveLength(0);

    await client(inner, B).runSync();
    expect(text(await B.files.read('note.md'))).toBe('payload\n');
  });
});
