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

export type SyncSource = 'manual' | 'auto';

/** The result of a round, so the plugin can drive the ribbon (idle/conflict/error)
 *  without the coordinator knowing anything about Obsidian UI. */
export interface SyncOutcome {
  ok: boolean;
  summary?: SyncRoundSummary;
  error?: Error;
}

/** Interactive resolvers — the plugin's modal wrappers. Only invoked on a manual
 *  round; an auto round defers before ever reaching them. */
export type InteractiveContentResolver =
  (action: Extract<MergeAction, { type: 'conflict' }>) => Promise<Uint8Array | null>;
export type InteractiveDeleteResolver =
  (action: Extract<MergeAction, { type: 'delete_conflict' }>) => Promise<'keep_deleted' | 'restore'>;
export type InteractiveBinaryResolver =
  (action: Extract<MergeAction, { type: 'binary_conflict' }>) => Promise<'keep_local' | 'keep_remote'>;

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
      await this.recordRoundOutcome(summary);
      await this.syncState.clearError();
      await this.markSynced();

      if (source === 'manual') this.notifier.info('✅ Vault sync complete');
      return { ok: true, summary };
    } catch (err) {
      const error = err as Error;
      console.error('Vault Sync error:', error);
      this.notifier.error(`❌ Sync failed: ${error.message}`);
      await this.syncState.setError(error.message, this.now());
      return { ok: false, error };
    }
  }

  /** Number of conflicts the user still needs to resolve — drives ribbon/status. */
  outstandingConflictCount(): number {
    return this.syncState.get().outstandingConflicts.length;
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

  /**
   * Content conflict. Auto → record it outstanding and defer (hold the cursor, S5).
   * Manual → run the interactive resolver; a skip (null) is recorded outstanding so
   * it stays visible/re-openable, a real resolution clears any prior entry.
   */
  async decideContentConflict(
    action: Extract<MergeAction, { type: 'conflict' }>,
    interactive: InteractiveContentResolver,
  ): Promise<Uint8Array | null | DeferConflict> {
    if (this.currentSource === 'auto') {
      await this.syncState.recordConflict({ fileId: action.fileId, path: action.localPath, kind: 'content', firstSeen: this.now() });
      return DEFER_CONFLICT;
    }
    const resolved = await interactive(action);
    if (resolved === null) {
      await this.syncState.recordConflict({ fileId: action.fileId, path: action.localPath, kind: 'content', firstSeen: this.now() });
    } else {
      await this.syncState.clearConflict(action.fileId);
    }
    return resolved;
  }

  /**
   * Delete/modify conflict. A non-`ask` strategy is the user's standing policy and
   * runs unattended in either mode. `ask` under auto defers; `ask` under manual runs
   * the modal. Either way a decision clears any outstanding entry.
   */
  async decideDeleteConflict(
    strategy: 'ask' | 'keep_deleted' | 'restore',
    action: Extract<MergeAction, { type: 'delete_conflict' }>,
    interactive: InteractiveDeleteResolver,
  ): Promise<'keep_deleted' | 'restore' | DeferConflict> {
    if (strategy === 'ask' && this.currentSource === 'auto') {
      await this.syncState.recordConflict({ fileId: action.fileId, path: action.path, kind: 'delete', firstSeen: this.now() });
      return DEFER_CONFLICT;
    }
    const decision = strategy !== 'ask' ? strategy : await interactive(action);
    await this.syncState.clearConflict(action.fileId);
    return decision;
  }

  /** Binary conflict. Auto → record + defer; manual → run the modal, then clear. */
  async decideBinaryConflict(
    action: Extract<MergeAction, { type: 'binary_conflict' }>,
    interactive: InteractiveBinaryResolver,
  ): Promise<'keep_local' | 'keep_remote' | DeferConflict> {
    if (this.currentSource === 'auto') {
      await this.syncState.recordConflict({ fileId: action.fileId, path: action.localPath, kind: 'binary', firstSeen: this.now() });
      return DEFER_CONFLICT;
    }
    const decision = await interactive(action);
    await this.syncState.clearConflict(action.fileId);
    return decision;
  }

  /** Fold a completed round's summary into the persisted sync-state (S2): the
   *  one-line last-sync record plus the deferred/stranded lists, resolving raw
   *  fileIds/hashes to vault paths for display. */
  private async recordRoundOutcome(summary: SyncRoundSummary): Promise<void> {
    const at = this.now();
    const deferred = summary.deferred.map(fileId => ({
      fileId,
      path: this.registry.getById(fileId)?.path ?? fileId,
      reason: 'drift' as const,
      at,
    }));
    const stranded = summary.stranded.map(contentHash => ({ contentHash, at }));
    await this.syncState.setRound(
      { at, pushed: summary.pushed, pulled: summary.pulled, conflicts: this.outstandingConflictCount() },
      deferred,
      stranded,
    );
  }
}
