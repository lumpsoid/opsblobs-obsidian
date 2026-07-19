// ─────────────────────────────────────────────
//  Vault Sync Host  (Phase 4)
// ─────────────────────────────────────────────
//
//  The concrete `VaultSyncHost` the P3 orchestrator (server-sync.ts) drives —
//  the bridge from its Obsidian-free interface to the live plugin stores
//  (FileRegistry, ContentStore, OperationLogger, SyncApplicator, CursorStore).
//  Deferred out of P3 (which tested the round against in-memory fakes); this is
//  the production wiring.

import { App, TFile } from 'obsidian';
import { VaultState, MergeAction } from '../types';
import { VaultSyncHost } from './server-sync';
import { FileRegistry } from '../core/file-registry';
import { ContentStore } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { SyncApplicator } from './sync-applicator';
import { HybridLogicalClock } from '../core/hlc';
import { CursorStore } from './server-http';

export class PluginVaultSyncHost implements VaultSyncHost {
  constructor(
    private app: App,
    private deviceId: string,
    private registry: FileRegistry,
    private contentStore: ContentStore,
    private opLogger: OperationLogger,
    private applicator: SyncApplicator,
    private hlc: HybridLogicalClock,
    private cursor: CursorStore,
  ) {}

  /**
   * Snapshot the local vault for a sync round: the registry entries, the
   * un-pushed pending ops, and a content store populated with the current bytes
   * of every live file (covers every pending op's content, whose hash equals the
   * live entry's) plus any retained ancestor content the three-way merge needs.
   */
  async buildLocalState(): Promise<VaultState> {
    const state: VaultState = {
      deviceId: this.deviceId,
      hlc: this.hlc.getCurrent(),
      fileEntries: this.registry.getAllEntries(),
      pendingOps: this.opLogger.getPendingOps(),
      contentStore: new Map(),
    };

    for (const entry of state.fileEntries.values()) {
      if (!entry.deleted && entry.contentHash && !state.contentStore.has(entry.contentHash)) {
        const file = this.app.vault.getAbstractFileByPath(entry.path);
        if (file instanceof TFile) {
          const content = new Uint8Array(await this.app.vault.readBinary(file));
          state.contentStore.set(entry.contentHash, content);
        }
      }
      if (entry.ancestorContentHash) {
        const ancestor = await this.contentStore.get(entry.ancestorContentHash);
        if (ancestor) state.contentStore.set(entry.ancestorContentHash, ancestor);
      }
    }

    return state;
  }

  async applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<void> {
    await this.applicator.applyActions(actions, local, remote);
  }

  async clearPendingOps(): Promise<void> {
    await this.opLogger.clearOps();
  }

  loadCursor(): Promise<number> {
    return this.cursor.load();
  }

  saveCursor(cursor: number): Promise<void> {
    return this.cursor.save(cursor);
  }
}
