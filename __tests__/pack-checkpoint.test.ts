// ─────────────────────────────────────────────
//  Tests — PackCheckpoint (shared bulk-write flush cadence)
// ─────────────────────────────────────────────
//
//  Pins the contract both the capture path (operation-logger) and the apply path
//  (sync-applicator) depend on: flush a bounded pack every N items, drop the mem
//  cache on a mid-pass checkpoint but keep the tail warm at the end, and always run
//  the pack flush BEFORE the referrer persist (blob-before-op).

import { describe, test, expect } from 'vitest';
import { PackCheckpoint, PackFlushTarget, PACK_CHECKPOINT_EVERY } from '../src/core/pack-checkpoint';

/** Records the order and count of flushes / cache-clears so a test can assert the
 *  cadence without a real content store. */
function spyTarget() {
  const log: string[] = [];
  let flushes = 0;
  let clears = 0;
  const target: PackFlushTarget = {
    flushPack: async () => { flushes++; log.push('flush'); },
    clearMemCache: () => { clears++; log.push('clear'); },
  };
  return { target, log, get flushes() { return flushes; }, get clears() { return clears; } };
}

describe('PackCheckpoint — cadence', () => {
  test('fires one bounded checkpoint every N ticks; the sub-N tail needs an explicit flush', async () => {
    const t = spyTarget();
    const cp = new PackCheckpoint(t.target, 3);

    await cp.tick(); await cp.tick();     // 2 < 3 — no checkpoint yet
    expect(t.flushes).toBe(0);
    await cp.tick();                      // 3rd tick → checkpoint
    expect(t.flushes).toBe(1);

    await cp.tick(); await cp.tick();     // counter reset; 2 more, still < 3
    expect(t.flushes).toBe(1);

    // The trailing 2 items are only durable once the caller flushes the tail.
    await cp.flush({ keepWarm: true });
    expect(t.flushes).toBe(2);
  });

  test('a mid-pass checkpoint drops the mem cache; a keepWarm flush does not', async () => {
    const t = spyTarget();
    const cp = new PackCheckpoint(t.target, 2);

    await cp.tick(); await cp.tick();     // auto checkpoint → flush + clear
    expect(t.log).toEqual(['flush', 'clear']);

    await cp.flush({ keepWarm: true });   // tail flush → flush, NO clear
    expect(t.log).toEqual(['flush', 'clear', 'flush']);
    expect(t.clears).toBe(1);

    await cp.flush({ keepWarm: false });  // explicit non-warm flush → flush + clear
    expect(t.log).toEqual(['flush', 'clear', 'flush', 'flush', 'clear']);
  });

  test('the pack flush runs BEFORE the referrer persist (blob-before-op)', async () => {
    const order: string[] = [];
    const target: PackFlushTarget = {
      flushPack: async () => { order.push('flushPack'); },
      clearMemCache: () => { order.push('clear'); },
    };
    const cp = new PackCheckpoint(target, 2, async () => { order.push('persistReferrers'); });

    await cp.tick(); await cp.tick();
    // Every checkpoint: blobs durable first, THEN the ops/registry that reference
    // them, THEN the cache drop.
    expect(order).toEqual(['flushPack', 'persistReferrers', 'clear']);
  });

  test('flush is safe (and resets the counter) on an empty/idle checkpoint', async () => {
    const t = spyTarget();
    const cp = new PackCheckpoint(t.target, 2);

    await cp.flush({ keepWarm: false });  // nothing ticked — flushPack itself no-ops upstream
    expect(t.flushes).toBe(1);

    // Counter was reset by flush, so it still takes a full N ticks to auto-fire.
    await cp.tick();
    expect(t.flushes).toBe(1);
    await cp.tick();
    expect(t.flushes).toBe(2);
  });

  test('defaults to the shared PACK_CHECKPOINT_EVERY cadence', async () => {
    const t = spyTarget();
    const cp = new PackCheckpoint(t.target);            // no explicit `every`
    for (let i = 0; i < PACK_CHECKPOINT_EVERY - 1; i++) await cp.tick();
    expect(t.flushes).toBe(0);
    await cp.tick();
    expect(t.flushes).toBe(1);
  });
});
