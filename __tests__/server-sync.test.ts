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
  BlobUpload,
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
  putBlobBatch(blobs: BlobUpload[]): Promise<void> { return this.inner.putBlobBatch(blobs); }
  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.blobAvailable ? this.inner.getBlob(hash) : null;
  }
  async getBlobBatch(hashes: string[]): Promise<{ blobs: Map<string, Uint8Array>; missing: string[] }> {
    // Gated off → every hash reads as absent (the batch analogue of getBlob → null).
    return this.blobAvailable ? this.inner.getBlobBatch(hashes) : { blobs: new Map(), missing: [...hashes] };
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
  putBlobBatch(blobs: BlobUpload[]): Promise<void> { return this.inner.putBlobBatch(blobs); }
  getBlob(hash: string): Promise<Uint8Array | null> { return this.inner.getBlob(hash); }
  getBlobBatch(hashes: string[]): Promise<{ blobs: Map<string, Uint8Array>; missing: string[] }> { return this.inner.getBlobBatch(hashes); }
}

/** Wraps a FakeSyncServer recording the op-count of every `appendOps` call, so a
 *  test can assert a backlog larger than the per-POST cap was split into batches
 *  (spec §9.6 — a single oversized POST would 413/`ErrBatchTooLarge`). The fake
 *  itself enforces no cap; this just observes the shape the client sent. */
class BatchRecordingServer implements ServerApi {
  batchSizes: number[] = [];
  constructor(private readonly inner: FakeSyncServer) {}
  pullOps(since: number, limit: number): Promise<PullOpsResult> { return this.inner.pullOps(since, limit); }
  appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
    this.batchSizes.push(ops.length);
    return this.inner.appendOps(baseCursor, ops);
  }
  checkBlobs(hashes: string[]): Promise<{ missing: string[] }> { return this.inner.checkBlobs(hashes); }
  putBlob(hash: string, bytes: Uint8Array): Promise<void> { return this.inner.putBlob(hash, bytes); }
  putBlobBatch(blobs: BlobUpload[]): Promise<void> { return this.inner.putBlobBatch(blobs); }
  getBlob(hash: string): Promise<Uint8Array | null> { return this.inner.getBlob(hash); }
  getBlobBatch(hashes: string[]): Promise<{ blobs: Map<string, Uint8Array>; missing: string[] }> { return this.inner.getBlobBatch(hashes); }
}

/** Wraps a FakeSyncServer recording the peak number of blob-upload *requests* in
 *  flight at once — counting a `putBlobBatch` (the primary path) and a `putBlob`
 *  (large-blob / key-check path) each as one in-flight request — so a test can
 *  assert the upload pool never exceeds its concurrency cap (and actually overlaps
 *  up to it). A `setTimeout(0)` inside each holds the started request open past the
 *  microtask drain, so the peak reflects real overlap. */
class ConcurrencyProbeServer implements ServerApi {
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly inner: FakeSyncServer) {}
  pullOps(since: number, limit: number): Promise<PullOpsResult> { return this.inner.pullOps(since, limit); }
  appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> { return this.inner.appendOps(baseCursor, ops); }
  checkBlobs(hashes: string[]): Promise<{ missing: string[] }> { return this.inner.checkBlobs(hashes); }
  getBlob(hash: string): Promise<Uint8Array | null> { return this.inner.getBlob(hash); }
  getBlobBatch(hashes: string[]): Promise<{ blobs: Map<string, Uint8Array>; missing: string[] }> { return this.inner.getBlobBatch(hashes); }
  private async track<T>(run: () => Promise<T>): Promise<T> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise(r => setTimeout(r, 0)); // hold the slot open so overlap is observable
    try {
      return await run();
    } finally {
      this.inFlight--;
    }
  }
  putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    return this.track(() => this.inner.putBlob(hash, bytes));
  }
  putBlobBatch(blobs: BlobUpload[]): Promise<void> {
    return this.track(() => this.inner.putBlobBatch(blobs));
  }
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

  test('a renamed (moved) file projects its head as the content version it renamed, not the move op', () => {
    // The move is the latest op, but it is not a new content version — so the
    // projected head must be the content version it renamed (its parent), keeping
    // the renamed file connected in the op-id DAG for LCA / fast-forward. Using the
    // move op's own id would strand it as a parentless root.
    const createOp: Operation = {
      v: 1, id: 'v-create', hlcTimestamp: { wallTime: 100, counter: 0, deviceId: 'dev-x' },
      fileId: 'f1', type: 'create', path: 'a.md', contentHash: 'h1', parents: [],
    };
    const moveOp: Operation = {
      v: 1, id: 'op-move', hlcTimestamp: { wallTime: 200, counter: 0, deviceId: 'dev-x' },
      fileId: 'f1', type: 'move', path: 'b.md', contentHash: 'h1', parents: ['v-create'],
    };
    const state = reconstructRemoteState([createOp, moveOp]);
    const entry = state.fileEntries.get('f1')!;
    expect(entry.path).toBe('b.md');               // the new path
    expect(entry.contentHash).toBe('h1');          // content unchanged
    expect(entry.headVersionId).toBe('v-create');  // head = the content version, NOT 'op-move'
    expect(entry.deleted).toBe(false);
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
    expect(server.blobCount).toBe(2); // the file's content blob + the vault key-check record
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

  test('a first pull of F files buffers every blob and flushes the content store ONCE (apply-path-pack-writes §2.2)', async () => {
    const server = new FakeSyncServer();
    const deviceA = await device('dev-a');
    const deviceB = await device('dev-b');

    // A seeds F distinct files across two dirs, then pushes them all.
    const F = 40;
    const bodies = new Map<string, string>();
    for (let i = 0; i < F; i++) {
      const path = `${i % 2 === 0 ? 'a' : 'b'}/note-${i}.md`;
      const body = `# note ${i}\nunique-line-${i}\n`;
      bodies.set(path, body);
      await deviceA.seedFile(path, body, 1000 + i);
    }
    await client(server, vc, deviceA).runSync();
    expect(server.opCount).toBe(F);

    // Count only the content-store's pack-dir appends B issues during its pull —
    // isolating blob writes from the registry/oplog/DAG appends that share the
    // same fake. The per-blob `put` did 2 appends (a 1-blob pack + its index line)
    // PER FILE → 2F; buffering + a bounded pack checkpoint (PackCheckpoint) collapses
    // that to 2 appends per flush, at most ceil(F/N) flushes — here one, since F < N.
    const PACK_DIR = '.vault-sync/content/pack/';
    let packAppends = 0;
    const origAppend = deviceB.metadata.append.bind(deviceB.metadata);
    deviceB.metadata.append = async (p: string, d: string) => {
      if (p.startsWith(PACK_DIR)) packAppends++;
      return origAppend(p, d);
    };

    await client(server, vc, deviceB).runSync();

    // The point: content-store appends do NOT scale with F. One flush = one pack
    // body append + one index append.
    expect(packAppends).toBe(2);
    expect(packAppends).toBeLessThan(2 * F);
    // And no loose per-blob write ever happened (the format is pack-only, C4).
    expect(deviceB.metadata.io.writesDirect).toBe(0);

    // Every pulled file round-trips: on-disk bytes and the content store (read
    // back by the registry hash, C4-verified) both match what A pushed.
    expect(await deviceB.cursor()).toBe(F);
    for (const [path, body] of bodies) {
      const onDisk = await deviceB.files.read(path);
      expect(onDisk && new TextDecoder().decode(onDisk)).toBe(body);
      const hash = deviceB.entry(deviceB.entryByPath(path)!.id)!.contentHash;
      const stored = await deviceB.content(hash);
      expect(stored && new TextDecoder().decode(stored)).toBe(body);
    }
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

  test('a backlog larger than maxOpsPerAppend is split into per-POST batches (§9.6, no 413)', async () => {
    const inner = new FakeSyncServer();
    const rec = new BatchRecordingServer(inner);
    const deviceA = await device('dev-a');
    // Five pending create ops with a batch cap of 2 → appends of 2, 2, 1 — none
    // over the cap that would otherwise 413 as one oversized POST.
    for (let i = 0; i < 5; i++) await deviceA.seedFile(`n${i}.md`, `body ${i}`, 1000 + i);
    expect(deviceA.pendingOps).toHaveLength(5);

    const clientA = new ServerSyncClient({
      api: rec, crypto: vc, host: deviceA.host, hlc: deviceA.hlc, maxOpsPerAppend: 2,
    });
    await clientA.runSync();

    expect(rec.batchSizes).toEqual([2, 2, 1]); // chunked; every batch within the cap
    expect(inner.opCount).toBe(5);             // all ops landed, each exactly once
    expect(deviceA.pendingOps).toHaveLength(0); // cleared only after the whole push
  });

  test('a baseline uploads blobs concurrently up to the cap, and every blob still lands before its op', async () => {
    const inner = new FakeSyncServer();
    const probe = new ConcurrencyProbeServer(inner);
    const deviceA = await device('dev-a');
    // Ten distinct files → ten distinct content blobs to upload on the first sync.
    for (let i = 0; i < 10; i++) await deviceA.seedFile(`n${i}.md`, `body ${i}`, 1000 + i);

    const clientA = new ServerSyncClient({
      // Pack ≤2 blobs per batch so the 10 blobs form 5 batch requests — enough to
      // overlap and exercise the pool. (With the default cap of 256 they'd be one
      // request, and concurrency wouldn't be observable.)
      api: probe, crypto: vc, host: deviceA.host, hlc: deviceA.hlc,
      blobUploadConcurrency: 3, blobBatchMaxCount: 2,
    });
    await clientA.runSync();

    // Overlapped up to — but never beyond — the cap. (5 batch requests, cap 3 → peak is 3.)
    expect(probe.maxInFlight).toBe(3);
    expect(probe.maxInFlight).toBeLessThanOrEqual(3);
    // The pool awaits every upload before the append, so all blobs are present when the
    // ops land — the fake 422s (MissingBlobError) if any op referenced an un-uploaded blob.
    expect(inner.opCount).toBe(10);
    expect(inner.blobCount).toBe(11); // 10 content blobs + the vault key-check record
    expect(deviceA.pendingOps).toHaveLength(0);

    // A second device converges: every blob is fetchable, so all ten files replay.
    const deviceB = await device('dev-b');
    await client(inner, vc, deviceB).runSync();
    for (let i = 0; i < 10; i++) {
      const onDisk = await deviceB.files.read(`n${i}.md`);
      expect(onDisk && new TextDecoder().decode(onDisk)).toBe(`body ${i}`);
    }
  });

  test('onUploadProgress reports cumulative blob-upload counts, ending exactly at total', async () => {
    // The status modal draws a determinate progress bar from these counts; the settings
    // "Sync now" button and status bar show the twin string. Assert the wire: the counts
    // rise monotonically and finish at the total (so the bar can reach 100%).
    const inner = new FakeSyncServer();
    const deviceA = await device('dev-a');
    for (let i = 0; i < 10; i++) await deviceA.seedFile(`n${i}.md`, `body ${i}`, 1000 + i);

    const ticks: Array<{ uploaded: number; total: number }> = [];
    await new ServerSyncClient({
      api: inner, crypto: vc, host: deviceA.host, hlc: deviceA.hlc,
      // >1 wave (the report guard) and multiple batches so `uploaded` climbs in steps.
      blobUploadConcurrency: 3, blobBatchMaxCount: 2,
      onUploadProgress: (uploaded, total) => ticks.push({ uploaded, total }),
    }).runSync();

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every(t => t.total === 10)).toBe(true);           // stable denominator
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.uploaded).toBeGreaterThanOrEqual(ticks[i - 1]!.uploaded); // monotonic
    }
    expect(ticks[ticks.length - 1]!.uploaded).toBe(10);            // reaches 100%
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
    expect(inner.blobCount).toBe(2); // the file's content blob + the vault key-check record

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
    expect(server.blobCount).toBe(2); // one shared content blob (dedup held) + the vault key-check record
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
