// ─────────────────────────────────────────────
//  SyncCoordinator  (obsidian-free orchestration)
// ─────────────────────────────────────────────
//
//  The orchestration that used to live inside the `VaultSyncPlugin` Obsidian
//  subclass — extracted so it is unit-testable without a real Obsidian runtime.
//  It owns the *decisions* of a sync round (the pre-sync capture sequence, folding
//  the round summary into the observable sync-state, the manual/auto conflict
//  branching, and the reset/rebaseline sequences); the plugin keeps only the
//  Obsidian glue (guards, ribbon/status rendering, modal construction, settings).
//
//  Everything Obsidian-coupled is injected behind a narrow interface:
//    · EditorSaver / Notifier    — thin ports (obsidian adapters in prod)
//    · runRound                  — builds+runs a ServerSyncClient (the plugin wires
//                                  HttpServerApi/crypto/host), returns its summary
//    · persistHlc / markSynced   — post-round durability + settings side effects
//  so this module imports no `obsidian` and can be driven with fakes.

import { MergeAction } from '../types';
import { HybridLogicalClock } from '../core/hlc';
import { OperationLogger } from '../core/operation-logger';
import { FileRegistry } from '../core/file-registry';
import { EditorSaver } from '../ports/editor-saver';
import { Notifier } from '../ports/notifier';
import { SyncStateStore } from './sync-state-store';
import { SyncRoundSummary } from './server-sync';
import { DEFER_CONFLICT, DeferConflict } from './sync-applicator';
import { isSetupError } from './sync-errors';
// The interactive resolvers may now themselves defer (the modal's "Decide later" /
// dismiss path, §3), so their result type includes DeferConflict.

export type SyncSource = 'manual' | 'auto';

/** The result of a round, so the plugin can drive the ribbon (idle/conflict/error)
 *  without the coordinator knowing anything about Obsidian UI. */
export interface SyncOutcome {
  ok: boolean;
  summary?: SyncRoundSummary;
  error?: Error;
}

/** Interactive resolvers — the plugin's modal wrappers. Only invoked on a manual
 *  round; an auto round defers before ever reaching them. A text `conflict` has no
 *  resolver: it is surfaced non-blockingly as inline markers (sync v2 Step 5) and
 *  resolved by the next ordinary save, never a modal. */
export type InteractiveDeleteResolver =
  (action: Extract<MergeAction, { type: 'delete_conflict' }>) => Promise<'keep_deleted' | 'restore' | DeferConflict>;
export type InteractiveBinaryResolver =
  (action: Extract<MergeAction, { type: 'binary_conflict' }>) => Promise<'keep_local' | 'keep_remote' | DeferConflict>;

export interface SyncCoordinatorDeps {
  editorSaver: EditorSaver;
  notifier: Notifier;
  opLogger: OperationLogger;
  syncState: SyncStateStore;
  hlc: HybridLogicalClock;
  registry: FileRegistry;
  /** Build + run one sync round, returning its summary. The plugin wires the real
   *  transport (HttpServerApi/crypto/host); tests stub it. */
  runRound: () => Promise<SyncRoundSummary>;
  /** Persist logical time after a round (F7). Optional — defaults to a no-op. */
  persistHlc?: () => Promise<void>;
  /** Record a successful round in settings (lastSyncTime). Optional — no-op default. */
  markSynced?: () => Promise<void>;
  /** Open the plugin's settings tab — attached to the durable notice a setup-class
   *  error raises (§5), so the toast is actionable. Optional — omitted in tests. */
  openSettings?: () => void;
  /** Wall clock, injected for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export class SyncCoordinator {
  private readonly editorSaver: EditorSaver;
  private readonly notifier: Notifier;
  private readonly opLogger: OperationLogger;
  private readonly syncState: SyncStateStore;
  private readonly hlc: HybridLogicalClock;
  private readonly registry: FileRegistry;
  private readonly runRound: () => Promise<SyncRoundSummary>;
  private readonly persistHlc: () => Promise<void>;
  private readonly markSynced: () => Promise<void>;
  private readonly openSettings?: () => void;
  private readonly now: () => number;

  /** Source of the round currently running — read by the applicator's conflict
   *  handlers (via the `decide*` methods) so an unattended `'auto'` round defers
   *  instead of blocking on a modal (S5). Set at the start of every `sync()`. */
  private currentSource: SyncSource = 'manual';

  constructor(deps: SyncCoordinatorDeps) {
    this.editorSaver = deps.editorSaver;
    this.notifier = deps.notifier;
    this.opLogger = deps.opLogger;
    this.syncState = deps.syncState;
    this.hlc = deps.hlc;
    this.registry = deps.registry;
    this.runRound = deps.runRound;
    this.persistHlc = deps.persistHlc ?? (async () => {});
    this.markSynced = deps.markSynced ?? (async () => {});
    this.openSettings = deps.openSettings;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The source of the in-flight round (for the plugin's conflict-handler closures). */
  get source(): SyncSource {
    return this.currentSource;
  }

  setSource(source: SyncSource): void {
    this.currentSource = source;
  }

  /**
   * One sync round's testable core. The plugin's `triggerSync` keeps the Obsidian
   * guards (reentrancy/config/crypto) and ribbon transitions around this call.
   *
   * Ordering is load-bearing and mirrors the pre-refactor `triggerSync`:
   *   1. capture every just-made edit (editor buffers → disk → op) BEFORE the round,
   *      so an edit-then-immediately-sync isn't stranded (S1);
   *   2. run the round;
   *   3. persist the HLC (F7), fold the summary into the sync-state, clear the last
   *      error, mark the settings' lastSyncTime.
   * On failure it records the error into the observable state and toasts it, but
   * never clears the error or pending ops — the un-pushed work survives for retry.
   */
  async sync(source: SyncSource): Promise<SyncOutcome> {
    this.currentSource = source;
    try {
      // S1: force-save editors → flush armed debounce timers → capture on-disk drift.
      await this.editorSaver.saveOpenEditors();
      await this.opLogger.flush();
      await this.opLogger.captureOfflineChanges();

      const summary = await this.runRound();

      await this.persistHlc();
      // No badge to clear on convergence anymore (Step 7): "conflicts" is derived —
      // text conflicts are the registry's two-headed files, and delete/binary
      // auto-defers are just this round's `deferredConflicts`, replaced wholesale
      // below. A conflict that resolved automatically simply stops appearing.
      await this.recordRoundOutcome(summary);
      await this.syncState.clearError();
      await this.markSynced();

      if (source === 'manual') this.notifier.info('Sync complete');
      return { ok: true, summary };
    } catch (err) {
      const error = err as Error;
      console.error('Vault Sync error:', error);
      // Setup-class failures (auth/vault/passphrase) are the user's to fix and need a
      // durable, actionable surface (§5); transient transport errors self-retry, so a
      // fading toast is right for them. Either way the error is recorded in the
      // observable sync-state for the status modal.
      if (isSetupError(error)) {
        this.notifier.setupError(
          error.message,
          this.openSettings ? { label: 'Open settings', run: this.openSettings } : undefined,
        );
      } else {
        this.notifier.error(`Sync failed: ${error.message}`);
      }
      await this.syncState.setError(error.message, this.now());
      return { ok: false, error };
    }
  }

  /** Delete/binary conflicts an unattended auto-round deferred and that still need a
   *  manual sync — a *derived* count over the last round's observable state (no
   *  hand-maintained set, Step 7). Text conflicts are the two-headed files, counted
   *  separately by the plugin from the registry. */
  deferredConflictCount(): number {
    return this.syncState.get().deferred.filter(d => d.reason === 'conflict').length;
  }

  /**
   * Rebuild sync metadata non-destructively (S3): reconcile the registry with the
   * vault, then re-capture every on-disk file as ops (never `clearOps`, which would
   * silently drop un-synced changes). Confirms first when un-synced ops exist — the
   * plugin's `confirm` shows a modal built from the pending count passed to it.
   */
  async reset(confirm: (pendingCount: number) => Promise<boolean>): Promise<void> {
    const pending = this.opLogger.getPendingOps().length;
    if (pending > 0 && !(await confirm(pending))) return;
    await this.registry.reconcileWithVault(this.hlc.now());
    await this.opLogger.captureOfflineChanges();
  }

  /**
   * Re-baseline this device to the server (S4): after an explicit confirm, emit an
   * op for every live file (even unchanged ones) then run a normal round, so a
   * drifted/rebuilt server is reconstructed from this client. `runManualSync` is the
   * plugin's full `triggerSync('manual')` so the round gets the same guards/ribbon as
   * any manual sync.
   */
  async rebaseline(
    confirm: () => Promise<boolean>,
    runManualSync: () => Promise<void>,
  ): Promise<void> {
    if (!(await confirm())) return;
    await this.opLogger.captureAllAsBaseline();
    await runManualSync();
  }

  // ─── Conflict decisions (manual: delegate to a modal · auto: defer) ──────────
  //
  // A text `conflict` has no decision here — the applicator writes inline markers
  // non-blockingly and the next ordinary save resolves it (sync v2 Step 5). Only the
  // choice-based delete/binary conflicts still route through a modal (manual) or
  // defer (auto).

  //
  // No badge bookkeeping here anymore (Step 7): an auto-defer is surfaced by the
  // round's `deferredConflicts` (the applicator tags it), and a resolution simply
  // stops the file re-appearing. These methods only decide defer-vs-resolve.

  /**
   * Delete/modify conflict. A non-`ask` strategy is the user's standing policy and
   * runs unattended in either mode. `ask` under auto defers (the applicator holds
   * the cursor + tags it a conflict); `ask` under manual runs the modal.
   */
  async decideDeleteConflict(
    strategy: 'ask' | 'keep_deleted' | 'restore',
    action: Extract<MergeAction, { type: 'delete_conflict' }>,
    interactive: InteractiveDeleteResolver,
  ): Promise<'keep_deleted' | 'restore' | DeferConflict> {
    if (strategy === 'ask' && this.currentSource === 'auto') return DEFER_CONFLICT;
    return strategy !== 'ask' ? strategy : interactive(action);
  }

  /** Binary conflict. Auto → defer (cursor held, tagged a conflict); manual → modal. */
  async decideBinaryConflict(
    action: Extract<MergeAction, { type: 'binary_conflict' }>,
    interactive: InteractiveBinaryResolver,
  ): Promise<'keep_local' | 'keep_remote' | DeferConflict> {
    if (this.currentSource === 'auto') return DEFER_CONFLICT;
    return interactive(action);
  }

  /** Fold a completed round's summary into the persisted sync-state (S2): the
   *  one-line last-sync record plus the deferred/stranded lists, resolving raw
   *  fileIds/hashes to vault paths for display. */
  private async recordRoundOutcome(summary: SyncRoundSummary): Promise<void> {
    const at = this.now();
    // Tag each deferral drift-vs-conflict from the applicator's `deferredConflicts`
    // subset, so the UI can label them and count only the conflicts (Step 7).
    const conflictIds = new Set(summary.deferredConflicts);
    const deferred = summary.deferred.map(fileId => ({
      fileId,
      path: this.registry.getById(fileId)?.path ?? fileId,
      reason: (conflictIds.has(fileId) ? 'conflict' : 'drift') as 'drift' | 'conflict',
      at,
    }));
    const stranded = summary.stranded.map(contentHash => ({ contentHash, at }));
    await this.syncState.setRound(
      { at, pushed: summary.pushed, pulled: summary.pulled, conflicts: summary.deferredConflicts.length },
      deferred,
      stranded,
    );
  }
}
