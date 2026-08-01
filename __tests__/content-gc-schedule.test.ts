// ─────────────────────────────────────────────
//  Content-store GC scheduling — the retention window is actually enforced
// ─────────────────────────────────────────────
//
//  `ContentStore.gc()` implements retirement/compaction correctly (asserted in
//  content-store-gc.test.ts) but for a long time NOTHING called it except the settings
//  "Clear cache" button — so for any user who never pressed it, `ancestorRetentionDays`
//  was advisory: packs kept every superseded version forever and the pack index (re-read
//  in full at every startup) grew for the life of the vault.
//
//  These tests pin the schedule that fixes that: the coordinator runs GC after a
//  successful round, at most once per interval, stamping `lastGcAt` in the sync-state.
//  The GC *semantics* are not re-tested here — `runGc` is a spy.

import { describe, test, expect, vi } from 'vitest';
import { SyncStateStore } from '../src/network/sync-state-store';
import { SyncRoundSummary } from '../src/network/server-sync';
import { SyncCoordinator, gcDue, GC_MIN_INTERVAL_MS } from '../src/network/sync-coordinator';
import { TestDevice } from './helpers/test-device';

const EMPTY_SUMMARY: SyncRoundSummary = { pushed: 0, pulled: 0, deferred: [], stranded: [], deferredConflicts: [] };
const DAY = 24 * 60 * 60 * 1000;

/** A coordinator over a real device stack + a real SyncStateStore, with a settable
 *  clock and a spied `runGc`. `roundError` makes the stubbed round throw. */
async function harness(opts: { roundError?: Error; gcError?: Error } = {}) {
  const device = await TestDevice.create('dev-gc');
  const syncState = new SyncStateStore(device.metadata);
  await syncState.load();

  let clock = 1_000_000;
  const runGc = vi.fn(async () => {
    if (opts.gcError) throw opts.gcError;
    return 7; // "removed 7 blobs"
  });

  const coordinator = new SyncCoordinator({
    editorSaver: { saveOpenEditors: vi.fn(async () => {}) },
    notifier: { info: vi.fn(), error: vi.fn(), setupError: vi.fn() },
    opLogger: device.opLogger,
    syncState,
    hlc: device.hlc,
    registry: device.registry,
    runRound: vi.fn(async () => {
      if (opts.roundError) throw opts.roundError;
      return EMPTY_SUMMARY;
    }),
    runGc,
    gcIntervalMs: DAY,
    now: () => clock,
  });

  return { device, syncState, coordinator, runGc, setClock: (n: number) => { clock = n; } };
}

describe('gcDue (the scheduling predicate)', () => {
  test('never-run is NOT due — the caller seeds the window instead', () => {
    // The first round after enabling follows the first-enable capture (the heaviest pass
    // the plugin has), and nothing captured minutes ago can have aged out anyway.
    expect(gcDue(null, 1_000_000, DAY)).toBe(false);
  });

  test('not due before the interval, due at and after it', () => {
    expect(gcDue(1000, 1000 + DAY - 1, DAY)).toBe(false);
    expect(gcDue(1000, 1000 + DAY, DAY)).toBe(true);
    expect(gcDue(1000, 1000 + 5 * DAY, DAY)).toBe(true);
  });

  test('a lastGcAt in the future (clock moved backwards) is due, not wedged', () => {
    expect(gcDue(9_000_000, 1_000_000, DAY)).toBe(true);
  });

  test('the shipped interval is a day', () => {
    expect(GC_MIN_INTERVAL_MS).toBe(DAY);
  });
});

describe('content-store GC scheduling', () => {
  test('the first successful round seeds lastGcAt without running GC', async () => {
    const h = await harness();
    await h.coordinator.sync('auto');
    expect(h.runGc).not.toHaveBeenCalled();
    expect(h.syncState.get().lastGcAt).toBe(1_000_000);
  });

  test('GC runs once the interval has elapsed, and not again until the next one', async () => {
    const h = await harness();
    await h.coordinator.sync('auto');            // seeds at t=1_000_000
    expect(h.runGc).not.toHaveBeenCalled();

    h.setClock(1_000_000 + DAY - 1);
    await h.coordinator.sync('auto');            // still inside the window
    expect(h.runGc).not.toHaveBeenCalled();
    expect(h.syncState.get().lastGcAt).toBe(1_000_000); // stamp untouched

    h.setClock(1_000_000 + DAY);
    await h.coordinator.sync('auto');            // due
    expect(h.runGc).toHaveBeenCalledTimes(1);
    expect(h.syncState.get().lastGcAt).toBe(1_000_000 + DAY);

    await h.coordinator.sync('auto');            // same clock → no second pass
    expect(h.runGc).toHaveBeenCalledTimes(1);

    h.setClock(1_000_000 + 2 * DAY);
    await h.coordinator.sync('auto');
    expect(h.runGc).toHaveBeenCalledTimes(2);
  });

  test('a failed round never runs GC (and never stamps the clock)', async () => {
    const h = await harness({ roundError: new Error('network down') });
    const outcome = await h.coordinator.sync('auto');
    expect(outcome.ok).toBe(false);
    expect(h.runGc).not.toHaveBeenCalled();
    expect(h.syncState.get().lastGcAt).toBeNull();
  });

  test('a GC that throws does not fail the round, and still stamps so it cannot retry every round', async () => {
    const h = await harness({ gcError: new Error('pack index unreadable') });
    await h.syncState.setLastGcAt(1_000_000);
    h.setClock(1_000_000 + 3 * DAY); // long overdue → due on this round
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await h.coordinator.sync('manual');

    expect(outcome.ok).toBe(true);                    // maintenance never fails a round
    expect(h.runGc).toHaveBeenCalledTimes(1);
    expect(h.syncState.get().lastGcAt).toBe(1_000_000 + 3 * DAY); // stamped despite the failure
    consoleError.mockRestore();
  });

  test('no runGc wired (tests / a host that omits it) → the schedule is inert', async () => {
    const device = await TestDevice.create('dev-nogc');
    const syncState = new SyncStateStore(device.metadata);
    await syncState.load();
    const coordinator = new SyncCoordinator({
      editorSaver: { saveOpenEditors: vi.fn(async () => {}) },
      notifier: { info: vi.fn(), error: vi.fn(), setupError: vi.fn() },
      opLogger: device.opLogger,
      syncState,
      hlc: device.hlc,
      registry: device.registry,
      runRound: vi.fn(async () => EMPTY_SUMMARY),
      now: () => 4242,
    });

    await coordinator.sync('auto');
    expect(syncState.get().lastGcAt).toBeNull(); // not even seeded
  });

  test('lastGcAt is durable — a restart does not re-run GC immediately', async () => {
    const h = await harness();
    h.setClock(2_000_000);
    await h.coordinator.sync('auto'); // seeds

    // Fresh store over the same metadata = plugin restart.
    const reloaded = new SyncStateStore(h.device.metadata);
    expect((await reloaded.load()).lastGcAt).toBe(2_000_000);
    expect(gcDue(reloaded.get().lastGcAt, 2_000_000 + 60_000, DAY)).toBe(false);
  });

  test('a sync-state file written before this field existed loads as never-run', async () => {
    const device = await TestDevice.create('dev-legacy');
    await device.metadata.write(
      '.opsblobs/sync-state.json',
      JSON.stringify({ deferred: [], conflicts: [], pendingDecisions: {}, stranded: [], lastError: null, lastSync: null }),
    );
    const store = new SyncStateStore(device.metadata);
    expect((await store.load()).lastGcAt).toBeNull();
  });
});
