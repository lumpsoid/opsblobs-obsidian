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
import { TestDevice } from './helpers/test-device';

const EMPTY_SUMMARY: SyncRoundSummary = { pushed: 0, pulled: 0, deferred: [], stranded: [], deferredConflicts: [] };

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
    const h = await harness({ summary: { pushed: 2, pulled: 3, deferred: [id], stranded: ['hashY'], deferredConflicts: [] } });
    await h.syncState.setError('stale failure', 1); // a leftover error from a previous round

    await h.coordinator.sync('manual');

    const state = h.syncState.get();
    expect(state.lastError).toBeNull();                       // cleared on success
    expect(state.lastSync).toMatchObject({ pushed: 2, pulled: 3, at: 5000 });
    expect(state.deferred).toEqual([{ fileId: id, path: id, reason: 'drift', at: 5000 }]);
    expect(state.stranded).toEqual([{ contentHash: 'hashY', at: 5000 }]);
  });

  test('manual sync toasts success; auto sync stays silent', async () => {
    const manual = await harness();
    await manual.coordinator.sync('manual');
    expect(manual.notifier.info).toHaveBeenCalledWith('Vault sync complete');

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

  test('deferred conflicts are tagged reason:conflict and counted; drift is not (Step 7)', async () => {
    // Step 7: no hand-maintained badge. A round's `deferredConflicts` (delete/binary
    // auto-defers) are folded into the observable `deferred` list with reason
    // 'conflict'; F5 drift lands as reason 'drift'. `deferredConflictCount()` — the
    // derived count the plugin's badge reads — reflects only the conflicts, and a
    // later round that no longer defers them clears the count with no clear/self-heal.
    const h = await harness({
      summary: { pushed: 0, pulled: 2, deferred: ['fConf', 'fDrift'], stranded: [], deferredConflicts: ['fConf'] },
    });

    await h.coordinator.sync('manual');

    const deferred = h.syncState.get().deferred;
    expect(deferred.find(d => d.fileId === 'fConf')!.reason).toBe('conflict');
    expect(deferred.find(d => d.fileId === 'fDrift')!.reason).toBe('drift');
    expect(h.coordinator.deferredConflictCount()).toBe(1);        // only the conflict
    expect(h.syncState.get().lastSync?.conflicts).toBe(1);

    // A subsequent round that defers nothing (the conflict resolved) replaces the
    // list wholesale — the count drops to zero on its own, no bookkeeping.
    h.runRound.mockResolvedValueOnce(EMPTY_SUMMARY);
    await h.coordinator.sync('manual');
    expect(h.coordinator.deferredConflictCount()).toBe(0);
  });

  test('auto delete conflict defers only for the ask strategy; a standing policy runs unattended', async () => {
    const h = await harness();
    h.coordinator.setSource('auto');
    const action = { type: 'delete_conflict', fileId: 'f3', path: 'c.md', side: 'remote_deleted', content: new Uint8Array() } as Extract<MergeAction, { type: 'delete_conflict' }>;

    const deferred = await h.coordinator.decideDeleteConflict('ask', action, async () => 'restore');
    expect(deferred).toBe(DEFER_CONFLICT);

    // A non-ask policy is the user's standing choice → applied even under auto.
    const policy = await h.coordinator.decideDeleteConflict('keep_deleted', action, async () => 'restore');
    expect(policy).toBe('keep_deleted');
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
