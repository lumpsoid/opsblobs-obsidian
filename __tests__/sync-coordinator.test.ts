// ─────────────────────────────────────────────
//  SyncCoordinator — the orchestration extracted from the plugin, unit-tested
// ─────────────────────────────────────────────
//
//  Drives the REAL coordinator over the real OperationLogger/FileRegistry/HLC
//  (via TestDevice's stack) plus a real SyncStateStore, with fake EditorSaver /
//  Notifier and a stubbed `runRound`. This is the payoff of extracting the logic
//  out of the Obsidian `Plugin` subclass: the capture ordering, summary folding,
//  error handling, conflict branching and reset/rebaseline sequences are now
//  assertable without an Obsidian runtime.

import { describe, test, expect, vi } from 'vitest';
import { MergeAction } from '../src/types';
import { SyncStateStore } from '../src/network/sync-state-store';
import { SyncRoundSummary } from '../src/network/server-sync';
import { DEFER_CONFLICT } from '../src/network/sync-applicator';
import { SyncCoordinator } from '../src/network/sync-coordinator';
import { AuthError } from '../src/network/sync-errors';
import { SyncCancelledError } from '../src/network/sync-cancellation';
import { TestDevice } from './helpers/test-device';

const EMPTY_SUMMARY: SyncRoundSummary = { pushed: 0, pulled: 0, deferred: [], stranded: [], deferredConflicts: [], applyFailures: [] };

/** Build a coordinator over a real device stack with recording ports + a stubbed
 *  round. `order` captures the pre-sync capture sequence; `runRound` returns
 *  whatever `summary` is set to (or throws if `roundError` is set). */
async function harness(opts: { summary?: SyncRoundSummary; roundError?: Error } = {}) {
  const device = await TestDevice.create('dev-a');
  const syncState = new SyncStateStore(device.metadata);
  await syncState.load();

  const order: string[] = [];
  const editorSaver = { saveOpenEditors: vi.fn(async () => { order.push('save'); }) };
  const notifier = { info: vi.fn(), error: vi.fn(), setupError: vi.fn() };

  // Wrap the real logger methods to record order while keeping real behaviour.
  const realFlush = device.opLogger.flush.bind(device.opLogger);
  device.opLogger.flush = async () => { order.push('flush'); return realFlush(); };
  const realCapture = device.opLogger.captureOfflineChanges.bind(device.opLogger);
  device.opLogger.captureOfflineChanges = async () => { order.push('capture'); return realCapture(); };

  const runRound = vi.fn(async () => {
    order.push('round');
    if (opts.roundError) throw opts.roundError;
    return opts.summary ?? EMPTY_SUMMARY;
  });

  const persistHlc = vi.fn(async () => {});
  const markSynced = vi.fn(async () => {});
  let clock = 5000;

  const coordinator = new SyncCoordinator({
    editorSaver, notifier,
    opLogger: device.opLogger,
    syncState,
    hlc: device.hlc,
    registry: device.registry,
    runRound,
    persistHlc,
    markSynced,
    now: () => clock,
  });

  return { device, syncState, coordinator, order, editorSaver, notifier, runRound, persistHlc, markSynced, setClock: (n: number) => { clock = n; } };
}

describe('SyncCoordinator', () => {
  test('sync runs the capture sequence in order, then the round', async () => {
    const h = await harness();
    await h.coordinator.sync('manual');
    // editor save → flush armed timers → capture on-disk drift → run the round.
    expect(h.order).toEqual(['save', 'flush', 'capture', 'round']);
    expect(h.persistHlc).toHaveBeenCalledOnce();
    expect(h.markSynced).toHaveBeenCalledOnce();
  });

  test('a happy round folds the summary into sync-state and clears any prior error', async () => {
    const id = 'fileX';
    const h = await harness({ summary: { pushed: 2, pulled: 3, deferred: [id], stranded: ['hashY'], deferredConflicts: [], applyFailures: [] } });
    await h.syncState.setError('stale failure', 1); // a leftover error from a previous round

    await h.coordinator.sync('manual');

    const state = h.syncState.get();
    expect(state.lastError).toBeNull();                       // cleared on success
    expect(state.lastSync).toMatchObject({ pushed: 2, pulled: 3, at: 5000 });
    expect(state.deferred).toEqual([{ fileId: id, path: id, at: 5000 }]);
    expect(state.stranded).toEqual([{ contentHash: 'hashY', at: 5000 }]);
  });

  test('manual sync toasts success; auto sync stays silent', async () => {
    const manual = await harness();
    await manual.coordinator.sync('manual');
    expect(manual.notifier.info).toHaveBeenCalledWith('Sync complete');

    const auto = await harness();
    await auto.coordinator.sync('auto');
    expect(auto.notifier.info).not.toHaveBeenCalled();
  });

  test('a failing round records the error, toasts it, and leaves pending ops + no clearError', async () => {
    const h = await harness({ roundError: new Error('network down') });
    await h.device.seedFile('note.md', 'body\n', 1000); // one un-synced pending op
    const clearError = vi.spyOn(h.syncState, 'clearError');

    const outcome = await h.coordinator.sync('manual');

    expect(outcome.ok).toBe(false);
    expect(h.notifier.error).toHaveBeenCalledWith('Sync failed: network down');
    expect(h.syncState.get().lastError).toEqual({ message: 'network down', at: 5000 });
    expect(clearError).not.toHaveBeenCalled();
    expect(h.device.pendingOps.length).toBeGreaterThan(0); // un-pushed work survives
  });

  test('a user-cancelled round is not a failure: quiet toast, no persisted error, pending ops survive', async () => {
    const h = await harness({ roundError: new SyncCancelledError() });
    await h.device.seedFile('note.md', 'body\n', 1000); // one un-synced pending op
    const clearError = vi.spyOn(h.syncState, 'clearError');

    const outcome = await h.coordinator.sync('manual');

    expect(outcome.ok).toBe(false);
    expect(outcome.cancelled).toBe(true);
    // Distinct from a real failure: no scary error toast, nothing durably recorded.
    expect(h.notifier.error).not.toHaveBeenCalled();
    expect(h.notifier.info).toHaveBeenCalledWith('Sync cancelled');
    expect(h.syncState.get().lastError).toBeNull();
    expect(clearError).not.toHaveBeenCalled();
    // Un-pushed work simply survives, exactly as if the round never ran.
    expect(h.device.pendingOps.length).toBeGreaterThan(0);
  });

  test('a setup-class error routes to the durable setupError notice with an action, not the fading toast (§5)', async () => {
    const openSettings = vi.fn();
    const device = await TestDevice.create('dev-a');
    const syncState = new SyncStateStore(device.metadata);
    await syncState.load();
    const notifier = { info: vi.fn(), error: vi.fn(), setupError: vi.fn() };
    const coordinator = new SyncCoordinator({
      editorSaver: { saveOpenEditors: vi.fn(async () => {}) },
      notifier,
      opLogger: device.opLogger,
      syncState,
      hlc: device.hlc,
      registry: device.registry,
      runRound: vi.fn(async () => { throw new AuthError(401); }),
      openSettings,
      now: () => 7000,
    });

    const outcome = await coordinator.sync('auto');

    expect(outcome.ok).toBe(false);
    // Durable, actionable presentation — NOT the transient error toast.
    expect(notifier.error).not.toHaveBeenCalled();
    expect(notifier.setupError).toHaveBeenCalledTimes(1);
    const [msg, action] = notifier.setupError.mock.calls[0]!;
    expect(msg).toContain('access token');
    expect(action.label).toBe('Open settings');
    action.run();
    expect(openSettings).toHaveBeenCalled();
    // Still recorded in the observable state for the status modal.
    expect(syncState.get().lastError?.message).toContain('access token');
  });

  test('a deferred delete/binary conflict becomes a descriptor (not drift) and is counted', async () => {
    // "Full inline" (§3): a round's `deferredConflicts` are the delete/binary conflicts
    // the decide* handlers deferred to the panel — recorded as rich `conflicts`
    // descriptors, split out of the F5-drift `deferred` list. `deferredConflictCount()`
    // reflects only those; a later round that no longer defers them drops the count.
    const deleteAction = { type: 'delete_conflict', fileId: 'fConf', path: 'c.md', side: 'remote_deleted', content: new Uint8Array() } as Extract<MergeAction, { type: 'delete_conflict' }>;
    const h = await harness();
    // The stubbed round stands in for the applicator invoking the coordinator's handler.
    h.runRound.mockImplementationOnce(async () => {
      await h.coordinator.decideDeleteConflict('ask', deleteAction);
      return { pushed: 0, pulled: 2, deferred: ['fConf', 'fDrift'], stranded: [], deferredConflicts: ['fConf'], applyFailures: [] };
    });

    await h.coordinator.sync('manual');

    // Drift stays in `deferred`; the conflict moves to `conflicts` with its descriptor.
    expect(h.syncState.get().deferred.map(d => d.fileId)).toEqual(['fDrift']);
    const conflicts = h.syncState.get().conflicts;
    expect(conflicts.map(c => c.fileId)).toEqual(['fConf']);
    expect(conflicts[0]).toMatchObject({ kind: 'delete', path: 'c.md', side: 'remote_deleted' });
    expect(h.coordinator.deferredConflictCount()).toBe(1);
    expect(h.syncState.get().lastSync?.conflicts).toBe(1);

    // A subsequent round that defers nothing replaces the list wholesale — count → 0.
    h.runRound.mockResolvedValueOnce(EMPTY_SUMMARY);
    await h.coordinator.sync('manual');
    expect(h.coordinator.deferredConflictCount()).toBe(0);
  });

  test('delete conflict: a recorded panel decision is consumed; a standing policy applies; else defer', async () => {
    const h = await harness();
    const action = { type: 'delete_conflict', fileId: 'f3', path: 'c.md', side: 'remote_deleted', content: new Uint8Array() } as Extract<MergeAction, { type: 'delete_conflict' }>;

    // No decision, 'ask' strategy → defer to the panel (record a descriptor).
    expect(await h.coordinator.decideDeleteConflict('ask', action)).toBe(DEFER_CONFLICT);

    // A standing non-'ask' policy is the user's blanket choice → applied.
    expect(await h.coordinator.decideDeleteConflict('keep_deleted', action)).toBe('keep_deleted');

    // A decision the user recorded in the panel is consumed (even under 'ask').
    await h.syncState.recordDecision('f3', { kind: 'delete', decision: 'keep_modified' });
    expect(await h.coordinator.decideDeleteConflict('ask', action)).toBe('keep_modified');
  });

  test('binary conflict: a recorded decision is consumed; else defer to the panel', async () => {
    const h = await harness();
    const hlc = (deviceId: string, wallTime: number) => ({ deviceId, wallTime, counter: 0 });
    const action = {
      type: 'binary_conflict', fileId: 'f4', localPath: 'p.png', remotePath: 'p.png',
      localContent: new Uint8Array(10), remoteContent: new Uint8Array(20),
      localHlc: hlc('dev-a', 1000), remoteHlc: hlc('dev-b', 2000),
    } as Extract<MergeAction, { type: 'binary_conflict' }>;

    expect(await h.coordinator.decideBinaryConflict(action)).toBe(DEFER_CONFLICT);

    await h.syncState.recordDecision('f4', { kind: 'binary', decision: 'keep_remote' });
    expect(await h.coordinator.decideBinaryConflict(action)).toBe('keep_remote');
  });

  test('reset: confirm=false aborts (never reconciles/captures/clears)', async () => {
    const h = await harness();
    await h.device.seedFile('note.md', 'body\n', 1000); // pending op present → confirm is asked
    const reconcile = vi.spyOn(h.device.registry, 'reconcileWithVault');
    const clearOps = vi.spyOn(h.device.opLogger, 'clearOps');
    const confirm = vi.fn(async () => false);

    await h.coordinator.reset(confirm);

    expect(confirm).toHaveBeenCalledWith(1);   // told how many un-synced changes
    expect(reconcile).not.toHaveBeenCalled();
    expect(clearOps).not.toHaveBeenCalled();
    expect(h.device.pendingOps.length).toBeGreaterThan(0);
  });

  test('reset: confirm=true reconciles + re-captures and NEVER clears the oplog', async () => {
    const h = await harness();
    await h.device.seedFile('note.md', 'body\n', 1000);
    const reconcile = vi.spyOn(h.device.registry, 'reconcileWithVault');
    const clearOps = vi.spyOn(h.device.opLogger, 'clearOps');

    await h.coordinator.reset(async () => true);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(clearOps).not.toHaveBeenCalled();           // the S3 guarantee
    expect(h.device.pendingOps.length).toBeGreaterThan(0); // change re-captured, not dropped
  });

  test('rebaseline: confirm=true captures all then runs a manual sync; confirm=false does neither', async () => {
    const yes = await harness();
    await yes.device.seedFile('note.md', 'body\n', 1000);
    const captureAll = vi.spyOn(yes.device.opLogger, 'captureAllAsBaseline');
    const runManual = vi.fn(async () => {});
    await yes.coordinator.rebaseline(async () => true, runManual);
    expect(captureAll).toHaveBeenCalledOnce();
    expect(runManual).toHaveBeenCalledOnce();

    const no = await harness();
    const captureAllNo = vi.spyOn(no.device.opLogger, 'captureAllAsBaseline');
    const runManualNo = vi.fn(async () => {});
    await no.coordinator.rebaseline(async () => false, runManualNo);
    expect(captureAllNo).not.toHaveBeenCalled();
    expect(runManualNo).not.toHaveBeenCalled();
  });
});
