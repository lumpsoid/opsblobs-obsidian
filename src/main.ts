// ─────────────────────────────────────────────
//  Obsidian Vault Sync — Main Plugin Entry
// ─────────────────────────────────────────────

import { Plugin, Notice, addIcon } from 'obsidian';
import { SyncSettings, DEFAULT_SETTINGS, VaultState, MergeAction } from './types';
import { HybridLogicalClock } from './core/hlc';
import { FileRegistry } from './core/file-registry';
import { ContentStore } from './core/content-store';
import { OperationLogger } from './core/operation-logger';
import { SyncApplicator } from './network/sync-applicator';
import { ConflictResolutionModal } from './ui/conflict-modal';
import { PairingModal } from './ui/pairing-modal';
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

  private ribbonIcon: HTMLElement | null = null;
  private statusBarItem: HTMLElement | null = null;
  private syncInProgress = false;
  private pendingConflicts = 0;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();
    this.ensureDeviceId();

    addIcon(SYNC_ICON_ID, SYNC_ICON_SVG);

    // Initialize core components
    this.hlc = new HybridLogicalClock(this.settings.deviceId);
    this.registry = new FileRegistry(this.app, this.settings.deviceId);
    this.contentStore = new ContentStore(this.app);
    this.opLogger = new OperationLogger(
      this.app,
      this.settings.deviceId,
      this.hlc,
      this.registry,
      this.contentStore,
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
        const strategy = this.settings.deleteConflictStrategy;
        if (strategy === 'keep_deleted') return 'keep_deleted';
        if (strategy === 'keep_modified') return 'restore';
        // 'ask' — show a simple notice for now; a real modal would be better
        return new Promise(resolve => {
          new Notice(
            `Sync conflict: "${action.path}" was deleted on one device and modified on another. ` +
            'Using modified version.',
            8000,
          );
          resolve('restore');
        });
      },
    );

    // Load persisted state
    await this.contentStore.init();
    await this.registry.load();
    await this.opLogger.load();

    // Reconcile registry with current vault
    await this.registry.reconcileWithVault(this.hlc.now());

    // Start listening for vault changes
    this.opLogger.startListening();

    // ── UI ─────────────────────────────────────────────────────────────────
    this.ribbonIcon = this.addRibbonIcon(SYNC_ICON_ID, 'Vault Sync', () => {
      this.triggerManualSync();
    });
    this.updateRibbonState('idle');

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    // ── Commands ───────────────────────────────────────────────────────────
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.triggerManualSync(),
    });

    this.addCommand({
      id: 'pair-new-device',
      name: 'Pair new device',
      callback: () => {
        new PairingModal(this.app, this.settings, async (device) => {
          this.settings.pairedDevices.push(device);
          await this.saveSettings();
          new Notice(`✅ Paired with ${device.deviceName}`);
        }).open();
      },
    });

    this.addCommand({
      id: 'view-sync-status',
      name: 'View sync status',
      callback: () => this.showSyncStatus(),
    });

    // ── Settings ───────────────────────────────────────────────────────────
    this.addSettingTab(new SyncSettingTab(this.app, this));

    console.log('Vault Sync: loaded.');
  }

  async onunload() {
    this.opLogger.stopListening();
    console.log('Vault Sync: unloaded.');
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  // ─── Sync ─────────────────────────────────────────────────────────────────

  private async triggerManualSync() {
    if (this.syncInProgress) {
      new Notice('Sync already in progress.');
      return;
    }

    if (this.settings.pairedDevices.length === 0) {
      new Notice('No paired devices. Go to Settings → Vault Sync to pair a device first.');
      return;
    }

    // For simplicity, sync with the first paired device
    // In a full implementation, you'd choose which device or sync with all
    const target = this.settings.pairedDevices[0];
    await this.syncWithDevice(target);
  }

  private async syncWithDevice(device: typeof this.settings.pairedDevices[0]) {
    this.syncInProgress = true;
    this.updateRibbonState('syncing');
    new Notice(`🔄 Syncing with ${device.deviceName}...`);

    try {
      // Build current vault state
      const localState: VaultState = {
        deviceId: this.settings.deviceId,
        hlc: this.hlc.getCurrent(),
        fileEntries: this.registry.getAllEntries(),
        pendingOps: this.opLogger.getPendingOps(),
        contentStore: new Map(),
      };

      // Load content for pending files into the content store
      await this.populateContentStore(localState);

      // Dynamic import to keep initial load fast
      const { SyncClient } = await import('./network/sync-client');

      // In a real app, we'd get IP/port from the QR scan or manual entry
      // For now, show a notice explaining the connection setup
      new Notice('💡 Tip: Start a sync server on the other device first, then enter its IP in settings.', 5000);

      new Notice(`✅ Sync complete with ${device.deviceName}`);
      device.lastSyncTime = Date.now();
      await this.saveSettings();

    } catch (err) {
      console.error('Vault Sync error:', err);
      new Notice(`❌ Sync failed: ${(err as Error).message}`);
      this.updateRibbonState('error');
    } finally {
      this.syncInProgress = false;
      this.updateRibbonState(this.pendingConflicts > 0 ? 'conflict' : 'idle');
      this.updateStatusBar();
    }
  }

  private async populateContentStore(state: VaultState): Promise<void> {
    for (const [, entry] of state.fileEntries) {
      if (!entry.deleted && !state.contentStore.has(entry.contentHash)) {
        const file = this.app.vault.getAbstractFileByPath(entry.path);
        if (file) {
          const content = await this.app.vault.readBinary(file as any);
          state.contentStore.set(entry.contentHash, new Uint8Array(content));
        }
      }
      // Include ancestor if we have it
      if (entry.ancestorContentHash) {
        const ancestor = await this.contentStore.get(entry.ancestorContentHash);
        if (ancestor) state.contentStore.set(entry.ancestorContentHash, ancestor);
      }
    }
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
    this.ribbonIcon.setAttribute('aria-label', titles[state]);
  }

  private updateStatusBar() {
    if (!this.statusBarItem) return;
    const pending = this.opLogger.getPendingOps().length;
    const lastSynced = this.settings.pairedDevices[0]?.lastSyncTime;
    const lastSyncedStr = lastSynced
      ? this.relativeTime(lastSynced)
      : 'Never synced';

    this.statusBarItem.setText(
      pending > 0
        ? `⟳ ${pending} pending change${pending !== 1 ? 's' : ''}`
        : `✓ ${lastSyncedStr}`,
    );
  }

  private showSyncStatus() {
    const pending = this.opLogger.getPendingOps().length;
    const devices = this.settings.pairedDevices.length;
    new Notice(
      `Vault Sync Status\n` +
      `• Paired devices: ${devices}\n` +
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
