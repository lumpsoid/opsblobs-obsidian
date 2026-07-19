// ─────────────────────────────────────────────
//  Obsidian Vault Sync — Main Plugin Entry
// ─────────────────────────────────────────────

import { App, Plugin, Notice, Modal, addIcon } from 'obsidian';
import { SyncSettings, DEFAULT_SETTINGS } from './types';
import { HybridLogicalClock } from './core/hlc';
import { FileRegistry } from './core/file-registry';
import { ContentStore } from './core/content-store';
import { OperationLogger } from './core/operation-logger';
import { resolveDeleteStrategy } from './core/conflict-policy';
import { SyncApplicator } from './network/sync-applicator';
import { VaultCrypto } from './network/encryption';
import { ServerSyncClient } from './network/server-sync';
import { HttpServerApi, CursorStore } from './network/server-http';
import { PluginVaultSyncHost } from './network/vault-sync-host';
import { ConflictResolutionModal } from './ui/conflict-modal';
import { SyncSettingTab } from './ui/settings-tab';

// ─── Ribbon icon SVG ────────────────────────────────────────────────────────
const SYNC_ICON_ID = 'vault-sync-icon';
const SYNC_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>`;

export default class VaultSyncPlugin extends Plugin {
  settings!: SyncSettings;
  private hlc!: HybridLogicalClock;
  private registry!: FileRegistry;
  private contentStore!: ContentStore;
  private opLogger!: OperationLogger;
  private applicator!: SyncApplicator;
  private crypto = new VaultCrypto();

  private ribbonIcon: HTMLElement | null = null;
  private statusBarItem: HTMLElement | null = null;
  private syncInProgress = false;
  private pendingConflicts = 0;
  private autoSyncHandle: number | null = null;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();
    this.ensureDeviceId();

    addIcon(SYNC_ICON_ID, SYNC_ICON_SVG);

    // Initialize core components
    this.hlc = new HybridLogicalClock(this.settings.deviceId);
    this.registry = new FileRegistry(this.app, this.settings.deviceId, () => this.settings);
    this.contentStore = new ContentStore(this.app);
    this.opLogger = new OperationLogger(
      this.app,
      this.settings.deviceId,
      this.hlc,
      this.registry,
      this.contentStore,
      () => this.settings,
      this.settings.debounceMs,
    );

    this.applicator = new SyncApplicator(
      this.app,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.hlc,
      // Conflict handler
      async (action) => {
        return new Promise(resolve => {
          new ConflictResolutionModal(
            this.app,
            action.localPath,
            action.mergeResult,
            action.localContent,
            action.remoteContent,
            resolve,
          ).open();
        });
      },
      // Delete conflict handler
      async (action) => {
        const resolved = resolveDeleteStrategy(this.settings.deleteConflictStrategy);
        if (resolved !== 'ask') return resolved;
        // 'ask' — let the user decide per file.
        return new Promise(resolve => {
          new DeleteConflictModal(this.app, action.path, action.side, resolve).open();
        });
      },
    );

    // Load persisted state
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
    this.updateRibbonState('idle');

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
      callback: () => this.showSyncStatus(),
    });

    // ── Settings ───────────────────────────────────────────────────────────
    this.addSettingTab(new SyncSettingTab(this.app, this));

    // ── Auto-sync ──────────────────────────────────────────────────────────
    this.setupAutoSync();
  }

  onunload() {
    this.opLogger.stopListening();
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
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
      // Capture any edit still waiting in the debounce window as an op *before*
      // building local state, so an edit-then-immediately-sync isn't raced and
      // silently dropped by the merge.
      await this.opLogger.flush();

      const api = new HttpServerApi({
        baseUrl: this.settings.serverUrl,
        vaultId: this.settings.vaultId,
        token: this.settings.serverToken,
      });
      const host = new PluginVaultSyncHost(
        this.app,
        this.settings.deviceId,
        this.registry,
        this.contentStore,
        this.opLogger,
        this.applicator,
        this.hlc,
        new CursorStore(this.app),
      );
      const client = new ServerSyncClient({
        api,
        crypto: this.crypto,
        host,
        hlc: this.hlc,
        onProgress: (label) => this.statusBarItem?.setText(`⟳ ${label}`),
      });

      await client.runSync();

      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();

      if (source === 'manual') new Notice('✅ Vault sync complete');
      this.updateRibbonState('idle');
    } catch (err) {
      console.error('Vault Sync error:', err);
      new Notice(`❌ Sync failed: ${(err as Error).message}`);
      this.updateRibbonState('error');
    } finally {
      this.syncInProgress = false;
      this.updateStatusBar();
    }
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
    await new CursorStore(this.app).save(0);
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
    const lastSynced = this.settings.lastSyncTime;
    const lastSyncedStr = lastSynced ? this.relativeTime(lastSynced) : 'Never synced';

    this.statusBarItem.setText(
      pending > 0
        ? `⟳ ${pending} pending change${pending !== 1 ? 's' : ''}`
        : `✓ ${lastSyncedStr}`,
    );
  }

  private showSyncStatus() {
    const pending = this.opLogger.getPendingOps().length;
    const fingerprint = this.vaultKeyFingerprint();
    new Notice(
      `Vault Sync Status\n` +
      `• Server: ${this.settings.serverUrl || '(not configured)'}\n` +
      `• Vault key: ${fingerprint ? `ready (${fingerprint})` : 'not derived'}\n` +
      `• Pending operations: ${pending}\n` +
      `• Device ID: ${this.settings.deviceId.slice(0, 8)}…`,
      8000,
    );
  }

  private relativeTime(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}

/** Deterministic 32-byte salt for a vault, derived from its (shared) vaultId so
 *  every device produces the same PBKDF2 salt without transferring one. */
async function saltForVault(vaultId: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vault-sync:salt:${vaultId}`));
  return new Uint8Array(digest);
}

// ─── Delete-conflict modal ─────────────────────────────────────────────────────
// Shown when a file was deleted on one device and modified on another, and the
// deleteConflictStrategy is 'ask'. The user chooses which side to keep.

class DeleteConflictModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private path: string,
    private side: 'local_deleted' | 'remote_deleted',
    private resolve: (decision: 'keep_deleted' | 'restore') => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '⚠️ Delete conflict' });

    const deletedHere = this.side === 'local_deleted';
    contentEl.createEl('p', {
      text: `"${this.path}" was deleted on ${deletedHere ? 'this device' : 'another device'} ` +
        `but modified on ${deletedHere ? 'another device' : 'this device'}. ` +
        'Keep the deletion, or restore the modified version?',
    });

    const buttons = contentEl.createDiv({ cls: 'delete-conflict-buttons' });

    const restoreBtn = buttons.createEl('button', {
      text: 'Keep modified version',
      cls: 'mod-cta',
    });
    restoreBtn.addEventListener('click', () => this.decide('restore'));

    const deleteBtn = buttons.createEl('button', {
      text: 'Keep deleted',
      cls: 'mod-warning',
    });
    deleteBtn.addEventListener('click', () => this.decide('keep_deleted'));
  }

  private decide(decision: 'keep_deleted' | 'restore') {
    this.decided = true;
    this.resolve(decision);
    this.close();
  }

  onClose() {
    // Dismissed without choosing — default to restoring so no edit is lost.
    if (!this.decided) this.resolve('restore');
    this.contentEl.empty();
  }
}
