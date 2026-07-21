// ─────────────────────────────────────────────
//  OperationLogger.onChange — the status-badge signal
// ─────────────────────────────────────────────
//
//  The status badge (main.ts) is a coarse "synced / changes to sync / conflict"
//  indicator that must flip the instant the user's edit is recorded — not on a
//  timer and not only after the next sync. main.ts wires that off
//  `OperationLogger.onChange`, so this pins the contract that backs it:
//   · fires when a (debounced) edit is recorded, AFTER getPendingOps() is current
//   · fires when the pending log is cleared (the round emptying it, badge → synced)
//   · a create+delete pair that fully cancels still ends with an empty log
//
//  Driven through the REAL device stack (TestDevice over in-memory fakes) so the
//  genuine OperationLogger path fires the hook, not a look-alike.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

describe('OperationLogger.onChange (status-badge signal)', () => {
  test('fires after a recorded edit, with getPendingOps() already current', async () => {
    const dev = new TestDevice('A');
    await dev.init();

    // Observe the pending count as seen from inside each notification — proves
    // the callback runs *after* the log is persisted, so the badge reads truth.
    const seen: number[] = [];
    dev.opLogger.onChange(() => seen.push(dev.opLogger.getPendingOps().length));

    await dev.seedFile('note.md', 'hello', 1000);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(dev.opLogger.getPendingOps().length);
    expect(dev.opLogger.getPendingOps().length).toBe(1);
  });

  test('fires when the pending log is cleared (badge returns to "synced")', async () => {
    const dev = new TestDevice('A');
    await dev.init();
    await dev.seedFile('note.md', 'hello', 1000);
    expect(dev.opLogger.getPendingOps().length).toBe(1);

    let clearedToEmpty = false;
    dev.opLogger.onChange(() => {
      if (dev.opLogger.getPendingOps().length === 0) clearedToEmpty = true;
    });

    await dev.opLogger.clearOps();

    expect(clearedToEmpty).toBe(true);
    expect(dev.opLogger.getPendingOps().length).toBe(0);
  });

  test('a create+delete pair that cancels ends observably empty (G11)', async () => {
    const dev = new TestDevice('A');
    await dev.init();

    let lastSeen = -1;
    dev.opLogger.onChange(() => { lastSeen = dev.opLogger.getPendingOps().length; });

    await dev.seedFile('scratch.md', 'temp', 1000);
    await dev.deleteFile('scratch.md', 2000);

    // The last notification must reflect a fully-cancelled pair (nothing to sync),
    // so the badge doesn't get stuck on "changes to sync" for a phantom op.
    expect(lastSeen).toBe(0);
    expect(dev.opLogger.getPendingOps().length).toBe(0);
  });
});
