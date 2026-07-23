// ─────────────────────────────────────────────
//  captureOfflineChanges cancellation (plugin disabled mid-first-enable)
// ─────────────────────────────────────────────
//
//  The first-enable capture walks every vault file (O(F·B) hashing) and runs for
//  minutes on a large mobile vault. If the user disables the plugin mid-pass, main.ts
//  aborts an AbortController in onunload; captureOfflineChanges checks the signal at the
//  top of its loop and stops. Two properties matter and are asserted here:
//    1. It actually stops early AND persists the partial progress (checkpoint-safe), so
//       a re-enable resumes from what reached disk rather than losing it.
//    2. It returns BEFORE the delete-detection pass. On an aborted partial scan `onDisk`
//       is incomplete, so running that pass would read every un-scanned file as
//       "vanished while offline" and emit a vault-wide phantom delete — the exact
//       data-loss the empty-listing guard defends against.
//  This drives the REAL OperationLogger over the fakes.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

describe('captureOfflineChanges honours an abort signal', () => {
  const seedFiles = async (dev: TestDevice, n: number) => {
    for (let i = 0; i < n; i++) await dev.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);
  };

  test('stops early and persists the partial progress when aborted mid-scan', async () => {
    const seed = await TestDevice.create('cap-cancel');
    await seedFiles(seed, 500);
    const dev = await seed.reload();

    // Abort at the first progress tick (100 files scanned). The check at the top of
    // the loop then fires on the next iteration, so exactly the first 100 files are
    // captured — well short of all 500.
    const ac = new AbortController();
    await dev.opLogger.captureOfflineChanges(scanned => {
      if (scanned >= 100) ac.abort();
    }, ac.signal);

    expect(dev.pendingOps.length).toBe(100);

    // The partial progress reached disk: a re-enable (reload) recovers those 100 ops
    // instead of starting from zero, and the un-scanned tail is picked up next pass.
    const recovered = await dev.reload();
    expect(recovered.pendingOps.length).toBe(100);
  });

  test('does NOT emit phantom deletes for the un-scanned tail', async () => {
    // First a full capture so the registry tracks all 500 files as active entries —
    // the precondition for the delete-detection pass to have anything to (wrongly) act on.
    const seed = await TestDevice.create('cap-cancel-del');
    await seedFiles(seed, 500);
    const captured = await seed.reload();
    await captured.opLogger.captureOfflineChanges();
    expect(captured.activeEntries().length).toBe(500);

    // Re-capture, aborting after 100 files. At that point `onDisk` holds ~100 of the
    // 500 tracked paths; if the loop fell through to the delete pass it would tombstone
    // the other ~400 and emit delete ops for them. The early return prevents that.
    const dev = await captured.reload();
    const ac = new AbortController();
    await dev.opLogger.captureOfflineChanges(scanned => {
      if (scanned >= 100) ac.abort();
    }, ac.signal);

    const deleteOps = dev.pendingOps.filter(op => op.type === 'delete');
    expect(deleteOps.length).toBe(0);
    // No entry was tombstoned — the whole vault is still tracked and live.
    expect(dev.activeEntries().length).toBe(500);
  });
});
