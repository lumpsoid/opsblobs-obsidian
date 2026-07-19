// ─────────────────────────────────────────────
//  Vault Sync Host  (Phase 4)
// ─────────────────────────────────────────────
//
//  The concrete `VaultSyncHost` the P3 orchestrator (server-sync.ts) drives —
//  the bridge from its Obsidian-free interface to the live plugin stores
//  (FileRegistry, ContentStore, OperationLogger, SyncApplicator, CursorStore).
//  Deferred out of P3 (which tested the round against in-memory fakes); this is
//  the production wiring.

import { VaultState, FileEntry, MergeAction } from '../types';
import { VaultSyncHost } from './server-sync';
import { VaultFiles } from '../ports/vault-files';
import { FileRegistry } from '../core/file-registry';
import { ContentStore, hashContent } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { SyncApplicator } from './sync-applicator';
import { HybridLogicalClock } from '../core/hlc';
import { CursorStore } from './cursor-store';

export class PluginVaultSyncHost implements VaultSyncHost {
  constructor(
    private files: VaultFiles,
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
    const fileEntries = new Map<string, FileEntry>();
    const contentStore = new Map<string, Uint8Array>();

    for (const [id, entry] of this.registry.getAllEntries()) {
      let resolved = entry;

      if (!entry.deleted) {
        const content = await this.files.read(entry.path);
        if (content !== null) {
          const hash = await hashContent(content);
          // Key the bytes under their *actual* hash, never the registry's
          // recorded one. If an edit hasn't been logged yet the recorded hash is
          // stale; keying under it would alias the current bytes over the
          // ancestor, making the three-way merge see the file as unchanged and
          // silently adopt the remote (data loss). If they differ, trust the
          // disk and correct this snapshot so the merge compares real content.
          if (hash !== entry.contentHash) resolved = { ...entry, contentHash: hash };
          contentStore.set(hash, content);
        }
      }

      fileEntries.set(id, resolved);

      if (resolved.ancestorContentHash && !contentStore.has(resolved.ancestorContentHash)) {
        const ancestor = await this.contentStore.get(resolved.ancestorContentHash);
        if (ancestor) contentStore.set(resolved.ancestorContentHash, ancestor);
      }
    }

    return {
      deviceId: this.deviceId,
      hlc: this.hlc.getCurrent(),
      fileEntries,
      pendingOps: this.opLogger.getPendingOps(),
      contentStore,
    };
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
