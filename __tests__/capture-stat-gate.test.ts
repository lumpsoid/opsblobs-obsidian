// ─────────────────────────────────────────────
//  O1 — mtime/size capture stat-gate (capture-optimization-spec §3)
// ─────────────────────────────────────────────
//
//  `captureOfflineChanges` runs before EVERY sync to catch offline drift. Before O1
//  it re-read + re-SHA-256'd every live file each pass — O(F) even when nothing
//  changed. O1 gates that read+hash on a cheap `mtime + size` comparison: a tracked
//  file whose stat is unchanged since we last hashed it is skipped entirely, so a
//  routine capture is O(touched), not O(F).
//
//  Driven through the REAL device stack (TestDevice over the in-memory fakes). The
//  fake vault carries a per-file mtime (a monotonic tick bumped on every write) and a
//  size (byte length), exactly the stat the live Obsidian adapter reads off
//  `TFile.stat`. `FakeVaultFiles.io.reads` is the ground-truth read counter these
//  tests assert against — a gated file issues no read.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

const enc = (s: string) => new TextEncoder().encode(s);

describe('O1 capture stat-gate', () => {
  test('a stat-unchanged file is NOT re-read or re-hashed on a second capture', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('a.md', 'body\n');
    await A.seedExistingFile('b.md', 'other\n');

    // First capture: both files are new → each is read + hashed + captured, and its
    // stat is recorded into the registry entry.
    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(2);
    const readsAfterFirst = A.files.io.reads;
    expect(readsAfterFirst).toBeGreaterThanOrEqual(2);

    // Nothing on disk changed → the gate skips both: zero further reads, no new ops.
    await A.opLogger.captureOfflineChanges();
    expect(A.files.io.reads).toBe(readsAfterFirst); // O(1), not O(F)
    expect(A.pendingOps).toHaveLength(2);
  });

  test('a second capture over F unchanged files does O(1) reads, not O(F)', async () => {
    const A = await TestDevice.create('dev-a');
    const F = 40;
    for (let i = 0; i < F; i++) await A.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);

    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(F);
    const readsAfterFirst = A.files.io.reads;

    await A.opLogger.captureOfflineChanges();
    // Not one file re-read — the whole scan is gated.
    expect(A.files.io.reads - readsAfterFirst).toBe(0);
    expect(A.pendingOps).toHaveLength(F);
  });

  test('a file whose content (mtime + size) changed IS re-hashed and re-opped, its neighbour still gated', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('a.md', 'body\n');
    await A.seedExistingFile('b.md', 'other\n');
    await A.opLogger.captureOfflineChanges();
    const readsAfterFirst = A.files.io.reads;

    // Offline disk change to a.md only (raw write → new mtime + new size, no event).
    await A.files.write('a.md', enc('a much longer changed body\n'));

    await A.opLogger.captureOfflineChanges();
    // Exactly one re-read: a.md re-hashed, b.md skipped by the gate.
    expect(A.files.io.reads - readsAfterFirst).toBe(1);

    const aOps = A.pendingOps.filter(op => op.path === 'a.md');
    expect(aOps).toHaveLength(2);            // create + update
    expect(aOps[1]!.type).toBe('update');
    expect(A.pendingOps.filter(op => op.path === 'b.md')).toHaveLength(1); // untouched
    expect(A.entryByPath('a.md')!.contentHash).toBe(aOps[1]!.contentHash);
  });

  test('the size half of the gate: a same-mtime write of different-sized bytes is still caught', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('a.md', 'body\n');
    await A.opLogger.captureOfflineChanges();
    const readsAfterFirst = A.files.io.reads;

    // Change the bytes (and thus size) but leave mtime bit-for-bit identical — the
    // gate must fall through on the size mismatch and re-capture.
    await A.files.writeKeepingMtime('a.md', enc('a different, longer body here\n'));

    await A.opLogger.captureOfflineChanges();
    expect(A.files.io.reads - readsAfterFirst).toBe(1);
    const aOps = A.pendingOps.filter(op => op.path === 'a.md');
    expect(aOps).toHaveLength(2);
    expect(aOps[1]!.type).toBe('update');
  });

  test('self-heal: an mtime-only drift with identical content re-hashes once, emits no op, then gates forever', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('a.md', 'body\n');
    await A.opLogger.captureOfflineChanges();
    const readsAfterFirst = A.files.io.reads;

    // Rewrite IDENTICAL bytes — bumps mtime, same size, same hash. Models a file the
    // sync applicator (re)wrote to its already-current content: stat drifts, content
    // does not.
    await A.files.write('a.md', enc('body\n'));

    // Second capture: the gate mismatches on mtime, so a.md is read + hashed once, the
    // hash matches → NO op is emitted, and the fresh stat is recorded (self-heal).
    await A.opLogger.captureOfflineChanges();
    expect(A.files.io.reads - readsAfterFirst).toBe(1);
    expect(A.pendingOps.filter(op => op.path === 'a.md')).toHaveLength(1); // just the create

    // Third capture: the recorded stat now matches disk → fully gated, zero reads.
    const readsAfterSecond = A.files.io.reads;
    await A.opLogger.captureOfflineChanges();
    expect(A.files.io.reads - readsAfterSecond).toBe(0);
    expect(A.pendingOps.filter(op => op.path === 'a.md')).toHaveLength(1);
  });

  test('the gate cache survives a reload (persisted on the entry)', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('a.md', 'body\n');
    await A.opLogger.captureOfflineChanges();

    // Restart the plugin over the same vault + metadata: the registry (with the
    // recorded mtime/size) is reloaded from disk, and the pending create survives in
    // the oplog.
    const B = await A.reload();
    const readsBefore = B.files.io.reads;
    expect(B.pendingOps.filter(op => op.path === 'a.md')).toHaveLength(1); // create restored

    // Nothing changed on disk across the restart → the reloaded device's first
    // capture must still gate the file off the persisted stat: zero reads, no new op.
    await B.opLogger.captureOfflineChanges();
    expect(B.files.io.reads - readsBefore).toBe(0);
    expect(B.pendingOps.filter(op => op.path === 'a.md')).toHaveLength(1);
  });
});
