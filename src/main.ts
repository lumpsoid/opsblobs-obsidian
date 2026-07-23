// ─────────────────────────────────────────────
//  Obsidian Vault Sync — Main Plugin Entry
// ─────────────────────────────────────────────

import { Plugin, Notice, addIcon } from 'obsidian';
import { SyncSettings, DEFAULT_SETTINGS } from './types';
import { HybridLogicalClock } from './core/hlc';
import { FileRegistry } from './core/file-registry';
import { ContentStore } from './core/content-store';
import { randomUuid } from './core/encoding';
import { OperationLogger } from './core/operation-logger';
import { resolveDeleteStrategy } from './core/conflict-policy';
import { SyncApplicator } from './network/sync-applicator';
import { ObsidianVaultFiles } from './network/obsidian-vault-files';
import { ObsidianMetadataStore } from './network/obsidian-metadata-store';
import { ObsidianVaultWatcher } from './network/obsidian-vault-watcher';
import { VaultCrypto, saltForVault } from './network/encryption';
import { ServerSyncClient, SyncRoundSummary } from './network/server-sync';
import { KeyMismatchError } from './network/sync-errors';
import { HttpServerApi } from './network/server-http';
import { CursorStore } from './network/cursor-store';
import { VersionDagStore } from './network/version-dag-store';
import { HlcStore } from './network/hlc-store';
import { SyncStateStore } from './network/sync-state-store';
import { PluginVaultSyncHost } from './network/vault-sync-host';
import { DeleteConflictModal } from './ui/delete-conflict-modal';
import { BinaryConflictModal } from './ui/binary-conflict-modal';
import { SyncStatusModal } from './ui/sync-status-modal';
import { ConfirmModal } from './ui/confirm-modal';
import { SyncSettingTab } from './ui/settings-tab';
import { SyncCoordinator } from './network/sync-coordinator';
import { ObsidianEditorSaver } from './network/obsidian-editor-saver';
import { ObsidianNotifier } from './network/obsidian-notifier';
import { ConflictsView, CONFLICTS_VIEW_TYPE, ConflictsViewHost } from './ui/conflicts-view';
import { listTwoHeadedConflicts, ConflictListItem } from './core/conflict-inventory';

// ─── Ribbon icon SVG ────────────────────────────────────────────────────────
const SYNC_ICON_ID = 'vault-sync-icon';
const SYNC_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>`;

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
  private statusBarItem: HTMLElement | null = null;
  private statusBarText = '';
  private syncInProgress = false;
  private autoSyncHandle: number | null = null;

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
      // A text conflict is surfaced non-blockingly as inline markers by the
      // applicator (sync v2 Step 5) — no handler. The remaining choice-based
      // delete/binary conflicts still delegate the manual/auto branching +
      // outstanding-conflict bookkeeping to the coordinator (S5); the plugin
      // supplies only the Obsidian modal a *manual* round opens for the decision.
      (action) =>
        this.coordinator.decideDeleteConflict(
          resolveDeleteStrategy(this.settings.deleteConflictStrategy),
          action,
          a =>
            new Promise<'keep_deleted' | 'restore'>(resolve => {
              new DeleteConflictModal(this.app, a.path, a.side, resolve).open();
            }),
        ),
      (action) =>
        this.coordinator.decideBinaryConflict(action, a =>
          new Promise<'keep_local' | 'keep_remote'>(resolve => {
            new BinaryConflictModal(this.app, a, resolve).open();
          }),
        ),
    );

    // Load persisted state
    this.syncState = new SyncStateStore(metadata);
    await this.syncState.load();
    await this.contentStore.init();
    await this.registry.load();
    await this.opLogger.load();

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
        await this.opLogger.captureOfflineChanges();
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

    this.ribbonIcon = this.addRibbonIcon(SYNC_ICON_ID, 'Vault Sync', () => {
      void this.triggerSync('manual');
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

    // ── Settings ───────────────────────────────────────────────────────────
    this.addSettingTab(new SyncSettingTab(this.app, this));

    // ── Auto-sync ──────────────────────────────────────────────────────────
    this.setupAutoSync();
  }

  onunload() {
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

  /** Open Obsidian's settings straight to the Vault Sync tab, so the finish-setup
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
      f.appendText(`Vault Sync: finish setup before syncing — still missing ${missing.join(', ')}.`);
      f.createEl('br');
      const link = f.createEl('a', { text: 'Open Vault Sync settings', cls: 'vault-sync-notice-link' });
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
      console.error('Vault Sync: key derivation failed:', err);
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
      onProgress: (label) => this.setStatusBarText(`⟳ ${label}`),
    });
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
      ? '✓ Connected — server reachable, token accepted, and the passphrase matches this vault.'
      : '✓ Connected — server reachable and token accepted. The vault has no data yet; this device will establish the key on first sync.';
  }

  /** The Obsidian shell around a sync round: the reentrancy/config/crypto guards
   *  and ribbon transitions. The round's actual work (capture → run → record) lives
   *  in the obsidian-free {@link SyncCoordinator}. */
  private async triggerSync(source: 'manual' | 'auto'): Promise<void> {
    if (this.syncInProgress) {
      if (source === 'manual') new Notice('Sync already in progress.');
      return;
    }
    if (!this.isServerConfigured()) {
      if (source === 'manual') this.notifyMissingConfig();
      return;
    }
    if (!this.crypto.isReady()) {
      await this.tryDeriveVaultKey();
      if (!this.crypto.isReady()) {
        if (source === 'manual') new Notice("Vault Sync: couldn't unlock the vault with this passphrase — check it in settings.");
        return;
      }
    }

    this.syncInProgress = true;
    this.updateRibbonState('syncing');
    // Snapshot text-conflict count so we can tell if THIS round newly introduced any
    // (§3). Keyed off two-headed files specifically — that's exactly what the
    // conflicts view lists — so a rise maps 1:1 to a card the user must resolve.
    const textConflictsBefore = this.twoHeadedConflicts().length;
    try {
      const outcome = await this.coordinator.sync(source);
      // Land on the conflict state (not idle) if the round left conflicts the user
      // still needs to resolve, so the indicator doesn't silently go green.
      if (!outcome.ok) this.updateRibbonState('error');
      else this.updateRibbonState(this.conflictCount() > 0 ? 'conflict' : 'idle');
      // Surface newly-introduced text conflicts (§3): only on a rise, so a periodic
      // auto-sync doesn't nag every round while the same conflicts sit unresolved.
      if (outcome.ok && this.twoHeadedConflicts().length > textConflictsBefore) {
        this.revealNewConflicts(source, this.twoHeadedConflicts().length);
      }
    } finally {
      this.syncInProgress = false;
      this.updateStatusBar();
      // A round can surface NEW two-headed files (the applicator writes markers) or
      // clear them (a peer's resolution adopted) — neither goes through
      // opLogger.onChange, so refresh the panel explicitly here.
      this.emitConflictChange();
    }
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
      f.appendText(`Vault Sync: ${count} file${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} conflict resolution.`);
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
              'version. If another device edited the same file, this device\'s version will ' +
              `win the merge there. Vault content on this device is never touched. (${fileCount} file${fileCount !== 1 ? 's' : ''}.)`,
            confirmText: 'Re-baseline & push',
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
    if (!this.ribbonIcon) return;
    this.ribbonIcon.removeClass('vault-sync-idle', 'vault-sync-syncing', 'vault-sync-conflict', 'vault-sync-error');
    this.ribbonIcon.addClass(`vault-sync-${state}`);

    const titles: Record<string, string> = {
      idle: 'Vault Sync',
      syncing: 'Vault Sync (syncing…)',
      conflict: 'Vault Sync (conflicts need resolution)',
      error: 'Vault Sync (error — click for details)',
    };
    this.ribbonIcon.setAttribute('aria-label', titles[state] ?? 'Vault Sync');
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
    // the count (Step 6) so a glance says how many files the panel has waiting.
    const conflicts = this.conflictCount();
    const text =
      conflicts > 0
        ? `⚠ ${conflicts} conflict${conflicts !== 1 ? 's' : ''}`
        : this.opLogger.getPendingOps().length > 0
          ? '⟳ Changes to sync'
          : '✓ Synced';

    this.setStatusBarText(text);
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
      onChange: (cb) => {
        this.conflictChangeListeners.add(cb);
        return () => this.conflictChangeListeners.delete(cb);
      },
    };
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

  /** Single writer for the status bar. Called by every state-change event and
   *  by the sync progress handler, so it only touches the DOM when the text
   *  changed — and it keeps {@link statusBarText} in lockstep with the DOM so a
   *  transient progress label ("⟳ Pulling…") is always overwritten by the next
   *  render, even when the pre- and post-sync states happen to be identical. */
  private setStatusBarText(text: string): void {
    if (!this.statusBarItem || text === this.statusBarText) return;
    this.statusBarText = text;
    this.statusBarItem.setText(text);
  }

  /** Open the inspectable sync-status surface (S2) — replaces the old transient
   *  Notice. Public so the settings tab can open it too. */
  openSyncStatus(): void {
    new SyncStatusModal(this.app, {
      serverUrl: this.settings.serverUrl,
      fingerprint: this.vaultKeyFingerprint(),
      deviceId: this.settings.deviceId,
      deviceName: this.settings.deviceName,
      pendingPaths: this.opLogger.getPendingOps().map(op => op.path),
      state: this.syncState.get(),
      onResolveConflicts: () => { void this.recheckConflicts(); },
    }).open();
  }
}
