// ─────────────────────────────────────────────
//  Obsidian Vault Sync — Main Plugin Entry
// ─────────────────────────────────────────────

import { Plugin, Notice, addIcon, MarkdownView } from 'obsidian';
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
import { HttpServerApi } from './network/server-http';
import { CursorStore } from './network/cursor-store';
import { HlcStore } from './network/hlc-store';
import { SyncStateStore } from './network/sync-state-store';
import { PluginVaultSyncHost } from './network/vault-sync-host';
import { ConflictResolutionModal } from './ui/conflict-modal';
import { DeleteConflictModal } from './ui/delete-conflict-modal';
import { BinaryConflictModal } from './ui/binary-conflict-modal';
import { SyncStatusModal } from './ui/sync-status-modal';
import { SyncSettingTab } from './ui/settings-tab';

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
  private crypto = new VaultCrypto();

  private ribbonIcon: HTMLElement | null = null;
  private statusBarItem: HTMLElement | null = null;
  private syncInProgress = false;
  private autoSyncHandle: number | null = null;

  /** Conflicts the user has skipped/dismissed and not yet resolved — drives the
   *  ribbon's "needs attention" state and the status modal. Read from the
   *  persisted sync-state so it survives restarts. */
  private outstandingConflictCount(): number {
    return this.syncState.get().outstandingConflicts.length;
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
    );

    this.applicator = new SyncApplicator(
      vaultFiles,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.hlc,
      // Conflict handler
      async (action) => {
        const resolved = await new Promise<Uint8Array | null>(resolve => {
          new ConflictResolutionModal(
            this.app,
            action.localPath,
            action.mergeResult,
            action.localContent,
            action.remoteContent,
            resolve,
          ).open();
        });
        // A skip (null) leaves the two devices divergent — record it as
        // outstanding so it's visible and re-openable instead of vanishing. A real
        // resolution clears any prior outstanding entry for this file.
        if (resolved === null) {
          await this.syncState.recordConflict({ fileId: action.fileId, path: action.localPath, kind: 'content', firstSeen: Date.now() });
        } else {
          await this.syncState.clearConflict(action.fileId);
        }
        return resolved;
      },
      // Delete conflict handler
      async (action) => {
        const strategy = resolveDeleteStrategy(this.settings.deleteConflictStrategy);
        const decision = strategy !== 'ask'
          ? strategy
          // 'ask' — let the user decide per file.
          : await new Promise<'keep_deleted' | 'restore'>(resolve => {
              new DeleteConflictModal(this.app, action.path, action.side, resolve).open();
            });
        // Delete conflicts always resolve (the modal defaults to 'restore' on
        // dismiss), so clear any outstanding entry rather than recording a skip.
        await this.syncState.clearConflict(action.fileId);
        return decision;
      },
      // Binary conflict handler — binary files can't be three-way merged, so the
      // user picks which whole version to keep (presented by filename + metadata).
      async (action) => {
        const decision = await new Promise<'keep_local' | 'keep_remote'>(resolve => {
          new BinaryConflictModal(this.app, action, resolve).open();
        });
        await this.syncState.clearConflict(action.fileId);
        return decision;
      },
    );

    // Load persisted state
    this.syncState = new SyncStateStore(metadata);
    await this.syncState.load();
    await this.contentStore.init();
    await this.registry.load();
    await this.opLogger.load();

    // Reconcile registry with current vault AND emit ops for anything that
    // changed while we weren't listening — crucially, the files already present
    // on a first enable (no create event ever fires for them). Without this the
    // existing vault would never be pushed; only post-enable edits would sync.
    await this.opLogger.captureOfflineChanges();

    // Start listening for vault changes
    this.opLogger.startListening();

    // Derive the vault key up front so auto-sync can run unattended.
    await this.tryDeriveVaultKey();

    // ── UI ─────────────────────────────────────────────────────────────────
    this.ribbonIcon = this.addRibbonIcon(SYNC_ICON_ID, 'Vault Sync', () => {
      void this.triggerSync('manual');
    });
    // Reflect any conflicts left outstanding from a previous session immediately.
    this.updateRibbonState(this.outstandingConflictCount() > 0 ? 'conflict' : 'idle');

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

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

  private isServerConfigured(): boolean {
    return Boolean(this.settings.serverUrl && this.settings.vaultId && this.settings.vaultPassphrase);
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

  /**
   * Best-effort flush of unsaved editor buffers to disk before a sync, so the
   * drift capture in `triggerSync` sees the latest bytes rather than a stale disk
   * copy. Obsidian persists the editor on its own idle debounce anyway, so this
   * only narrows the window — and it must never throw (fully guarded): the on-disk
   * `captureOfflineChanges` pass is the actual safety net. `save` is accessed
   * defensively because its presence in the public typings varies across Obsidian
   * versions.
   */
  private async forceSaveOpenEditors(): Promise<void> {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) continue;
        const save = (view as unknown as { save?: () => Promise<void> }).save;
        if (typeof save === 'function') await save.call(view);
      }
    } catch (err) {
      console.warn('Vault Sync: force-save of open editors failed (non-fatal):', err);
    }
  }

  private async triggerSync(source: 'manual' | 'auto'): Promise<void> {
    if (this.syncInProgress) {
      if (source === 'manual') new Notice('Sync already in progress.');
      return;
    }
    if (!this.isServerConfigured()) {
      if (source === 'manual') {
        new Notice('Vault Sync: configure a server and passphrase in Settings → Vault Sync first.');
      }
      return;
    }
    if (!this.crypto.isReady()) {
      await this.tryDeriveVaultKey();
      if (!this.crypto.isReady()) {
        if (source === 'manual') new Notice('Vault Sync: could not derive the vault key from the passphrase.');
        return;
      }
    }

    this.syncInProgress = true;
    this.updateRibbonState('syncing');

    try {
      // Get every just-made edit onto disk and into an op *before* building local
      // state — otherwise an edit made moments before pressing sync is pushed only
      // on a LATER round (the reported "sync doesn't take my change" bug). Three
      // stages, cheapest first:
      //   1. force-save unsaved editor buffers so their bytes reach disk;
      //   2. flush() drains already-armed debounce timers (the fast path);
      //   3. captureOfflineChanges() re-hashes every live file against the registry
      //      and emits an op for any drift — the real safety net, since it captures
      //      an edit even when its `modify` event hasn't fired yet. Idempotent, so
      //      running it every sync never duplicates ops.
      await this.forceSaveOpenEditors();
      await this.opLogger.flush();
      await this.opLogger.captureOfflineChanges();

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
      );
      const client = new ServerSyncClient({
        api,
        crypto: this.crypto,
        host,
        hlc: this.hlc,
        onProgress: (label) => this.statusBarItem?.setText(`⟳ ${label}`),
      });

      const summary = await client.runSync();

      // Persist logical time after the round (F7): the merge/apply path advances
      // the clock via merge()/setCurrent() outside op-recording, so capture it
      // here in addition to the per-op cadence in OperationLogger.
      await this.hlcStore.save(this.hlc.getCurrent());

      await this.recordRoundOutcome(summary);
      await this.syncState.clearError();

      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();

      if (source === 'manual') new Notice('✅ Vault sync complete');
      // Land on the conflict state (not idle) if the round left conflicts the user
      // still needs to resolve, so the indicator doesn't silently go green.
      this.updateRibbonState(this.outstandingConflictCount() > 0 ? 'conflict' : 'idle');
    } catch (err) {
      console.error('Vault Sync error:', err);
      new Notice(`❌ Sync failed: ${(err as Error).message}`);
      await this.syncState.setError((err as Error).message, Date.now());
      this.updateRibbonState('error');
    } finally {
      this.syncInProgress = false;
      this.updateStatusBar();
    }
  }

  /** Fold a completed round's summary into the persisted sync-state (S2): the
   *  one-line last-sync record plus the deferred/stranded lists, resolving the
   *  round's raw fileIds/hashes to vault paths for display. */
  private async recordRoundOutcome(summary: SyncRoundSummary): Promise<void> {
    const now = Date.now();
    const deferred = summary.deferred.map(fileId => ({
      fileId,
      path: this.registry.getById(fileId)?.path ?? fileId,
      reason: 'drift' as const,
      at: now,
    }));
    const stranded = summary.stranded.map(contentHash => ({ contentHash, at: now }));
    await this.syncState.setRound(
      { at: now, pushed: summary.pushed, pulled: summary.pulled, conflicts: this.outstandingConflictCount() },
      deferred,
      stranded,
    );
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
   *  references (live content + retained ancestors). Returns the count removed. */
  async clearContentCache(): Promise<number> {
    const keep = this.registry.referencedHashes();
    const before = (await this.contentStore.listHashes()).length;
    const retentionMs = this.settings.ancestorRetentionDays * 86_400_000;
    await this.contentStore.gc(keep, retentionMs, Date.now());
    const after = (await this.contentStore.listHashes()).length;
    return before - after;
  }

  /** Rebuild sync metadata: re-scan the vault into the registry and drop the
   *  pending oplog. Vault content is never touched. */
  async resetSyncState(): Promise<void> {
    await this.registry.reconcileWithVault(this.hlc.now());
    await this.opLogger.clearOps();
    this.updateStatusBar();
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

  private updateStatusBar() {
    if (!this.statusBarItem) return;
    const pending = this.opLogger.getPendingOps().length;
    const conflicts = this.outstandingConflictCount();
    const lastSynced = this.settings.lastSyncTime;
    const lastSyncedStr = lastSynced ? this.relativeTime(lastSynced) : 'Never synced';

    // Outstanding conflicts take priority — they need the user, not just time.
    if (conflicts > 0) {
      this.statusBarItem.setText(`⚠️ ${conflicts} conflict${conflicts !== 1 ? 's' : ''} to resolve`);
    } else {
      this.statusBarItem.setText(
        pending > 0
          ? `⟳ ${pending} pending change${pending !== 1 ? 's' : ''}`
          : `✓ ${lastSyncedStr}`,
      );
    }
  }

  /** Open the inspectable sync-status surface (S2) — replaces the old transient
   *  Notice. Public so the settings tab can open it too. */
  openSyncStatus(): void {
    new SyncStatusModal(this.app, {
      serverUrl: this.settings.serverUrl,
      fingerprint: this.vaultKeyFingerprint(),
      deviceId: this.settings.deviceId,
      pendingPaths: this.opLogger.getPendingOps().map(op => op.path),
      state: this.syncState.get(),
      onResolveConflicts: () => { void this.recheckConflicts(); },
    }).open();
  }

  private relativeTime(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
