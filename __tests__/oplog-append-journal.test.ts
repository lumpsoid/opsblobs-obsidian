// ─────────────────────────────────────────────
//  Oplog append-journal (spec: docs/oplog-append-journal-spec.md §4/§6)
// ─────────────────────────────────────────────
//
//  The oplog is a line-oriented NDJSON journal: the capture hot path and live
//  single-op record APPEND only the delta ops since the last persist (O(delta)),
//  replacing the former whole-array rewrite whose bytes-per-checkpoint grew with
//  the pending set (O(N²) over a capture). The two rare shrink events (clearOps,
//  create/delete-pair prune) fall back to a full rewrite (compaction). These tests
//  drive the REAL OperationLogger over the in-memory fakes.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

const OPLOG = '.vault-sync/oplog.json';

/** Wrap a device's `metadata.append` so a test sees the byte-size of each write to
 *  the oplog journal (the O(delta) regression guard needs per-append sizes). */
const trackOplogAppends = (dev: TestDevice): number[] => {
  const sizes: number[] = [];
  const orig = dev.metadata.append.bind(dev.metadata);
  dev.metadata.append = async (p: string, d: string) => {
    if (p === OPLOG) sizes.push(d.length);
    return orig(p, d);
  };
  return sizes;
};

const seedN = async (dev: TestDevice, n: number, prefix = 'n') => {
  for (let i = 0; i < n; i++) await dev.seedExistingFile(`notes/${prefix}-${i}.md`, `body ${i}\n`);
};

const shape = (dev: TestDevice) => dev.pendingOps.map(op => ({ type: op.type, path: op.path, id: op.id }));

describe('oplog append-journal — round-trip & durability (§6)', () => {
  test('append across multiple checkpoints round-trips through a reload, order preserved', async () => {
    const seed = await TestDevice.create('rt');
    await seedN(seed, 450);            // > 2 checkpoints (200, 400) + a tail
    const dev = await seed.reload();

    await dev.opLogger.captureOfflineChanges();
    expect(dev.pendingOps).toHaveLength(450);
    const before = shape(dev);

    // Everything durable came from the journal, not memory: a fresh stack loads the
    // exact same ops in the exact same order (NDJSON replay).
    const reloaded = await dev.reload();
    expect(shape(reloaded)).toEqual(before);
  });

  test('O(delta): each checkpoint appends ~the same bytes — not growing with N (the win)', async () => {
    const seed = await TestDevice.create('odelta');
    await seedN(seed, 600);            // exactly 3 full checkpoints: 200, 400, 600
    const dev = await seed.reload();

    const appendSizes = trackOplogAppends(dev);
    await dev.opLogger.captureOfflineChanges();

    // Three delta appends of ~200 ops each — the O(N²) rewrite would instead have
    // written 200, then 400, then 600 ops (growing). The regression guard: the LAST
    // checkpoint's append is ~the size of the FIRST, not a multiple of it.
    expect(appendSizes.length).toBeGreaterThanOrEqual(3);
    const first = appendSizes[0]!;
    const last = appendSizes[appendSizes.length - 1]!;
    expect(last).toBeLessThanOrEqual(first * 1.5);   // flat, not triangular
    // Total bytes are ~linear in N (Σ ≈ 3×first), nowhere near the O(N²) triangular
    // sum (≈ 6×first for 600 files at a 200 checkpoint).
    const total = appendSizes.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(first * appendSizes.length * 1.5);
  });

  test('torn trailing line (crash mid-append) is dropped on load; intact prefix survives', async () => {
    const seed = await TestDevice.create('torn');
    await seedN(seed, 3);
    const dev = await seed.reload();
    await dev.opLogger.captureOfflineChanges();
    expect(dev.pendingOps).toHaveLength(3);

    // Simulate a crash mid-append: a half-written final line is left on disk.
    const raw = await dev.metadata.read(OPLOG);
    dev.metadata.set(OPLOG, raw + '{"type":"crea');   // truncated JSON — unparseable

    // Load must tolerate it: drop the torn line, keep the 3 intact ops, never throw.
    const reloaded = await dev.reload();
    expect(reloaded.pendingOps).toHaveLength(3);
  });
});

describe('oplog append-journal — the shrink events compact via full rewrite (§4.2)', () => {
  test('clearOps truncates the journal to empty; a reload yields no ops', async () => {
    const seed = await TestDevice.create('clr');
    await seedN(seed, 5);
    const dev = await seed.reload();
    await dev.opLogger.captureOfflineChanges();
    expect(dev.pendingOps).toHaveLength(5);

    await dev.opLogger.clearOps();
    expect(dev.pendingOps).toHaveLength(0);
    // The on-disk journal is an empty file (a full-rewrite truncation, not an append).
    expect(await dev.metadata.read(OPLOG)).toBe('');

    const reloaded = await dev.reload();
    expect(reloaded.pendingOps).toHaveLength(0);
  });

  test('a create/delete-pair prune compacts the journal; a later append does not duplicate', async () => {
    const dev = await TestDevice.create('prune');
    await dev.seedFile('keep.md', 'keep\n', 1000);       // create appended
    const tmpId = await dev.seedFile('tmp.md', 'tmp\n', 1100); // create appended
    expect(dev.pendingOps.some(op => op.fileId === tmpId)).toBe(true);

    // Delete the never-synced tmp → pruneCreateDeletePair drops it → the journal is
    // rewritten (compacted) from the shrunken pendingOps, resetting the persist marker.
    await dev.deleteFile('tmp.md', 1200);
    expect(dev.pendingOps.filter(op => op.fileId === tmpId)).toEqual([]);

    // A subsequent live edit APPENDS one op onto the compacted journal — the marker was
    // reset by the rewrite, so this must not re-emit the surviving create nor skip the
    // update. Reload replays exactly {keep create, keep update}, no duplicates, no tmp.
    await dev.editFile('keep.md', 'keep v2\n', 1300);
    const reloaded = await dev.reload();
    const paths = reloaded.pendingOps.map(op => `${op.type}:${op.path}`);
    expect(paths).toEqual(['create:keep.md', 'update:keep.md']);
    expect(reloaded.pendingOps.some(op => op.fileId === tmpId)).toBe(false);
  });
});
