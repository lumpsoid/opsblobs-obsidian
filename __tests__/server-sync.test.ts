// ─────────────────────────────────────────────
//  Tests — Server transport client (Phase 3)
//  Full pull→merge→push round against the in-memory fake; cursor advancement;
//  blob dedup; idempotent append; remote-state reconstruction.
//
//  Driven through the REAL device stack: a `TestDevice` wires FileRegistry/
//  ContentStore/OperationLogger/SyncApplicator/PluginVaultSyncHost over in-memory
//  fakes, so the round exercises the genuine client + host, not a look-alike.
// ─────────────────────────────────────────────

import { describe, test, expect, beforeAll } from 'vitest';
import {
  ServerSyncClient,
  ServerApi,
  PullOpsResult,
  AppendOp,
  AppendResult,
  StaleCursorError,
  reconstructRemoteState,
} from '../src/network/server-sync';
import { FakeSyncServer, MissingBlobError } from '../src/network/fake-server';
import { VaultCrypto } from '../src/network/encryption';
import { Operation } from '../src/types';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

/** Wraps a FakeSyncServer so its blob store can be gated off: while
 *  `blobAvailable` is false, `getBlob` returns null (the "blob momentarily
 *  absent at pull" condition F3 guards against). Everything else delegates. */
class BlobGatedServer implements ServerApi {
  blobAvailable = true;
  constructor(private readonly inner: FakeSyncServer) {}
  pullOps(since: number, limit: number): Promise<PullOpsResult> { return this.inner.pullOps(since, limit); }
  appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> { return this.inner.appendOps(baseCursor, ops); }
  checkBlobs(hashes: string[]): Promise<{ missing: string[] }> { return this.inner.checkBlobs(hashes); }
  putBlob(hash: string, bytes: Uint8Array): Promise<void> { return this.inner.putBlob(hash, bytes); }
  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.blobAvailable ? this.inner.getBlob(hash) : null;
  }
}

/** Wraps a FakeSyncServer so its first `appendOps` 409s with a StaleCursorError
 *  (the spec §9.3 optional stale-writer rejection), then delegates on every
 *  later call. Reproduces the wedge F4 guards against: without a catch+retry the
 *  first append throws and the round never clears its pending ops. */
class StaleOnceServer implements ServerApi {
  appendCalls = 0;
  constructor(private readonly inner: FakeSyncServer) {}
  pullOps(since: number, limit: number): Promise<PullOpsResult> { return this.inner.pullOps(since, limit); }
  async appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
    this.appendCalls++;
    if (this.appendCalls === 1) throw new StaleCursorError();
    return this.inner.appendOps(baseCursor, ops);
  }
  checkBlobs(hashes: string[]): Promise<{ missing: string[] }> { return this.inner.checkBlobs(hashes); }
  putBlob(hash: string, bytes: Uint8Array): Promise<void> { return this.inner.putBlob(hash, bytes); }
  getBlob(hash: string): Promise<Uint8Array | null> { return this.inner.getBlob(hash); }
}

function client(api: FakeSyncServer, crypto: VaultCrypto, device: TestDevice): ServerSyncClient {
  // The client shares the device's HLC so `setCurrent(mergedHlc)` + `now()` land
  // on the same clock the host and applicator read.
  return new ServerSyncClient({ api, crypto, host: device.host, hlc: device.hlc });
}

async function device(deviceId: string): Promise<TestDevice> {
  const d = new TestDevice(deviceId);
  await d.init();
  return d;
}

describe('reconstructRemoteState', () => {
  const base = (fileId: string, type: Operation['type'], hash: string, wall: number, counter = 0): Operation => ({
    v: 1, id: `op-${wall}-${counter}`, hlcTimestamp: { wallTime: wall, counter, deviceId: 'dev-x' },
    fileId, type, path: `${fileId}.md`, contentHash: hash, parents: [],
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
    const deviceA = await device('dev-a');
    const deviceB = await device('dev-b');
    const body = '# Groceries\nmilk\n';
    const id = await deviceA.seedFile('groceries.md', body, 1000);
    const hash = deviceA.entry(id)!.contentHash;

    // ── Round on A: push the create ──────────────────────────────────────────
    await client(server, vc, deviceA).runSync();
    expect(server.opCount).toBe(1);
    expect(server.blobCount).toBe(1);
    expect(deviceA.pendingOps).toHaveLength(0);
    expect(await deviceA.cursor()).toBe(0); // nothing pulled; our own op re-pulls next round

    // ── Round on B: pull the create, fetch the blob, write it locally ────────
    await client(server, vc, deviceB).runSync();
    expect(await deviceB.cursor()).toBe(1);
    // B wrote the file locally under A's file id (adoptRemote), converging.
    const entryB = deviceB.entry(id);
    expect(entryB).toBeTruthy();
    expect(entryB!.contentHash).toBe(hash);
    expect(entryB!.deleted).toBe(false);
    const onDisk = await deviceB.files.read('groceries.md');
    expect(onDisk && new TextDecoder().decode(onDisk)).toBe(body);
    const stored = await deviceB.content(hash);
    expect(stored && new TextDecoder().decode(stored)).toBe(body);
  });

  test('re-running a device does not double-append and settles its cursor', async () => {
    const server = new FakeSyncServer();
    const deviceA = await device('dev-a');
    const id = await deviceA.seedFile('a.md', 'hello', 1000);
    const hash = deviceA.entry(id)!.contentHash;

    await client(server, vc, deviceA).runSync(); // pushes op, cursor stays 0
    await client(server, vc, deviceA).runSync(); // re-pulls own op → no-op, cursor → 1

    expect(server.opCount).toBe(1);       // no duplicate append
    expect(await deviceA.cursor()).toBe(1);
    // The re-pulled own op is filtered as ours and merges to a no_op — no write:
    // the file and its registry entry are untouched, and nothing is re-queued.
    expect(deviceA.entry(id)!.contentHash).toBe(hash);
    expect(deviceA.pendingOps).toHaveLength(0);
    const onDisk = await deviceA.files.read('a.md');
    expect(onDisk && new TextDecoder().decode(onDisk)).toBe('hello');
  });

  test('a temporarily-unavailable blob is retried; the cursor never strands the op (F3)', async () => {
    const inner = new FakeSyncServer();
    const gated = new BlobGatedServer(inner);
    const deviceA = await device('dev-a');
    const deviceB = await device('dev-b');
    const body = '# Later\nappears eventually\n';
    const id = await deviceA.seedFile('later.md', body, 1000);
    const hash = deviceA.entry(id)!.contentHash;

    const clientFor = (d: TestDevice) =>
      new ServerSyncClient({ api: gated, crypto: vc, host: d.host, hlc: d.hlc });

    // ── A pushes the create: both the blob and the op land on the server. ──
    await clientFor(deviceA).runSync();
    expect(inner.opCount).toBe(1);
    expect(inner.blobCount).toBe(1);

    // ── B pulls while the blob is unavailable — the op is consumed but its
    //    content can't be fetched, so the file must NOT be applied and the
    //    cursor must NOT advance past that op. ──
    gated.blobAvailable = false;
    await clientFor(deviceB).runSync();
    expect(await deviceB.files.read('later.md')).toBeNull();  // not applied
    expect(deviceB.entry(id)).toBeUndefined();                // no registry entry
    expect(await deviceB.cursor()).toBe(0);                   // cursor stranded → not advanced past seq 1

    // ── The blob becomes available; B syncs again → the op is re-pulled and
    //    the file finally applies. No permanent skip. ──
    gated.blobAvailable = true;
    await clientFor(deviceB).runSync();
    expect(await deviceB.cursor()).toBe(1);
    const onDisk = await deviceB.files.read('later.md');
    expect(onDisk && new TextDecoder().decode(onDisk)).toBe(body);
    expect(deviceB.entry(id)!.contentHash).toBe(hash);
    expect(deviceB.entry(id)!.deleted).toBe(false);
  });

  test('a stale-cursor 409 on append is recovered, not wedged (F4)', async () => {
    const inner = new FakeSyncServer();
    const staleOnce = new StaleOnceServer(inner);
    const deviceA = await device('dev-a');
    const deviceB = await device('dev-b');

    // A publishes a file the normal way so the server head is ahead of B's cursor.
    const bodyA = '# A\nfrom a\n';
    const idA = await deviceA.seedFile('a.md', bodyA, 1000);
    await client(inner, vc, deviceA).runSync();
    expect(inner.opCount).toBe(1);

    // B has its own pending edit and a stale cursor (0). Its round pulls A's op,
    // then pushes — where the server 409s the first append (stale baseCursor).
    // Pre-fix, that StaleCursorError escapes runSync and the round throws.
    const bodyB = '# B\nfrom b\n';
    const idB = await deviceB.seedFile('b.md', bodyB, 2000);
    const clientB = new ServerSyncClient({ api: staleOnce, crypto: vc, host: deviceB.host, hlc: deviceB.hlc });

    await expect(clientB.runSync()).resolves.toBeDefined(); // completes, no throw escapes

    // The append was retried after refreshing the cursor: two calls, one 409'd.
    expect(staleOnce.appendCalls).toBe(2);
    // B's op landed on the server (idempotent by clientOpId), pending cleared.
    expect(inner.opCount).toBe(2);
    expect(deviceB.pendingOps).toHaveLength(0);
    // B's own file survives and A's file was merged onto B.
    const bOnDisk = await deviceB.files.read('b.md');
    expect(bOnDisk && new TextDecoder().decode(bOnDisk)).toBe(bodyB);
    const aOnDisk = await deviceB.files.read('a.md');
    expect(aOnDisk && new TextDecoder().decode(aOnDisk)).toBe(bodyA);
    expect(deviceB.entry(idA)).toBeTruthy();
    expect(deviceB.entry(idB)).toBeTruthy();
  });

  test('blobs are deduplicated across devices via blobs:check', async () => {
    const server = new FakeSyncServer();
    const deviceA = await device('dev-a');
    const deviceB = await device('dev-b');
    // Identical content on both devices, different files (and thus file ids).
    await deviceA.seedFile('a.md', 'shared body', 1000);
    await deviceB.seedFile('b.md', 'shared body', 1000);

    await client(server, vc, deviceA).runSync();
    await client(server, vc, deviceB).runSync();

    expect(server.opCount).toBe(2);   // two ops
    expect(server.blobCount).toBe(1); // but one shared blob (dedup held)
  });

  test('runSync returns a summary of what the round did (S2)', async () => {
    const server = new FakeSyncServer();
    const deviceA = await device('dev-a');
    const deviceB = await device('dev-b');
    await deviceA.seedFile('one.md', 'first\n', 1000);
    await deviceA.seedFile('two.md', 'second\n', 1000);

    // A's round pushes its 2 ops and pulls nothing new.
    const aSummary = await client(server, vc, deviceA).runSync();
    expect(aSummary.pushed).toBe(2);
    expect(aSummary.pulled).toBe(0);
    expect(aSummary.deferred).toEqual([]);
    expect(aSummary.stranded).toEqual([]);

    // B's round pushes nothing and pulls A's 2 ops.
    const bSummary = await client(server, vc, deviceB).runSync();
    expect(bSummary.pushed).toBe(0);
    expect(bSummary.pulled).toBe(2);
  });

  test('runSync reports stranded content when a blob is unavailable (F3 → S2)', async () => {
    const inner = new FakeSyncServer();
    const gated = new BlobGatedServer(inner);
    const deviceA = await device('dev-a');
    const deviceB = await device('dev-b');
    const id = await deviceA.seedFile('later.md', 'appears\n', 1000);
    const hash = deviceA.entry(id)!.contentHash;

    const clientFor = (d: TestDevice) =>
      new ServerSyncClient({ api: gated, crypto: vc, host: d.host, hlc: d.hlc });

    await clientFor(deviceA).runSync();

    gated.blobAvailable = false;
    const summary = await clientFor(deviceB).runSync();
    // The op was pulled but its content couldn't be fetched — reported as stranded.
    expect(summary.pulled).toBe(1);
    expect(summary.stranded).toContain(hash);
  });
});
