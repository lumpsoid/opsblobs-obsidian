// ─────────────────────────────────────────────
//  captureOfflineChanges crash-safety (incremental oplog checkpointing)
// ─────────────────────────────────────────────
//
//  A first-enable capture of a large vault runs for minutes on mobile and can be
//  OOM-killed mid-pass. The registry is persisted per-file, but the oplog used to be
//  written only once at the very end — so an interrupted capture left files marked
//  "captured" in the registry while their ops were never journalled, stranding them
//  (they skip re-capture on the `entry.contentHash === hash` guard and never sync).
//  captureOfflineChanges now checkpoints the oplog every CAPTURE_CHECKPOINT_EVERY (200)
//  ops, bounding that loss to <200 and keeping the live pending count fresh. This
//  drives the REAL OperationLogger over the fakes.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

describe('captureOfflineChanges checkpoints the oplog', () => {
  const seedFiles = async (dev: TestDevice, n: number) => {
    for (let i = 0; i < n; i++) await dev.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);
  };

  test('persists the oplog incrementally, not only at the end', async () => {
    const seed = await TestDevice.create('cap-inc');
    await seedFiles(seed, 500);
    const dev = await seed.reload();

    let oplogWrites = 0;
    const orig = dev.metadata.write.bind(dev.metadata);
    dev.metadata.write = async (p: string, d: string) => {
      if (p.endsWith('oplog.json')) oplogWrites++;
      return orig(p, d);
    };

    await dev.opLogger.captureOfflineChanges();

    // 500 new files, 200-op checkpoint → flushes at 200, 400, + the final write.
    expect(oplogWrites).toBeGreaterThanOrEqual(2);
    expect(dev.pendingOps.length).toBe(500);
  });

  test('an interrupted capture leaves the checkpointed ops durable (recoverable)', async () => {
    const seed = await TestDevice.create('cap-crash');
    await seedFiles(seed, 500);
    const dev = await seed.reload();

    // Simulate an OOM kill: make the vault read throw after ~350 files, well past
    // the first checkpoint (200) but before the end.
    let reads = 0;
    const origRead = dev.files.read.bind(dev.files);
    dev.files.read = async (p: string) => {
      if (++reads > 350) throw new Error('simulated crash (OOM)');
      return origRead(p);
    };
    await expect(dev.opLogger.captureOfflineChanges()).rejects.toThrow('simulated crash');
    dev.files.read = origRead; // restore the shared fake before reloading

    // Reload from disk (the crash discarded in-memory pendingOps). Before the fix,
    // ZERO ops would survive; now the checkpoint at 200 is durable, so the capture
    // is recoverable rather than silently lost.
    const recovered = await dev.reload();
    expect(recovered.pendingOps.length).toBeGreaterThanOrEqual(200);
    expect(recovered.pendingOps.length).toBeLessThan(500);
  });
});
