// ─────────────────────────────────────────────
//  maxFileSizeMb — per-file size cap on capture (mirrors the server's MaxBlobSize)
// ─────────────────────────────────────────────
//
//  A file over the configured cap is never read, hashed, or queued for upload —
//  it's skipped exactly like an excluded path, but decided on size rather than
//  path. The one subtlety: a file that was captured while under the cap and later
//  grows past it must NOT look like a "vanished while offline" delete on the next
//  capture pass (the same phantom-delete guard `isExcluded` already gets).
//
//  Driven through the REAL device stack (TestDevice over the in-memory fakes).

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

const big = (mb: number) => 'x'.repeat(mb * 1024 * 1024);

describe('maxFileSizeMb capture gate', () => {
  test('an oversize file is skipped on offline capture: no op, no read past the stat', async () => {
    const A = await TestDevice.create('dev-a', { settings: { maxFileSizeMb: 1 } });
    await A.seedExistingFile('small.md', 'body\n');
    await A.seedExistingFile('huge.bin', big(2));

    const stats = await A.opLogger.captureOfflineChanges();
    expect(stats.skippedTooLarge).toBe(1);
    expect(A.pendingOps).toHaveLength(1);
    expect(A.pendingOps[0]!.path).toBe('small.md');
    expect(A.entryByPath('huge.bin')).toBeUndefined();
  });

  test('0 (default) means no limit — a large file captures normally', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('huge.bin', big(2));

    const stats = await A.opLogger.captureOfflineChanges();
    expect(stats.skippedTooLarge).toBe(0);
    expect(A.pendingOps).toHaveLength(1);
  });

  test('a tracked file that grows past the cap is not phantom-deleted on the next capture', async () => {
    const A = await TestDevice.create('dev-a', { settings: { maxFileSizeMb: 1 } });
    await A.seedExistingFile('note.md', 'small body\n');
    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(1);
    expect(A.entryByPath('note.md')).toBeDefined();

    // Grows past the cap while "offline" (no live event — a raw disk write).
    await A.files.write('note.md', new TextEncoder().encode(big(2)));

    const stats = await A.opLogger.captureOfflineChanges();
    expect(stats.skippedTooLarge).toBe(1);
    // No delete op emitted, and the entry is still active (not tombstoned).
    expect(A.pendingOps.some(op => op.type === 'delete')).toBe(false);
    expect(A.entryByPath('note.md')?.deleted).toBeFalsy();
  });

  test('a live create of an oversize file is skipped and never registered', async () => {
    const A = await TestDevice.create('dev-a', { settings: { maxFileSizeMb: 1 } });
    // Not `seedFile` — that helper asserts the entry got registered, which an
    // oversize file deliberately never does.
    await A.files.write('huge.bin', new TextEncoder().encode(big(2)));
    await A.watcher.emitCreate('huge.bin');

    expect(A.pendingOps).toHaveLength(0);
    expect(A.entryByPath('huge.bin')).toBeUndefined();
    expect(A.notices.some(n => n.includes('huge.bin'))).toBe(true);
  });

  test('a live edit that grows a tracked file past the cap freezes it at the last synced hash', async () => {
    const A = await TestDevice.create('dev-a', { settings: { maxFileSizeMb: 1 } });
    const id = await A.seedFile('note.md', 'small body\n', 1);
    expect(A.pendingOps).toHaveLength(1);
    const originalHash = A.entry(id)!.contentHash;

    await A.editFile('note.md', big(2), 2);

    // No new op — the entry is left at its last-under-cap hash.
    expect(A.pendingOps).toHaveLength(1);
    expect(A.entry(id)!.contentHash).toBe(originalHash);

    // Edited back under the cap: proceeds normally again.
    await A.editFile('note.md', 'small body v2\n', 3);
    expect(A.pendingOps).toHaveLength(2);
    expect(A.entry(id)!.contentHash).not.toBe(originalHash);
  });
});
