// ─────────────────────────────────────────────
//  Tests — HLC persistence (F7)
// ─────────────────────────────────────────────
//
//  A clock-seam UNIT test proving logical time never regresses across a restart
//  when the device's wall clock moves backward. The clock is driven through its
//  injected `wallClock` seam (the same seam TestDevice uses), so the scenario is
//  fully deterministic — no real time involved.

import { describe, test, expect } from 'vitest';
import { HybridLogicalClock, hlcCompare } from '../src/core/hlc';
import { HlcStore } from '../src/network/hlc-store';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const DEVICE = 'device-A';

describe('HLC persistence (F7)', () => {
  test('a persisted + seeded clock keeps logical time monotonic across a wall-clock regression', async () => {
    const metadata = new FakeMetadataStore();
    const store = new HlcStore(metadata);

    // ── Before the "restart": issue an op at wall = 5000, then persist. ──────
    const wall1 = { t: 5000 };
    const clock1 = new HybridLogicalClock(DEVICE, undefined, () => wall1.t);
    const op1 = clock1.now(); // { wallTime: 5000, counter: 0 }
    expect(op1.wallTime).toBe(5000);
    await store.save(clock1.getCurrent());

    // ── "Restart" with a REGRESSED wall clock (1000 < 5000). Reconstruct the ─
    //    clock seeded from the persisted HLC — the production startup path.
    const persisted = await store.load();
    expect(persisted).not.toBeNull();
    const wall2 = { t: 1000 };
    const clock2 = new HybridLogicalClock(DEVICE, persisted ?? undefined, () => wall2.t);
    const op2 = clock2.now();

    // The freshly-issued op must NOT regress below the wall=5000 op, or it could
    // lose last-writer-wins to older remote content — a silent overwrite.
    expect(hlcCompare(op2, op1)).toBeGreaterThan(0);
  });

  test('WITHOUT the persisted seed, a regressed wall clock issues a LOWER HLC (the bug this guards)', () => {
    // Documents why the seed is necessary: a fresh clock adopts the current wall
    // time, so after a backward jump its first op is strictly earlier than one
    // already issued at the higher wall time.
    const op1 = new HybridLogicalClock(DEVICE, undefined, () => 5000).now();
    const freshAfterRegression = new HybridLogicalClock(DEVICE, undefined, () => 1000).now();
    expect(hlcCompare(freshAfterRegression, op1)).toBeLessThan(0);
  });
});
