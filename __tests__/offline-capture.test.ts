// ─────────────────────────────────────────────
//  Cold-start capture & pre-sync pruning (H10, G11)
// ─────────────────────────────────────────────
//
//  Two edges of "getting local reality into the oplog" that don't go through a
//  live vault event:
//   · H10 — a vault that already had files before the plugin's listeners
//           attached. No `create` event ever fires for them, so without an
//           explicit offline scan their content would never become an op and
//           never reach the server. `captureOfflineChanges` is that scan.
//   · G11 — a file created and deleted before any sync. The remote never knew it
//           existed, so nothing about it should reach a peer.
//
//  Driven through the REAL device stack (TestDevice over in-memory fakes), so the
//  genuine OperationLogger / registry / round are exercised, not a look-alike.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { FakeSyncServer } from '../src/network/fake-server';
import { VaultCrypto } from '../src/network/encryption';
import { TestDevice } from './helpers/test-device';
import { uint8ToBase64 } from '../src/core/content-store';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

let vc: VaultCrypto;
beforeAll(async () => {
  vc = new VaultCrypto();
  await vc.deriveFromPassphrase('correct horse battery staple', SALT);
});

const client = (api: FakeSyncServer, device: TestDevice): ServerSyncClient =>
  new ServerSyncClient({ api, crypto: vc, host: device.host, hlc: device.hlc });

const read = async (d: TestDevice, path: string): Promise<string | null> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : null;
};

describe('first-enable on a pre-existing vault (H10)', () => {
  test('captureOfflineChanges emits a create per pre-existing file and they reach a peer', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    // Files that were already in the vault before listeners attached — no create
    // event fires for them, and they are NOT yet in the registry.
    await A.seedExistingFile('welcome.md', '# Welcome\n');
    await A.seedExistingFile('notes/todo.md', '- [ ] sync\n');
    await A.seedExistingFile('deep/nested/log.md', 'entry one\n');
    expect(A.pendingOps).toHaveLength(0);            // nothing captured yet
    expect(A.entryByPath('welcome.md')).toBeUndefined();

    // The cold-start scan turns each on-disk file into a create op + registry entry.
    await A.opLogger.captureOfflineChanges();

    const created = A.pendingOps.filter(op => op.type === 'create').map(op => op.path).sort();
    expect(created).toEqual(['deep/nested/log.md', 'notes/todo.md', 'welcome.md']);
    expect(A.pendingOps).toHaveLength(3);            // exactly one op per file, nothing else
    // The registry now tracks each with its REAL content hash (not the '' placeholder).
    for (const path of ['welcome.md', 'notes/todo.md', 'deep/nested/log.md']) {
      const entry = A.entryByPath(path);
      expect(entry).toBeDefined();
      expect(entry!.contentHash).not.toBe('');
      expect(entry!.deleted).toBe(false);
    }

    // ── Push, then a fresh device pulls and materialises all three with content. ──
    await client(server, A).runSync();
    expect(A.pendingOps).toHaveLength(0);

    const B = await TestDevice.create('dev-b');
    await client(server, B).runSync();
    expect(await read(B, 'welcome.md')).toBe('# Welcome\n');
    expect(await read(B, 'notes/todo.md')).toBe('- [ ] sync\n');
    expect(await read(B, 'deep/nested/log.md')).toBe('entry one\n');
    expect(B.activeEntries()).toHaveLength(3);
  });

  test('captureOfflineChanges returns per-phase stats (files/ops counts, non-negative phase totals)', async () => {
    const A = await TestDevice.create('dev-a');
    const N = 5;
    for (let i = 0; i < N; i++) {
      await A.seedExistingFile(`note-${i}.md`, `body ${i}\n`);
    }

    const stats = await A.opLogger.captureOfflineChanges();

    // One file scanned + one create op emitted per seeded file.
    expect(stats.files).toBe(N);
    expect(stats.opsEmitted).toBe(N);
    // Every phase total is a non-negative accumulation, and the residual (otherMs)
    // is non-negative too — the three phases can't sum past the wall total.
    expect(stats.readMs).toBeGreaterThanOrEqual(0);
    expect(stats.hashMs).toBeGreaterThanOrEqual(0);
    expect(stats.putMs).toBeGreaterThanOrEqual(0);
    expect(stats.totalMs).toBeGreaterThanOrEqual(0);
    expect(stats.totalMs).toBeGreaterThanOrEqual(stats.readMs + stats.hashMs + stats.putMs);

    // A second no-change scan scans the same files but emits no ops (O1 gate).
    const again = await A.opLogger.captureOfflineChanges();
    expect(again.files).toBe(N);
    expect(again.opsEmitted).toBe(0);
  });

  test('captureOfflineChanges is idempotent — a second scan with no change emits nothing', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('a.md', 'body\n');
    await A.seedExistingFile('b.md', 'body\n');

    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(2);

    // Nothing on disk changed → the second scan must not re-emit or duplicate.
    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(2);
    expect(A.pendingOps.filter(op => op.path === 'a.md')).toHaveLength(1);
    expect(A.pendingOps.filter(op => op.path === 'b.md')).toHaveLength(1);
  });
});

describe('C2 — first-enable bulk write skips the redundant `exists` probe', () => {
  // The first-enable capture uses the `putBuffered` bulk path: no per-file blob `exists`
  // round-trip, blobs buffered and appended in packs, and duplicate-content files still
  // write each distinct hash once (memCache dedup). See
  // docs/startup-capture-optimization-spec.md §4.2 / §6.

  test('capture writes via putBuffered (no per-file blob exists probe) and dedups duplicate content', async () => {
    const A = await TestDevice.create('dev-a');

    // Four files, two distinct contents — two duplicate pairs.
    await A.seedExistingFile('a1.md', 'alpha\n');
    await A.seedExistingFile('a2.md', 'alpha\n'); // dup of a1
    await A.seedExistingFile('b1.md', 'beta\n');
    await A.seedExistingFile('b2.md', 'beta\n');  // dup of b1

    // Arm the encode sub-phase accumulator (A3 §3.2 diagnostics) — the capture must
    // populate it through the real putBuffered path without disturbing the write.
    const putPerf = { encodeMs: 0 };
    A.contentStore.capturePutPerf = putPerf;

    // The capture must take the buffered bulk path, never the flush-per-blob `put`.
    let putCalls = 0;
    let putBufferedCalls = 0;
    const origPut = A.contentStore.put.bind(A.contentStore);
    const origPutBuffered = A.contentStore.putBuffered.bind(A.contentStore);
    A.contentStore.put = async (h, c) => { putCalls++; return origPut(h, c); };
    A.contentStore.putBuffered = async (h, c) => { putBufferedCalls++; return origPutBuffered(h, c); };

    // The C2-removed cost: an `exists` probe on a content blob (`*.bin`) path. The
    // shard-dir `exists` (a directory path) is a separate, session-amortised cost and
    // is not counted here.
    let blobExists = 0;
    let blobDirectWrites = 0;
    let blobAtomicWrites = 0;
    // A3 pack-writes: capture buffers blobs and appends them in packs at checkpoints, so
    // the write phase is pack + index appends, NOT per-blob `.bin` writes. Count both.
    let packAppends = 0;
    let indexAppends = 0;
    const origExists = A.metadata.exists.bind(A.metadata);
    const origWrite = A.metadata.write.bind(A.metadata);
    const origWriteDirect = A.metadata.writeDirect.bind(A.metadata);
    const origAppend = A.metadata.append.bind(A.metadata);
    A.metadata.exists = async p => { if (p.endsWith('.bin')) blobExists++; return origExists(p); };
    A.metadata.write = async (p, d) => { if (p.endsWith('.bin')) blobAtomicWrites++; return origWrite(p, d); };
    A.metadata.writeDirect = async (p, d) => { if (p.endsWith('.bin')) blobDirectWrites++; return origWriteDirect(p, d); };
    A.metadata.append = async (p, d) => {
      if (p.endsWith('.pack')) packAppends++;
      if (p.endsWith('/pack/index')) indexAppends++;
      return origAppend(p, d);
    };

    await A.opLogger.captureOfflineChanges();

    // Bulk path taken for every scanned file; the exists-guarded `put` never called.
    expect(putCalls).toBe(0);
    expect(putBufferedCalls).toBe(4);
    // No per-file blob exists probe at all — the whole point of C2.
    expect(blobExists).toBe(0);
    // A3 pack-writes: NO per-blob `.bin` write of either kind. All four files (two
    // distinct hashes) are buffered by putBuffered and flushed into ONE pack at the final
    // checkpoint (4 < CAPTURE_CHECKPOINT_EVERY), with one index-delta append alongside.
    // This is the whole point: ~F blob writes → ~2 appends per 200-blob chunk.
    expect(blobDirectWrites).toBe(0);
    expect(blobAtomicWrites).toBe(0);
    expect(packAppends).toBe(1);
    expect(indexAppends).toBe(1);
    // The encode accumulator was threaded through the two real writes (a finite,
    // non-negative CPU total — the wiring works; exact ms is a device concern).
    expect(Number.isFinite(putPerf.encodeMs)).toBe(true);
    expect(putPerf.encodeMs).toBeGreaterThanOrEqual(0);

    // Restore spies before reading content back through the store.
    A.metadata.exists = origExists;
    A.metadata.append = origAppend;

    // Each file's blob is readable back by its registry hash — content intact. The
    // capture left the final window warm in memCache AND flushed to a pack; drop the
    // cache so the read-back exercises the pack extract + hash-verify path (spec §3.3).
    A.contentStore.clearMemCache();
    for (const [path, text] of [['a1.md', 'alpha\n'], ['b1.md', 'beta\n']] as const) {
      const hash = A.entryByPath(path)!.contentHash;
      const bytes = await A.content(hash);
      expect(bytes).not.toBeNull();
      expect(new TextDecoder().decode(bytes!)).toBe(text);
    }
    // Duplicate pairs share the one blob (same hash).
    expect(A.entryByPath('a1.md')!.contentHash).toBe(A.entryByPath('a2.md')!.contentHash);
    expect(A.entryByPath('b1.md')!.contentHash).toBe(A.entryByPath('b2.md')!.contentHash);
  });

  test('a capture spanning multiple checkpoints writes ~ceil(F/200) packs, no per-blob writes', async () => {
    const A = await TestDevice.create('dev-a');
    // 450 distinct files → checkpoints fire at 200 and 400, plus the final tail (50):
    // three flushPack calls → three packs. The whole point of pack-writes at scale.
    const N = 450;
    for (let i = 0; i < N; i++) await A.seedExistingFile(`n${i}.md`, `content-${i}\n`);

    let packAppends = 0;
    let indexAppends = 0;
    let blobWrites = 0;
    const origAppend = A.metadata.append.bind(A.metadata);
    const origWriteDirect = A.metadata.writeDirect.bind(A.metadata);
    A.metadata.append = async (p, d) => {
      if (p.endsWith('.pack')) packAppends++;
      if (p.endsWith('/pack/index')) indexAppends++;
      return origAppend(p, d);
    };
    A.metadata.writeDirect = async (p, d) => { if (p.endsWith('.bin')) blobWrites++; return origWriteDirect(p, d); };

    const stats = await A.opLogger.captureOfflineChanges();

    expect(stats.opsEmitted).toBe(N);
    expect(packAppends).toBe(Math.ceil(N / 200)); // 3
    expect(indexAppends).toBe(Math.ceil(N / 200));
    expect(blobWrites).toBe(0);                    // ~0 per-blob writes — the win
    expect(stats.flushMs).toBeGreaterThanOrEqual(0);

    A.metadata.append = origAppend;
    A.metadata.writeDirect = origWriteDirect;

    // A mid-capture (checkpoint-evicted) file still round-trips through its pack, and a
    // fresh reload rebuilds the index so every blob resolves after a restart.
    const reloaded = await A.reload();
    for (const i of [0, 199, 200, 449]) {
      const hash = reloaded.entryByPath(`n${i}.md`)!.contentHash;
      const bytes = await reloaded.content(hash);
      expect(new TextDecoder().decode(bytes!)).toBe(`content-${i}\n`);
    }
  });
});

describe('C4 — non-atomic pack append is made safe by hash-verify-on-read', () => {
  // A pack append is non-atomic, so a crash can leave a torn blob in the pack. The safety
  // net: `ContentStore.get` hashes the bytes it extracts and, on a mismatch, reports the
  // blob MISSING — so the merge degrades to a conflict (F1) instead of three-way-merging
  // against corrupt content. docs/unify-on-packs-spec.md §3.

  const PACK0 = '.vault-sync/content/pack/0.pack';

  test('a blob whose packed bytes no longer hash to its name reads back as null', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('note.md', 'real content\n');
    await A.opLogger.captureOfflineChanges();
    const hash = A.entryByPath('note.md')!.contentHash;

    // Intact blob round-trips from the pack (memCache dropped first so the read hits disk).
    A.contentStore.clearMemCache();
    const good = await A.content(hash);
    expect(good).not.toBeNull();
    expect(new TextDecoder().decode(good!)).toBe('real content\n');

    // Corrupt the blob's payload in the pack (simulate a torn append) WITHOUT changing its
    // length, so the index offset/len still align and the read reaches — and fails — the
    // hash-verify (not the earlier length-mismatch skip). 'real content\n' and 'tampered
    // byte' are both 13 bytes ⇒ identical base64 length.
    const good64 = uint8ToBase64(new TextEncoder().encode('real content\n'));
    const bad64 = uint8ToBase64(new TextEncoder().encode('tampered byte'));
    const pack = (await A.metadata.read(PACK0))!;
    A.metadata.set(PACK0, pack.replace(good64, bad64));
    A.contentStore.clearMemCache();

    // get() must catch the mismatch and report the base as missing, not hand back
    // corrupt bytes that would silently poison a three-way merge.
    expect(await A.content(hash)).toBeNull();
  });

  test('a genuinely absent blob still reads as null (unchanged)', async () => {
    const A = await TestDevice.create('dev-a');
    expect(await A.content('0'.repeat(64))).toBeNull();
  });
});

describe('cold-start listing race — phantom-delete guard', () => {
  // Obsidian's `app.vault.getFiles()` is not reliably populated during `onload`;
  // on an unlucky cold start it returns empty even though the files are on disk.
  // If `captureOfflineChanges` trusted that empty listing it would mark EVERY
  // tracked file "vanished while offline" and emit a delete op for the whole
  // vault — which then propagates to peers as data loss / delete conflicts. The
  // guard: an empty listing while the registry still holds active entries is
  // treated as not-yet-ready, and the delete pass is skipped. (Found in the wild:
  // a two-vault test showed one device's registry tombstoning a present file and
  // the peer surfacing a bogus "file is deleted" conflict.)

  test('an empty vault listing (index not ready) never tombstones tracked files', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const id = await A.seedFile('my.md', '1\n2\n3\n', 1000);
    await client(server, A).runSync();            // durably synced + tracked
    expect(A.pendingOps).toHaveLength(0);
    expect(A.entryByPath('my.md')!.deleted).toBe(false);

    // Cold start: the file is still on disk (readable) but `getFiles()` has not
    // been populated, so the listing comes back empty — the exact race.
    A.files.setListingReady(false);
    await A.opLogger.captureOfflineChanges();

    // The guard must refuse: no delete op, entry stays live, no phantom to push.
    expect(A.pendingOps.filter(op => op.type === 'delete')).toEqual([]);
    expect(A.pendingOps).toHaveLength(0);
    expect(A.entry(id)!.deleted).toBe(false);

    // Once the listing is ready again, a no-change capture stays clean.
    A.files.setListingReady(true);
    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(0);
    expect(A.entry(id)!.deleted).toBe(false);
  });

  test('the phantom delete never reaches a peer (no delete/modify conflict on the other device)', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    await A.seedFile('my.md', 'hello\n', 1000);
    await client(server, A).runSync();

    const B = await TestDevice.create('dev-b');
    await client(server, B).runSync();
    expect(await read(B, 'my.md')).toBe('hello\n');

    // A restarts into the cold-start race, captures, then the listing recovers and
    // A syncs. No tombstone must have been queued while the listing was empty.
    A.files.setListingReady(false);
    await A.opLogger.captureOfflineChanges();
    A.files.setListingReady(true);
    await client(server, A).runSync();

    // B syncs again: it must NOT see a delete for my.md (nothing was pushed).
    await client(server, B).runSync();
    expect(await read(B, 'my.md')).toBe('hello\n');
    expect(B.entryByPath('my.md')!.deleted).toBe(false);
    expect(B.applied.some(a => a.type === 'delete_local' || a.type === 'delete_conflict')).toBe(false);
  });

  test('a genuine offline delete is still detected once the listing is ready', async () => {
    const A = await TestDevice.create('dev-a');
    const keepId = await A.seedFile('keep.md', 'a\n', 1000);
    const goneId = await A.seedFile('gone.md', 'b\n', 1100);

    // A real offline removal: the file is gone from disk AND the listing reflects
    // it (non-empty — keep.md is still there), so the guard does NOT trip.
    await A.files.trash('gone.md');
    await A.opLogger.captureOfflineChanges();

    expect(A.pendingOps.some(op => op.type === 'delete' && op.fileId === goneId)).toBe(true);
    expect(A.entry(goneId)!.deleted).toBe(true);
    expect(A.entry(keepId)!.deleted).toBe(false);
  });
});

describe('create-then-delete before any sync (G11)', () => {
  test('a peer never materialises a file that was created and deleted before its first sync', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    // A durable file so A has *something* to sync (keeps the round non-trivial).
    await A.seedFile('keep.md', 'keep me\n', 1000);

    // The transient file: created then deleted, both before any sync ever ran.
    const tmpId = await A.seedFile('tmp.md', 'ephemeral\n', 1100);
    await A.deleteFile('tmp.md', 1200);

    // ── A and a fresh B both sync. ──
    await client(server, A).runSync();
    const B = await TestDevice.create('dev-b');
    await client(server, B).runSync();

    // The user-facing guarantee: B has the durable file and NEVER the transient one.
    expect(await read(B, 'keep.md')).toBe('keep me\n');
    expect(await read(B, 'tmp.md')).toBeNull();
    const bTmp = B.entryByPath('tmp.md');
    expect(bTmp === undefined || bTmp.deleted).toBe(true); // absent, or at worst a tombstone
    // B never adopts the transient id as a live file.
    const bById = B.entry(tmpId);
    expect(bById === undefined || bById.deleted).toBe(true);
    expect(B.activeEntries().map(e => e.path)).toEqual(['keep.md']);
  });

  // A file created and deleted before any sync fully cancels: `handleDelete` sees
  // that `pruneCreateDeletePair` removed an un-synced create and emits NO delete op,
  // so nothing tmp-shaped is ever pushed — not even a tombstone referencing a
  // contentHash whose blob was never uploaded (which would be a phantom / audit-G
  // leak). The registry tombstone still stands locally.
  test('the create/delete pair fully cancels — no op for the transient file is ever pushed', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    await A.seedFile('keep.md', 'keep me\n', 1000);

    const tmpId = await A.seedFile('tmp.md', 'ephemeral\n', 1100);
    // Before the delete: a create op for tmp is queued.
    expect(A.pendingOps.some(op => op.fileId === tmpId)).toBe(true);

    await A.deleteFile('tmp.md', 1200);

    // The create/delete pair cancels out (pruneCreateDeletePair): the remote never
    // knew tmp existed, so NO op for it should survive to be pushed — not even a
    // delete that references content no peer holds.
    expect(A.pendingOps.filter(op => op.fileId === tmpId)).toEqual([]);

    // And nothing tmp-shaped lands on the server: only keep.md's create is durable.
    await client(server, A).runSync();
    const C = await TestDevice.create('dev-c');
    await client(server, C).runSync();
    expect(C.activeEntries().map(e => e.path)).toEqual(['keep.md']);
    expect(await read(C, 'tmp.md')).toBeNull();
  });
});
