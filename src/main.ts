// ─────────────────────────────────────────────
//  Obsidian OpsBlobs — Main Plugin Entry
// ─────────────────────────────────────────────

import { Plugin, Notice, addIcon } from 'obsidian';
import { SyncSettings, DEFAULT_SETTINGS } from './types';
import { HybridLogicalClock } from './core/hlc';
import { FileRegistry } from './core/file-registry';
import { ContentStore } from './core/content-store';
import { randomUuid } from './core/encoding';
import { OperationLogger } from './core/operation-logger';
import { runAppendBench, formatAppendBench } from './core/append-bench';
import { SyncApplicator } from './network/sync-applicator';
import { ObsidianVaultFiles } from './network/obsidian-vault-files';
import { ObsidianMetadataStore } from './network/obsidian-metadata-store';
import { ObsidianVaultWatcher } from './network/obsidian-vault-watcher';
import { VaultCrypto, saltForVault } from './network/encryption';
import { ServerSyncClient, SyncRoundSummary } from './network/server-sync';
import { PhaseTimer, PhaseTimingSink, heapNote } from './network/perf-timer';
import { KeyMismatchError } from './network/sync-errors';
import { HttpServerApi } from './network/server-http';
import { CursorStore } from './network/cursor-store';
import { VersionDagStore } from './network/version-dag-store';
import { VaultBindingStore } from './network/vault-binding-store';
import { HlcStore } from './network/hlc-store';
import { SyncStateStore } from './network/sync-state-store';
import { PluginVaultSyncHost } from './network/vault-sync-host';
import { SyncStatusModal } from './ui/sync-status-modal';
import { ConfirmModal } from './ui/confirm-modal';
import { SyncSettingTab } from './ui/settings-tab';
import { SyncCoordinator, SyncOutcome } from './network/sync-coordinator';
import { ObsidianEditorSaver } from './network/obsidian-editor-saver';
import { ObsidianNotifier } from './network/obsidian-notifier';
import { ConflictsView, CONFLICTS_VIEW_TYPE, ConflictsViewHost } from './ui/conflicts-view';
import { PerfLogView, PERF_LOG_VIEW_TYPE, PerfLogViewHost } from './ui/perf-log-view';
import { PendingChangesView, PENDING_CHANGES_VIEW_TYPE, PendingChangesViewHost } from './ui/pending-changes-view';
import { listTwoHeadedConflicts, ConflictListItem } from './core/conflict-inventory';

// ─── Ribbon icon SVG ────────────────────────────────────────────────────────
/** Above this file count, a first-enable capture surfaces indexing progress in the
 *  status bar (and a notice) so a minutes-long pass doesn't look like a freeze. */
const CAPTURE_PROGRESS_UI_MIN = 500;

/** The perf log (perf baseline, Layer 3). A dotfolder, so effectively unreachable
 *  through the iOS Files app — {@link PerfLogView} surfaces it as an in-app tab. */
const PERF_LOG_PATH = '.opsblobs/perf-log.txt';

const SYNC_ICON_ID = 'vault-sync-icon';
const SYNC_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>`;

/**
 * Collapses the sync client's per-phase `onProgress` labels — which carry live
 * per-batch counters, e.g. "Downloading files 3/57…" — down to one of a handful of
 * coarse phase names. The desktop status bar is continuously visible, so a raw label
 * would repaint it on every batch; a coarse phase is enough of a gesture that a round
 * is progressing, and `setStatusBarText`'s exact-match guard then skips the DOM write
 * entirely between batches of the same phase. Fine-grained detail (counts included)
 * still reaches the status modal via {@link VaultSyncPlugin.syncActivity}.
 */
function coarseSyncPhase(label: string): string {
  if (label.startsWith('Rebuilding')) return 'Rebuilding…';
  if (label.startsWith('Pulling') || label.startsWith('Downloading')) return 'Pulling…';
  if (label.startsWith('Pushing') || label.startsWith('Uploading')) return 'Pushing…';
  if (label.startsWith('Merging')) return 'Merging…';
  if (label.startsWith('Applying')) return 'Applying…';
  if (label.startsWith('Reconciling')) return 'Reconciling…';
  return 'Syncing…';
}

export default class VaultSyncPlugin extends Plugin {
  settings!: SyncSettings;
  private hlc!: HybridLogicalClock;
  private hlcStore!: HlcStore;
  private registry!: FileRegistry;
  private contentStore!: ContentStore;
  private metadata!: ObsidianMetadataStore;
  private vaultFiles!: ObsidianVaultFiles;
  private opLogger!: OperationLogger;
  private applicator!: SyncApplicator;
  private syncState!: SyncStateStore;
  private coordinator!: SyncCoordinator;
  private crypto = new VaultCrypto();

  private ribbonIcon: HTMLElement | null = null;
  /** The ribbon's current visual state — read by its click handler so an error-state
   *  click opens details (matching its tooltip) instead of firing a sync (§5). */
  private ribbonState: 'idle' | 'syncing' | 'conflict' | 'error' = 'idle';
  private statusBarItem: HTMLElement | null = null;
  private statusBarText = '';
  private syncInProgress = false;
  /** True only while the one-time startup offline-changes scan (before
   *  `opLogger.startListening()`) is running. Not covered by `syncInProgress` — that
   *  flag is set/cleared inside `triggerSync` and this scan runs outside it — so
   *  `triggerSync` and `isSyncing()` check this separately to keep a "Sync now" click
   *  during this window from racing a second, concurrent `captureOfflineChanges()`
   *  pass against the same registry/oplog state. */
  private startupCaptureInProgress = false;
  private autoSyncHandle: number | null = null;
  /** Live progress of the first-enable capture (building the local DAG), or null when
   *  it isn't running. Surfaced in the status modal so a minutes-long first pass shows
   *  how far along it is. Only set for a *large* capture (see CAPTURE_PROGRESS_UI_MIN). */
  private indexingProgress: { scanned: number; total: number } | null = null;
  /** The current phase of an in-flight sync round ("Pulling changes…", "Uploading
   *  files 340/8000…", "Merging…"), or null when no round is running. Fed by the sync
   *  client's per-phase `onProgress`; surfaced in the status modal so a long round — the
   *  first sync can run for minutes — reads as progressing, not frozen. Unlike the
   *  desktop status bar (see {@link coarseSyncPhase}), this keeps the full per-batch
   *  counters — it's the fine-grained surface, and it's the only progress surface on
   *  mobile, where the status bar doesn't exist. */
  private syncActivity: string | null = null;
  /** Live progress of the first-sync blob upload (pushing note content to the server),
   *  or null when no push is uploading. Drives a determinate bar in the status modal;
   *  the phase label in {@link syncActivity} carries the same counts as text. */
  private uploadProgress: { uploaded: number; total: number } | null = null;
  /** Aborts the in-flight first-enable capture when the plugin is disabled/unloaded.
   *  The capture walks every vault file (O(F·B) hashing) and can run for minutes on a
   *  large mobile vault; without this it would run to completion after the user has
   *  already disabled the plugin. Tripped in `onunload`, checked at the top of the
   *  capture loop, which then persists its partial progress and returns early. */
  private captureAbort = new AbortController();

  /** Subscribers (the conflicts panel) to notify when the two-headed set may have
   *  changed — an op recorded/cleared, or a sync round finished. `opLogger.onChange`
   *  allows only one listener, so the plugin fans out through this set. */
  private conflictChangeListeners = new Set<() => void>();

  /** Delete/binary conflicts an unattended auto-round deferred and that still need a
   *  manual sync — a *derived* count over the last round's observable state (Step 7),
   *  not a hand-maintained badge. Text conflicts are the two-headed files below. */
  private deferredConflictCount(): number {
    return this.coordinator.deferredConflictCount();
  }

  /** The two-headed files a text conflict left awaiting resolution (Step 6). A
   *  derived query over the registry — no hand-maintained set. */
  private twoHeadedConflicts(): ConflictListItem[] {
    return listTwoHeadedConflicts(this.registry.getAllEntries().values());
  }

  /** Total conflicts needing the user: two-headed text files (derived from the
   *  registry) + auto-deferred delete/binary conflicts (derived from the last
   *  round). Both are derived queries now (Step 7) — no hand-maintained set. Drives
   *  the ribbon "needs attention" state and the status bar. */
  private conflictCount(): number {
    return this.twoHeadedConflicts().length + this.deferredConflictCount();
  }

  private emitConflictChange(): void {
    for (const cb of this.conflictChangeListeners) cb();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();
    this.ensureDeviceId();

    addIcon(SYNC_ICON_ID, SYNC_ICON_SVG);

    // Initialize core components
    const metadata = new ObsidianMetadataStore(this.app);
    this.metadata = metadata;
    // Seed the clock from the persisted HLC (F7) so locally-issued logical time
    // never regresses below what this device already emitted, even if the wall
    // clock jumped backward while we were off. `now()` takes max(wall,
    // current.wallTime), so a regressed wall still advances the counter above the
    // seed rather than rewinding. A fresh device has no persisted state → start clean.
    this.hlcStore = new HlcStore(metadata);
    const persistedHlc = await this.hlcStore.load();
    this.hlc = new HybridLogicalClock(this.settings.deviceId, persistedHlc ?? undefined);
    const vaultFiles = new ObsidianVaultFiles(this.app);
    this.vaultFiles = vaultFiles;
    this.registry = new FileRegistry(metadata, vaultFiles, this.settings.deviceId, () => this.settings);
    this.contentStore = new ContentStore(metadata);
    const watcher = new ObsidianVaultWatcher(this.app);
    this.opLogger = new OperationLogger(
      vaultFiles,
      watcher,
      metadata,
      this.hlc,
      this.registry,
      this.contentStore,
      () => this.settings,
      this.settings.debounceMs,
      this.hlcStore, // persist the HLC after each op (F7)
      new ObsidianNotifier(), // non-blocking notice when a save still has markers (Step 5)
    );

    this.applicator = new SyncApplicator(
      vaultFiles,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.hlc,
      // A text conflict is surfaced non-blockingly as inline markers by the applicator
      // (sync v2 Step 5) — no handler. Delete/binary conflicts no longer open a blocking
      // modal (§3, "full inline"): the coordinator defers them to the Conflicts panel and
      // consumes the decision the user records there on a later round. No Obsidian modal
      // is wired here anymore — the panel is the resolution surface.
      (action) =>
        this.coordinator.decideDeleteConflict(
          this.settings.deleteConflictStrategy,
          action,
        ),
      (action) => this.coordinator.decideBinaryConflict(action),
    );

    // Load persisted state
    this.syncState = new SyncStateStore(metadata);
    await this.syncState.load();
    // Cold-load of the persisted stores (perf baseline B3, Layer 3): timed as one
    // `startup:load` phase when the `perfLog` diagnostic is on, untimed otherwise.
    await this.timedStartup('load', async () => {
      await this.contentStore.init();
      await this.registry.load();
      await this.opLogger.load();
    });

    // The obsidian-free orchestrator: owns the capture sequence, the round
    // outcome bookkeeping, the manual/auto conflict branching, and reset/rebaseline.
    // The plugin keeps only the Obsidian glue (guards, ribbon, modals, settings).
    this.coordinator = new SyncCoordinator({
      editorSaver: new ObsidianEditorSaver(this.app),
      notifier: new ObsidianNotifier(),
      opLogger: this.opLogger,
      syncState: this.syncState,
      hlc: this.hlc,
      registry: this.registry,
      runRound: () => this.runRound(),
      openSettings: () => this.openSettings(),
      persistHlc: () => this.hlcStore.save(this.hlc.getCurrent()),
      markSynced: async () => {
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
      },
    });

    // Defer the first reconciliation until the workspace layout is ready:
    // `app.vault.getFiles()` is NOT reliably populated during `onload`, and
    // diffing the registry against an empty/partial listing would mark every
    // tracked file "vanished while offline" and emit a phantom delete for the
    // whole vault — which then propagates to every peer (silent data loss).
    // `onLayoutReady` runs the callback immediately if the layout is already up.
    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        // Reconcile registry with current vault AND emit ops for anything that
        // changed while we weren't listening — crucially, the files already
        // present on a first enable (no create event ever fires for them).
        // Without this the existing vault would never be pushed; only post-enable
        // edits would sync. (The engine also guards an empty listing as a
        // belt-and-suspenders phantom-delete backstop.)
        // The first-enable capture — the O(F·B) hash + up to O(F²) registry rewrite
        // over every pre-existing file (perf baseline B3). On a large vault this can
        // run for many minutes on mobile, so under perfLog it streams scan progress
        // (not just a single on-completion timing, which a still-running phase never
        // reaches). `captureOfflineWithPerf` also runs the bounded reconcile passes
        // (docs/startup-capture-live-edits-spec.md) that pick up edits made *during*
        // this window, before the real listener attaches below — so this flag (and
        // the try/finally) must wrap that whole sequence, not just the main pass.
        this.startupCaptureInProgress = true;
        try {
          await this.captureOfflineWithPerf();
        } finally {
          this.startupCaptureInProgress = false;
        }
        // Start listening for vault changes.
        this.opLogger.startListening();
      })();
    });

    // Derive the vault key up front so auto-sync can run unattended.
    await this.tryDeriveVaultKey();

    // ── UI ─────────────────────────────────────────────────────────────────
    // The non-blocking conflicts panel (Step 6). Registered before the ribbon so a
    // restored leaf of this type re-attaches to a live host.
    this.registerView(CONFLICTS_VIEW_TYPE, leaf => new ConflictsView(leaf, this.conflictsHost()));
    // The perf log viewer (Layer 3) — an in-app tab over the otherwise iOS-unreachable
    // `.opsblobs/perf-log.txt`. Registered so a restored leaf re-attaches to a live host.
    this.registerView(PERF_LOG_VIEW_TYPE, leaf => new PerfLogView(leaf, this.perfLogHost()));
    // The pending-changes panel (status-modal redesign) — full pending/deferred/stranded
    // detail behind the modal's one-line summary. Registered so a restored leaf re-attaches.
    this.registerView(PENDING_CHANGES_VIEW_TYPE, leaf => new PendingChangesView(leaf, this.pendingChangesHost()));

    this.ribbonIcon = this.addRibbonIcon(SYNC_ICON_ID, 'OpsBlobs', () => {
      // In the error state the tooltip promises "click for details" — honor that by
      // opening the status modal instead of silently firing another sync (§5).
      if (this.ribbonState === 'error') this.openSyncStatus();
      else void this.triggerSync('manual');
    });
    // Reflect any conflicts left outstanding from a previous session immediately.
    this.updateRibbonState(this.conflictCount() > 0 ? 'conflict' : 'idle');

    this.statusBarItem = this.addStatusBarItem();
    // The status item is clickable — a conflict badge opens the panel, otherwise it
    // triggers a sync (the same as the ribbon).
    this.statusBarItem.addClass('mod-clickable');
    this.statusBarItem.addEventListener('click', () => {
      if (this.conflictCount() > 0) void this.activateConflictsView();
      else void this.triggerSync('manual');
    });
    this.updateStatusBar();
    // Flip the badge to "changes to sync" the moment a (debounced) edit is
    // recorded, without polling. During a round the progress handler owns the
    // badge and the round's own `clearOps` fires this too, so defer to the
    // post-round `updateStatusBar` and skip while a sync is in progress. Also fan out
    // to the conflicts panel: a resolving save emits a merge op through here, so the
    // panel drops the resolved card.
    this.opLogger.onChange(() => {
      this.emitConflictChange();
      if (!this.syncInProgress) this.updateStatusBar();
    });

    // ── Commands ───────────────────────────────────────────────────────────
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.triggerSync('manual'),
    });

    this.addCommand({
      id: 'view-sync-status',
      name: 'View sync status',
      callback: () => this.openSyncStatus(),
    });

    this.addCommand({
      id: 'open-conflicts-panel',
      name: 'Open conflicts',
      callback: () => { void this.activateConflictsView(); },
    });

    this.addCommand({
      id: 'open-perf-log',
      name: 'Open perf log',
      callback: () => { void this.activatePerfLogView(); },
    });

    this.addCommand({
      id: 'open-pending-changes',
      name: 'Open pending changes',
      callback: () => { void this.activatePendingChangesView(); },
    });

    // Diagnostic (A3 pack-writes): measure whether the native `append` is O(delta)
    // or a whole-file rewrite on this device — the load-bearing assumption the
    // pack-writes optimization rests on (docs/pack-writes-spec.md §6.1). Writes the
    // full timing split to perf-log.txt and shows the verdict in a Notice.
    this.addCommand({
      id: 'measure-append-cost',
      name: 'Measure append cost (diagnostic)',
      callback: () => { void this.measureAppendCost(); },
    });

    // ── Settings ───────────────────────────────────────────────────────────
    this.addSettingTab(new SyncSettingTab(this.app, this));

    // ── Auto-sync ──────────────────────────────────────────────────────────
    this.setupAutoSync();
  }

  onunload() {
    // Signal the in-flight first-enable capture to stop at its next loop iteration.
    // It persists what it has scanned so far (checkpoint-safe) and re-resumes on the
    // next enable — so disabling mid-capture on a large vault no longer keeps the
    // device hashing thousands of files after the user has walked away.
    this.captureAbort.abort();
    this.opLogger.stopListening();
    // Final HLC persist on shutdown (F7) so time issued since the last op/sync
    // survives the restart. Fire-and-forget — onunload can't await.
    void this.hlcStore.save(this.hlc.getCurrent()).catch(console.error);
    if (this.autoSyncHandle !== null) window.clearInterval(this.autoSyncHandle);
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<SyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private ensureDeviceId() {
    if (!this.settings.deviceId) {
      this.settings.deviceId = this.generateDeviceId();
      this.saveSettings().catch(console.error);
    }
  }

  private generateDeviceId(): string {
    return randomUuid();
  }

  // ─── Vault key (E2E) ────────────────────────────────────────────────────────

  /** Required-field labels currently missing, in setup order — the single source of
   *  truth for "what's left to configure". Empty means ready to sync. Includes the
   *  access token: a round can't authenticate without it, so naming it up front beats
   *  a mid-sync AuthError. */
  private missingConfigFields(): string[] {
    const missing: string[] = [];
    if (!this.settings.serverUrl) missing.push('Server URL');
    if (!this.settings.vaultId) missing.push('Vault ID');
    if (!this.settings.serverToken) missing.push('Access token');
    if (!this.settings.vaultPassphrase) missing.push('Vault passphrase');
    return missing;
  }

  private isServerConfigured(): boolean {
    return this.missingConfigFields().length === 0;
  }

  /** Open Obsidian's settings straight to the OpsBlobs tab, so the finish-setup
   *  notice is actionable instead of a dead end (UX audit §1.2). */
  private openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** A "you're not set up yet" notice that names the concrete fields still missing
   *  and links to the settings tab (UX audit §1.2). Replaces the old toast that
   *  hard-coded "a server and passphrase" regardless of what was actually absent. */
  private notifyMissingConfig(): void {
    const missing = this.missingConfigFields();
    const frag = createFragment(f => {
      f.appendText(`OpsBlobs: finish setup before syncing — still missing ${missing.join(', ')}.`);
      f.createEl('br');
      const link = f.createEl('a', { text: 'Open OpsBlobs settings', cls: 'vault-sync-notice-link' });
      link.addEventListener('click', () => this.openSettings());
    });
    new Notice(frag, 10000);
  }

  /**
   * Derive the at-rest vault key from the configured passphrase, salted by the
   * vaultId (deterministic across devices, so no separate salt to transfer). A
   * no-op with no passphrase configured; throws are the caller's to surface.
   */
  async applyVaultKey(): Promise<void> {
    if (!this.settings.vaultPassphrase || !this.settings.vaultId) {
      throw new Error('Set a server vault ID and passphrase first.');
    }
    const salt = await saltForVault(this.settings.vaultId);
    await this.crypto.deriveFromPassphrase(this.settings.vaultPassphrase, salt);
  }

  private async tryDeriveVaultKey(): Promise<void> {
    if (!this.settings.vaultPassphrase || !this.settings.vaultId) return;
    try {
      await this.applyVaultKey();
    } catch (err) {
      console.error('OpsBlobs: key derivation failed:', err);
    }
  }

  /** Fingerprint of the derived key, or null if none — shown in settings so two
   *  devices can confirm they share the same passphrase before trusting data. */
  vaultKeyFingerprint(): string | null {
    return this.crypto.isReady() ? this.crypto.fingerprint() : null;
  }

  // ─── Sync ─────────────────────────────────────────────────────────────────

  /** Build a ServerSyncClient wired to the real transport + local vault. The plugin
   *  owns this Obsidian-coupled wiring (HttpServerApi/host/progress); shared by the
   *  sync round and the settings "Test connection" preflight. */
  private buildSyncClient(): ServerSyncClient {
    const api = new HttpServerApi({
      baseUrl: this.settings.serverUrl,
      vaultId: this.settings.vaultId,
      token: this.settings.serverToken,
    });
    const host = new PluginVaultSyncHost(
      this.vaultFiles,
      this.settings.deviceId,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.applicator,
      this.hlc,
      new CursorStore(this.metadata),
      new VersionDagStore(this.metadata),
    );
    return new ServerSyncClient({
      api,
      crypto: this.crypto,
      host,
      hlc: this.hlc,
      onProgress: (label) => {
        // The desktop status bar (absent on mobile) is a continuously-visible strip —
        // it only ever shows which coarse phase the round is in, not the fine-grained
        // per-batch label (e.g. "Downloading files 3/57…"), which would otherwise
        // repaint it on every batch. Fine-grained detail belongs in the status modal.
        this.setStatusBarText(coarseSyncPhase(label), 'syncing');
        // … and the mobile-visible surface: the status modal's live section reads
        // the full, uncollapsed label.
        this.syncActivity = label;
      },
      onUploadProgress: (uploaded, total) => { this.uploadProgress = { uploaded, total }; },
      // Per-phase round timings (perf baseline, Layer 3) — `undefined` unless the
      // `perfLog` diagnostic is on, so the client installs no timer by default.
      perfLog: this.perfSink('round'),
    });
  }

  /**
   * A per-phase timing sink for the `perfLog` diagnostic (perf baseline, Layer 3),
   * or `undefined` when the setting is off — so callers install no timer at all and
   * the instrumented code stays inert. Emits each phase to the console and appends a
   * line to `.opsblobs/perf-log.txt` for a post-hoc read on-device. Fully guarded:
   * a diagnostics write must never break a sync.
   */
  private perfSink(scope: string): PhaseTimingSink | undefined {
    if (!this.settings.perfLog) return undefined;
    return (phase, ms) => {
      const line = `${Date.now()} ${scope} ${phase} ${ms.toFixed(1)}ms`;
      console.log(`[vault-sync perf] ${line}`);
      void this.metadata.append(PERF_LOG_PATH, line + '\n').catch(() => {});
    };
  }

  /** Time a single startup phase under the `perfLog` diagnostic (Layer 3), or run it
   *  untimed when off. Brackets just the awaited work, so idle time (e.g. waiting on
   *  `onLayoutReady`) is never mis-attributed. */
  private async timedStartup<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const sink = this.perfSink('startup');
    if (!sink) return fn();
    const t = new PhaseTimer(sink);
    try {
      return await fn();
    } finally {
      t.end(phase);
    }
  }

  /** On-device micro-benchmark for the pack-writes load-bearing question: is native
   *  `append` O(delta) or a whole-file rewrite? (docs/pack-writes-spec.md §6.1.) Runs
   *  the three probes, appends the full split to perf-log.txt (always — this is a
   *  deliberate measurement, not gated on the `perfLog` setting), and surfaces the
   *  verdict in a Notice so the result is readable on the phone without a file pull. */
  private async measureAppendCost(): Promise<void> {
    new Notice('OpsBlobs: measuring append cost… (this writes ~35 MB of scratch, then cleans up)', 6000);
    try {
      const result = await runAppendBench(this.metadata);
      const lines = formatAppendBench(result);
      // Console is the easiest surface to read on the current dev setup; also persist
      // to perf-log.txt for a post-hoc pull.
      console.log('[vault-sync] append-bench:\n' + lines.join('\n'));
      for (const line of lines) {
        await this.metadata.append(PERF_LOG_PATH, line + '\n').catch(() => {});
      }
      const verdict = (lines[0] ?? '').replace('append-bench VERDICT: ', '');
      new Notice(`OpsBlobs append-bench: ${verdict}`, 12000);
    } catch (e) {
      new Notice(`OpsBlobs append-bench failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  /** Run the first-enable capture — plus its live-edit reconcile passes
   *  (`captureOfflineChangesAndReconcile`, docs/startup-capture-live-edits-spec.md) —
   *  streaming scan progress to the `perfLog` diagnostic (Layer 3) so a long-running
   *  pass on a large vault yields the throughput curve instead of a single line that
   *  only prints if/when it finishes. Untimed and with no progress callback when the
   *  diagnostic is off. */
  private async captureOfflineWithPerf(): Promise<void> {
    const sink = this.perfSink('startup');
    const t0 = performance.now();
    // Sub-phase accumulators for the dominant `putMs` (A3 §3.2): the base64 encode
    // (in ContentStore.putBuffered) and the atomic-write ceremony's native sub-ops (in
    // ObsidianMetadataStore.write, scoped to content blobs). Armed only when the perf
    // sink is on so a normal enable pays nothing; read + logged + cleared after the pass.
    const putPerf = sink ? { encodeMs: 0 } : null;
    const writePerf = sink ? { writeMs: 0, writeTmpMs: 0, existsMs: 0, removeMs: 0, renameMs: 0 } : null;
    this.contentStore.capturePutPerf = putPerf;
    this.metadata.captureWritePerf = writePerf;
    // The `otherMs` sub-split (oplog-append-journal-spec §3 Step 1): attribute the
    // per-checkpoint registry+oplog rewrites — and, within each, serialize CPU vs native
    // write — so we cut the half that dominates and know if it's CPU or the bridge. Same
    // sink-gated arming as put/write perf, so a normal enable pays nothing.
    const oplogPerf = sink ? { stringifyMs: 0, writeMs: 0 } : null;
    const flushPerf = sink ? { stringifyMs: 0, writeMs: 0 } : null;
    this.opLogger.captureOplogPerf = oplogPerf;
    this.registry.captureFlushPerf = flushPerf;
    // Only surface a progress UI for a *large* first-enable — a routine capture (a
    // handful of changed files) fires the callback at most once and should stay quiet.
    // This one closure is reused for every pass `captureOfflineChangesAndReconcile`
    // runs (main + any reconcile passes) — `announced` therefore still fires the
    // notice at most once across the whole startup sequence, not once per pass.
    let announced = false;
    const passes = await this.opLogger.captureOfflineChangesAndReconcile((scanned, total) => {
      if (total > CAPTURE_PROGRESS_UI_MIN) {
        if (!announced) {
          announced = true;
          new Notice(`OpsBlobs: preparing ${total} files for first sync…`, 8000);
        }
        // The status bar is the always-visible surface; reflect indexing progress
        // there so the vault doesn't look frozen during a minutes-long capture.
        this.setStatusBarText(`Indexing ${scanned}/${total}…`, 'syncing');
        // The status modal is the inspectable surface — expose the same progress so a
        // user who opens it mid-capture sees how far along the first sync's DAG build is.
        this.indexingProgress = { scanned, total };
      }
      // Diagnostics (Layer 3): per-phase heap + timing only when perfLog is on.
      sink?.(`captureOfflineChanges ${scanned}/${total}${heapNote()}`, performance.now() - t0);
    }, this.captureAbort.signal);
    // Diagnostics (Layer 3): the read/hash/put phase split of the capture total, so
    // the first-enable cliff is attributed to the phase that dominates before we cut it
    // (docs/startup-capture-optimization-spec.md §3). `otherMs` = registry flush + base64
    // + loop overhead not in the three measured phases. Emitted only when perfLog is on.
    // `passes[0]` is the main pass; any further entries are reconcile passes over paths
    // touched while it was running (docs/startup-capture-live-edits-spec.md §2) — logged
    // per pass so a reconcile pass's cost is visible on its own, not folded into the
    // main pass's numbers (spec §5's open question on reconcile-loop timing).
    for (const [i, stats] of passes.entries()) {
      const label = i === 0 ? 'captureOfflineChanges' : `captureOfflineChanges reconcile#${i}`;
      sink?.(`${label} readMs (${stats.files} files)`, stats.readMs);
      sink?.(`${label} hashMs`, stats.hashMs);
      sink?.(`${label} putMs`, stats.putMs);
      // A3 pack-writes: the per-checkpoint pack + index appends that replaced the ~8389
      // per-blob writes. This is where the old ~50 s putMs write phase now lives (~1–2 s).
      sink?.(`${label} flushMs`, stats.flushMs);
      sink?.(`${label} otherMs`, stats.totalMs - stats.readMs - stats.hashMs - stats.putMs - stats.flushMs);
      // The otherMs split (oplog-append-journal-spec §3 Step 1): the two per-checkpoint
      // rewrites that make up otherMs, so both this spec and the registry one act on numbers.
      sink?.(`${label} regFlushMs`, stats.regFlushMs);
      sink?.(`${label} oplogSaveMs`, stats.oplogSaveMs);
      // The residual after attributing the two rewrites — expect ≈ 0, confirming the
      // checkpoint rewrites ARE the whole of otherMs (not hidden loop overhead).
      sink?.(`${label} otherResidualMs`, stats.totalMs - stats.readMs - stats.hashMs - stats.putMs - stats.flushMs - stats.regFlushMs - stats.oplogSaveMs);
      sink?.(`${label} total${heapNote()}`, stats.totalMs);
    }
    // The putMs sub-split (A3 §3.2): base64 encode (CPU) vs the atomic-write ceremony's
    // native adapter sub-ops. `putOtherMs` = memCache + buffer push + loop overhead not
    // in the five measured sub-phases. This decides whether the temp-write + rename
    // ceremony is worth replacing with a direct write for the disposable content store.
    // These accumulators are shared across every pass (armed once above, read once
    // here), so this is the total across the main pass AND any reconcile passes.
    if (putPerf && writePerf) {
      const { encodeMs } = putPerf;
      const { writeMs, writeTmpMs, existsMs, removeMs, renameMs } = writePerf;
      const totalPutMs = passes.reduce((sum, s) => sum + s.putMs, 0);
      sink?.(`captureOfflineChanges put.encodeMs`, encodeMs);
      sink?.(`captureOfflineChanges put.writeMs`, writeMs);           // C4 direct write
      sink?.(`captureOfflineChanges put.writeTmpMs`, writeTmpMs);     // atomic ceremony — now 0
      sink?.(`captureOfflineChanges put.existsMs`, existsMs);         // atomic ceremony — now 0
      sink?.(`captureOfflineChanges put.removeMs`, removeMs);         // atomic ceremony — now 0
      sink?.(`captureOfflineChanges put.renameMs`, renameMs);         // atomic ceremony — now 0
      sink?.(`captureOfflineChanges put.otherMs`, totalPutMs - encodeMs - writeMs - writeTmpMs - existsMs - removeMs - renameMs);
    }
    // The serialize-vs-write sub-split within each rewrite — decides whether the cost is
    // serialize CPU (quadratic JSON.stringify) or the MB-scale native write on the bridge.
    if (oplogPerf && flushPerf) {
      sink?.(`captureOfflineChanges oplog.stringifyMs`, oplogPerf.stringifyMs);
      sink?.(`captureOfflineChanges oplog.writeMs`, oplogPerf.writeMs);
      sink?.(`captureOfflineChanges reg.stringifyMs`, flushPerf.stringifyMs);
      sink?.(`captureOfflineChanges reg.writeMs`, flushPerf.writeMs);
    }
    sink?.(`captureOfflineChanges total (all passes)${heapNote()}`, passes.reduce((sum, s) => sum + s.totalMs, 0));
    // Disarm the diagnostics so nothing accumulates outside the capture pass.
    this.contentStore.capturePutPerf = null;
    this.metadata.captureWritePerf = null;
    this.opLogger.captureOplogPerf = null;
    this.registry.captureFlushPerf = null;
    // Capture done — the modal's indexing section clears itself once this reads null.
    this.indexingProgress = null;
    if (announced) {
      new Notice('OpsBlobs: vault prepared.', 4000);
      this.updateStatusBar();
    }
  }

  /** Build and run one sync round, returning its summary. The coordinator drives
   *  *when* this runs and what happens around it. */
  private runRound(): Promise<SyncRoundSummary> {
    return this.buildSyncClient().runSync();
  }

  /**
   * Non-mutating setup check for the settings "Test connection" button: derive the
   * key, then preflight the server + token + vault + passphrase. Returns a friendly
   * success line; a setup mistake throws one of the typed errors (whose message is
   * already user-actionable) so the button surfaces it before the first real round.
   */
  async testConnection(): Promise<string> {
    const missing = this.missingConfigFields();
    if (missing.length > 0) {
      throw new Error(`Finish setup first — still missing: ${missing.join(', ')}.`);
    }
    await this.applyVaultKey();
    const { keyState } = await this.buildSyncClient().preflight();
    if (keyState === 'mismatch') throw new KeyMismatchError();
    return keyState === 'match'
      ? 'Connected — server reachable, token accepted, and the passphrase matches this vault.'
      : 'Connected — server reachable and token accepted. The vault has no data yet; this device will establish the key on first sync.';
  }

  /** The Obsidian shell around a sync round: the reentrancy/config/crypto guards
   *  and ribbon transitions. The round's actual work (capture → run → record) lives
   *  in the obsidian-free {@link SyncCoordinator}. */
  private async triggerSync(source: 'manual' | 'auto'): Promise<void> {
    if (this.startupCaptureInProgress) {
      if (source === 'manual') new Notice('OpsBlobs: still preparing the vault for first sync — try again shortly.');
      return;
    }
    if (this.syncInProgress) {
      if (source === 'manual') new Notice('Sync already in progress.');
      return;
    }
    if (!this.isServerConfigured()) {
      if (source === 'manual') this.notifyMissingConfig();
      return;
    }
    if (!(await this.checkVaultBinding(source))) return;
    if (!this.crypto.isReady()) {
      await this.tryDeriveVaultKey();
      if (!this.crypto.isReady()) {
        if (source === 'manual') new Notice("OpsBlobs: couldn't unlock the vault with this passphrase — check it in settings.");
        return;
      }
    }

    this.syncInProgress = true;
    this.updateRibbonState('syncing');
    // Snapshot the total conflict count so we can tell if THIS round newly introduced
    // any (§3). Covers both text (two-headed files) and delete/binary conflicts — the
    // Conflicts panel now lists both — so a rise maps to a new item the user must
    // resolve, and a persisting conflict (same count) doesn't re-nag.
    const conflictsBefore = this.conflictCount();
    let outcome: SyncOutcome | undefined;
    try {
      outcome = await this.coordinator.sync(source);
      // Surface newly-introduced conflicts (§3): only on a rise, so a periodic
      // auto-sync doesn't nag every round while the same conflicts sit unresolved.
      if (outcome.ok && this.conflictCount() > conflictsBefore) {
        this.revealNewConflicts(source, this.conflictCount());
      }
    } finally {
      this.syncInProgress = false;
      // Clear the in-flight activity so the modal's live section settles back.
      this.syncActivity = null;
      this.uploadProgress = null;
      // Always leave the 'syncing' ribbon spinner from the *finally*, not the try — so
      // a throw between here and the settle (e.g. in conflictCount) can't strand the
      // ribbon mid-spin. Land on the state the round actually produced: error if it
      // failed (or threw before returning), conflict if any remain, else idle.
      if (!outcome || !outcome.ok) this.updateRibbonState('error');
      else this.updateRibbonState(this.conflictCount() > 0 ? 'conflict' : 'idle');
      this.updateStatusBar();
      // A round can surface NEW two-headed files (the applicator writes markers) or
      // clear them (a peer's resolution adopted) — neither goes through
      // opLogger.onChange, so refresh the panel explicitly here.
      this.emitConflictChange();
    }
  }

  /**
   * Vault-switch backstop: compares the vaultId this device's local sync state
   * (cursor/registry/DAG) was last bound to against what settings currently say.
   * The "Switch vault" UI action keeps these in sync itself, so this only ever
   * fires for a genuine out-of-band drift (e.g. `data.json` edited or restored
   * outside that flow). Returns whether the sync round should proceed.
   *
   * No marker yet (fresh install, or an upgrade from before this guard existed):
   * adopt the current vaultId as the baseline with no reset — there's no
   * retroactive signal to tell whether existing local state already belongs to
   * it. An `auto` round never prompts or wipes silently; it just notices and
   * defers to a manual sync, which can ask.
   */
  private async checkVaultBinding(source: 'manual' | 'auto'): Promise<boolean> {
    const bindingStore = new VaultBindingStore(this.metadata);
    const binding = await bindingStore.load();
    if (binding === null) {
      await bindingStore.save(this.settings.vaultId);
      return true;
    }
    if (binding === this.settings.vaultId) return true;

    if (source === 'auto') {
      new Notice(
        'OpsBlobs: vault ID changed outside settings — open settings and sync manually to resolve.',
        0,
      );
      return false;
    }
    const confirmed = await new Promise<boolean>(resolve => {
      new ConfirmModal(this.app, {
        title: 'Vault ID changed unexpectedly',
        message:
          `Local sync state is bound to vault "${binding}", but settings now show ` +
          `"${this.settings.vaultId}". Continuing would risk corrupting file history. Reset local ` +
          'sync state to match and continue? Vault content is never touched.',
        confirmText: 'Reset & continue',
        warning: true,
      }, resolve).open();
    });
    if (!confirmed) return false;
    await this.wipeLocalSyncStateForVaultSwitch();
    await this.applyVaultKey().catch(err =>
      console.error('OpsBlobs: key derivation failed after vault-binding reset:', err));
    await bindingStore.save(this.settings.vaultId);
    return true;
  }

  /** Wipe every local sync store that's scoped to a specific server vault — cursor,
   *  registry, version DAG, and observable sync state — so a vault switch never
   *  reuses metadata built under a different vaultId's scope. `ContentStore` (hash-
   *  addressed, vaultId-agnostic) and the HLC (a device-level monotonic clock, F7)
   *  are deliberately left untouched. */
  private async wipeLocalSyncStateForVaultSwitch(): Promise<void> {
    this.opLogger.clearOps();
    await this.registry.resetAll();
    await new CursorStore(this.metadata).save(0);
    await new VersionDagStore(this.metadata).clear();
    await this.syncState.resetAll();
  }

  /**
   * Switch this device to a different server vault (or disconnect, if `newVaultId`
   * is blank). Local sync state is scoped only by folder location, not by vaultId
   * (see the vault-switch incident this guards against), so reusing it across a
   * switch risks silently corrupting merges. Block-and-warn: confirm first (unless
   * this is the very first vaultId this device has ever had — nothing to protect
   * yet), then wipe and, if the new vaultId is non-empty, re-baseline and sync.
   */
  async switchVault(newVaultId: string): Promise<void> {
    const trimmed = newVaultId.trim();
    const current = this.settings.vaultId;
    if (trimmed === current) return;
    if (this.syncInProgress || this.startupCaptureInProgress) {
      new Notice('OpsBlobs: finish the current sync before switching vaults.');
      return;
    }

    const applySwitch = async () => {
      this.settings.vaultId = trimmed;
      await this.saveSettings();
      await this.wipeLocalSyncStateForVaultSwitch();
      await new VaultBindingStore(this.metadata).save(trimmed);
      if (trimmed) {
        await this.applyVaultKey().catch(err =>
          console.error('OpsBlobs: key derivation failed after vault switch:', err));
        await this.opLogger.captureAllAsBaseline();
        await this.triggerSync('manual');
      }
    };

    if (!current) {
      await applySwitch(); // first-time setup — nothing local to protect yet
      return;
    }

    const confirmed = await new Promise<boolean>(resolve => {
      new ConfirmModal(this.app, {
        title: trimmed ? 'Switch vault?' : 'Disconnect this vault?',
        message: trimmed
          ? `This device will disconnect from "${current}" and connect to "${trimmed}". Local sync ` +
            'history (cursor, version history, file registry) will be reset and rebuilt from scratch ' +
            'against the new vault ID. Vault content on this device is never touched.'
          : `This device will disconnect from "${current}". Local sync history will be reset. ` +
            'Vault content on this device is never touched.',
        confirmText: trimmed ? 'Switch vault' : 'Disconnect',
        warning: true,
      }, resolve).open();
    });
    if (confirmed) await applySwitch();
  }

  /** Make newly-introduced text conflicts impossible to miss (§3). A manual round is
   *  a user-initiated action expecting a result, so it opens the conflicts tab
   *  directly. An unattended round instead shows a persistent, actionable notice — no
   *  surprise focus change while the user is doing something else — that opens the
   *  same tab on click. */
  private revealNewConflicts(source: 'manual' | 'auto', count: number): void {
    if (source === 'manual') {
      void this.activateConflictsView();
      return;
    }
    const frag = createFragment(f => {
      f.appendText(`OpsBlobs: ${count} file${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} conflict resolution.`);
      f.createEl('br');
      const link = f.createEl('a', { text: 'Open conflicts', cls: 'vault-sync-notice-link' });
      link.addEventListener('click', () => { void this.activateConflictsView(); });
    });
    new Notice(frag, 0); // 0 = stays until dismissed
  }

  /** Public entry point for the settings "Sync now" button. */
  async syncNow(): Promise<void> {
    await this.triggerSync('manual');
  }

  /** Whether a sync round — or the startup offline-changes scan that precedes it — is
   *  currently running. Read by the settings tab when the "Sync now" button (re)renders,
   *  since reopening the tab mid-round (or during the startup scan) would otherwise show
   *  a fresh, idle-looking button for work it isn't driving. */
  isSyncing(): boolean {
    return this.syncInProgress || this.startupCaptureInProgress;
  }

  // ─── Auto-sync ──────────────────────────────────────────────────────────────

  /** (Re)arm the periodic sync timer from settings. Idempotent — safe to call
   *  again whenever the interval setting changes. */
  setupAutoSync(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
    const mins = this.settings.autoSyncIntervalMinutes;
    if (mins > 0) {
      this.autoSyncHandle = window.setInterval(() => {
        void this.triggerSync('auto');
      }, mins * 60_000);
      this.registerInterval(this.autoSyncHandle);
    }
  }

  // ─── Maintenance (wired from settings) ───────────────────────────────────────

  /** Garbage-collect the content store down to what the registry still
   *  references (live content + the DAG-reachable merge bases of each live head).
   *  Returns the count removed. The version-DAG's parent links are retained
   *  separately (and are tiny), so a base whose bytes are GC'd only degrades a deep
   *  merge to a conflict — never data loss. */
  async clearContentCache(): Promise<number> {
    const dag = await new VersionDagStore(this.metadata).load();
    const keep = this.registry.referencedHashes(dag);
    const before = (await this.contentStore.listHashes()).length;
    const retentionMs = this.settings.ancestorRetentionDays * 86_400_000;
    await this.contentStore.gc(keep, retentionMs, Date.now());
    const after = (await this.contentStore.listHashes()).length;
    return before - after;
  }

  /**
   * Rebuild sync metadata non-destructively: re-scan the vault into the registry,
   * then re-capture every on-disk file as ops via `captureOfflineChanges` — never
   * dropping the pending oplog. The old path cleared pending ops outright, silently
   * discarding un-synced local changes (S3); this instead re-derives ops from the
   * true disk state, so nothing the user hasn't synced is lost. Vault content is
   * never touched.
   *
   * If there are un-synced pending ops, confirm first — the user should understand
   * those changes will be re-captured (and pushed next sync), not discarded.
   */
  async resetSyncState(): Promise<void> {
    await this.coordinator.reset(pending =>
      new Promise<boolean>(resolve => {
        new ConfirmModal(this.app, {
          title: 'Rebuild sync metadata?',
          message:
            `${pending} unsynced change${pending !== 1 ? 's' : ''} will be re-captured from disk ` +
            'and pushed on the next sync — nothing is discarded. Vault content is never touched.',
          confirmText: 'Rebuild',
        }, resolve).open();
      }),
    );
    this.updateStatusBar();
  }

  /**
   * Re-baseline this device to the server (S4): treat this device as the source of
   * truth and force-push its full state up. Emits a pending op for every live file
   * (via `captureAllAsBaseline`, which re-asserts even unchanged files) and then
   * runs a normal sync round — so a server that has drifted, lost data, or was
   * rebuilt is reconstructed from this client. Vault content here is never touched;
   * the round summary lands in the sync-state and is visible in the status modal.
   *
   * Destructive on *other* devices in the sense that this device's version wins any
   * concurrent edit, so it is gated behind an explicit confirmation.
   */
  async rebaselineToServer(): Promise<void> {
    if (!this.isServerConfigured()) {
      this.notifyMissingConfig();
      return;
    }
    const fileCount = this.registry.getActiveEntries().length;
    await this.coordinator.rebaseline(
      () =>
        new Promise<boolean>(resolve => {
          new ConfirmModal(this.app, {
            title: 'Re-baseline this device to the server?',
            message:
              'Every file on THIS device will be pushed to the server as the authoritative ' +
              'version. If another device edited the same file, THIS device wins and the other ' +
              'device\'s conflicting edit is overwritten on its next sync. This cannot be undone ' +
              `from here. Vault content on this device is never touched. (${fileCount} file${fileCount !== 1 ? 's' : ''}.)`,
            confirmText: 'Re-baseline & push',
            warning: true,
            requireTyped: 're-baseline',
          }, resolve).open();
        }),
      () => this.triggerSync('manual'),
    );
  }

  /**
   * Re-check for conflicts: rewind the sync cursor to the start so the next sync
   * re-pulls the whole server log and recomputes every merge. A conflict that was
   * skipped (or dismissed) — whose remote op the cursor has already moved past,
   * so it would never re-appear on a normal sync — is surfaced again. Local
   * content and pending ops are untouched; already-converged files merge to a
   * no-op, so this is safe to run anytime. Then it runs a sync.
   */
  async recheckConflicts(): Promise<void> {
    // Rewind the cursor and replay the whole log. "Conflicts" are derived now
    // (Step 7) — no badges to wipe/self-heal: a delete/binary conflict this replay
    // re-encounters re-defers (and re-surfaces as reason 'conflict'); text conflicts
    // stay two-headed in the registry regardless. Local content/ops are untouched.
    await new CursorStore(this.metadata).save(0);
    await this.triggerSync('manual');
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  private updateRibbonState(state: 'idle' | 'syncing' | 'conflict' | 'error') {
    this.ribbonState = state;
    if (!this.ribbonIcon) return;
    this.ribbonIcon.removeClass('vault-sync-idle', 'vault-sync-syncing', 'vault-sync-conflict', 'vault-sync-error');
    this.ribbonIcon.addClass(`vault-sync-${state}`);

    const titles: Record<string, string> = {
      idle: 'OpsBlobs',
      syncing: 'OpsBlobs (syncing…)',
      conflict: 'OpsBlobs (conflicts need resolution)',
      error: 'OpsBlobs (error — click for details)',
    };
    this.ribbonIcon.setAttribute('aria-label', titles[state] ?? 'OpsBlobs');
  }

  /**
   * A deliberately *coarse* badge: which of three states the vault is in, not
   * how many changes or how long ago. Precision (counts, "2m ago") belongs in
   * the sync-status modal, not a glanceable indicator — and dropping it means
   * the badge has nothing time-dependent to refresh, so it only ever needs to
   * re-render when the state actually changes (an op recorded/cleared, or a
   * conflict raised/resolved). Those are the events wired to call this; there
   * is no polling.
   */
  private updateStatusBar() {
    if (!this.statusBarItem) return;

    // Outstanding conflicts take priority — they need the user, not just a sync. Show
    // the count (Step 6) so a glance says how many files the panel has waiting. State is
    // conveyed by color (no-emoji UI decision, §5); the word label carries it for a11y.
    const conflicts = this.conflictCount();
    if (conflicts > 0) {
      this.setStatusBarText(`${conflicts} conflict${conflicts !== 1 ? 's' : ''}`, 'conflict');
    } else if (this.opLogger.getPendingOps().length > 0) {
      this.setStatusBarText('Changes to sync', 'pending');
    } else {
      this.setStatusBarText('Synced', 'synced');
    }
  }

  // ─── Conflicts panel (Step 6) ─────────────────────────────────────────────

  /** The narrow surface the {@link ConflictsView} needs — all decision logic lives
   *  in the obsidian-free helpers it calls; this is pure glue. */
  private conflictsHost(): ConflictsViewHost {
    return {
      listConflicts: () => this.twoHeadedConflicts(),
      readFile: async (path) => {
        const bytes = await this.vaultFiles.read(path);
        return bytes ? new TextDecoder().decode(bytes) : null;
      },
      // Writing the marker-free bytes IS the Step-5 resolving save: the vault write
      // fires a modify event → the op-logger's two-headed branch mints the merge node
      // and clears the conflict. The panel never bypasses that path.
      resolveFile: async (path, text) => {
        await this.vaultFiles.write(path, new TextEncoder().encode(text));
      },
      openFile: async (path) => {
        await this.app.workspace.openLinkText(path, '', false);
      },
      describeDevice: (deviceId) =>
        deviceId === this.settings.deviceId ? 'this device' : `device ${deviceId.slice(0, 6)}`,
      // Delete/binary conflicts (§3 "full inline"): the panel lists the round's
      // descriptors and resolves them by recording a decision the next sync consumes.
      listDeleteBinaryConflicts: () => this.syncState.get().conflicts,
      resolveDeleteBinary: async (fileId, decision) => {
        await this.syncState.recordDecision(fileId, decision);
        // The recorded decision is applied by the next round's applicator (mints the
        // merge node). Trigger it now so the resolution lands promptly; the finally
        // block's emitConflictChange refreshes the panel once the entry is gone.
        await this.triggerSync('manual');
      },
      onChange: (cb) => {
        this.conflictChangeListeners.add(cb);
        return () => this.conflictChangeListeners.delete(cb);
      },
    };
  }

  /** The narrow surface the {@link PendingChangesView} needs — the full detail behind
   *  the status modal's one-line "waiting to sync" summary. Reuses the same change
   *  fan-out as the conflicts panel: an op recorded/cleared or a round finishing is
   *  exactly when pending/deferred/stranded counts can have moved. */
  private pendingChangesHost(): PendingChangesViewHost {
    return {
      listPendingOps: () => this.opLogger.getPendingOps().map(op => ({ path: op.path, type: op.type })),
      listDeferred: () => this.syncState.get().deferred,
      strandedCount: () => this.syncState.get().stranded.length,
      onChange: (cb) => {
        this.conflictChangeListeners.add(cb);
        return () => this.conflictChangeListeners.delete(cb);
      },
    };
  }

  /** The narrow surface the {@link PerfLogView} needs — reads and clears the perf log
   *  through the metadata store. Pure glue; a diagnostics read must never break sync. */
  private perfLogHost(): PerfLogViewHost {
    return {
      perfLogPath: PERF_LOG_PATH,
      perfLogEnabled: () => this.settings.perfLog,
      readPerfLog: () => this.metadata.read(PERF_LOG_PATH).catch(() => null),
      clearPerfLog: async () => {
        if (await this.metadata.exists(PERF_LOG_PATH)) await this.metadata.remove(PERF_LOG_PATH);
      },
    };
  }

  /** Reveal the perf log viewer as a main-area tab (creating it if needed), reusing an
   *  existing leaf so repeated triggers don't spawn duplicates — mirrors
   *  {@link activateConflictsView}. Public so the settings tab can open it. */
  async activatePerfLogView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(PERF_LOG_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: PERF_LOG_VIEW_TYPE, active: true });
    } else {
      // An already-open tab may be stale — the log grows out-of-band as sync runs.
      if (leaf.view instanceof PerfLogView) leaf.view.refresh();
    }
    void workspace.revealLeaf(leaf);
  }

  /** Reveal the conflicts view, creating it as a main-area tab if needed. A tab (not
   *  a right-sidebar drawer) makes it a first-class view and reads far better on
   *  mobile, where the sidebar is a cramped slide-over. Reuses an existing leaf if one
   *  is already open so repeated triggers don't spawn duplicate tabs. */
  async activateConflictsView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CONFLICTS_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: CONFLICTS_VIEW_TYPE, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  /** Reveal the pending-changes view, creating it as a main-area tab if needed — the
   *  full detail behind the status modal's "waiting to sync" summary line. Mirrors
   *  {@link activateConflictsView}/{@link activatePerfLogView}; reuses an existing leaf
   *  so repeated triggers don't spawn duplicate tabs. */
  async activatePendingChangesView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(PENDING_CHANGES_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: PENDING_CHANGES_VIEW_TYPE, active: true });
    } else {
      // An already-open tab may be stale — pending/deferred/stranded change out-of-band.
      if (leaf.view instanceof PendingChangesView) leaf.view.refresh();
    }
    void workspace.revealLeaf(leaf);
  }

  /** Single writer for the status bar. Called by every state-change event and
   *  by the sync progress handler, so it only touches the DOM when the text
   *  changed — and it keeps {@link statusBarText} in lockstep with the DOM so a
   *  transient progress label ("Pulling…") is always overwritten by the next
   *  render, even when the pre- and post-sync states happen to be identical. */
  private setStatusBarText(text: string, state: 'syncing' | 'conflict' | 'pending' | 'synced' = 'synced'): void {
    if (!this.statusBarItem || text === this.statusBarText) return;
    this.statusBarText = text;
    this.statusBarItem.setText(text);
    // Color-code the state (no-emoji UI decision, §5). Each state maps to a distinct
    // label, so the text guard above already implies the class only changes here.
    this.statusBarItem.removeClass(
      'vault-sync-sb-syncing', 'vault-sync-sb-conflict', 'vault-sync-sb-pending', 'vault-sync-sb-synced',
    );
    this.statusBarItem.addClass(`vault-sync-sb-${state}`);
  }

  /** Open the inspectable sync-status surface (S2) — replaces the old transient
   *  Notice. Public so the settings tab can open it too. */
  openSyncStatus(): void {
    const state = this.syncState.get();
    new SyncStatusModal(this.app, {
      conflictCount: this.conflictCount(),
      waitingCounts: {
        pending: this.opLogger.getPendingOps().length,
        deferred: state.deferred.length,
        stranded: state.stranded.length,
      },
      state,
      getIndexingProgress: () => this.indexingProgress,
      getSyncActivity: () => this.syncActivity,
      getUploadProgress: () => this.uploadProgress,
      onOpenConflicts: () => { void this.activateConflictsView(); },
      onOpenPendingChanges: () => { void this.activatePendingChangesView(); },
      onDismissError: () => { void this.syncState.clearError(); },
    }).open();
  }

  /** Open the perf log viewer tab (SettingsHost). The `.opsblobs/perf-log.txt`
   *  dotfolder is effectively unreachable on iOS, so the settings button routes here
   *  instead of asking the user to hunt for a hidden file. */
  openPerfLog(): void {
    void this.activatePerfLogView();
  }
}
