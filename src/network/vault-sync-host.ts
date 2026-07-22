// ─────────────────────────────────────────────
//  Vault Sync Host  (Phase 4)
// ─────────────────────────────────────────────
//
//  The concrete `VaultSyncHost` the P3 orchestrator (server-sync.ts) drives —
//  the bridge from its Obsidian-free interface to the live plugin stores
//  (FileRegistry, ContentStore, OperationLogger, SyncApplicator, CursorStore).
//  Deferred out of P3 (which tested the round against in-memory fakes); this is
//  the production wiring.

import { VaultState, FileEntry, MergeAction, Operation } from '../types';
import { VaultSyncHost } from './server-sync';
import { VaultFiles } from '../ports/vault-files';
import { FileRegistry } from '../core/file-registry';
import { ContentStore, hashContent } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { SyncApplicator } from './sync-applicator';
import { HybridLogicalClock } from '../core/hlc';
import { CursorStore } from './cursor-store';
import { VersionDagStore } from './version-dag-store';
import { VersionDag } from '../core/version-dag';

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
    private versionDagStore: VersionDagStore,
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
    // The op-id DAG, so we can stage the bytes of every version reachable from each
    // file's head (its ancestors). The three-way merge base LCA(localHead, peerHead)
    // is always one of these, so pre-staging them makes any base available to the
    // pure merge — including one deeper than the last-synced version (a multi-round
    // offline divergence), which the scalar ancestor alone could not reach (#4).
    const dag = await this.versionDagStore.load();
    // This round's own edits aren't in the *persisted* DAG yet (recordVersionEdges
    // runs later in the round), so a fresh head can't reach its base for staging.
    // Fold the pending ops' edges into this in-memory copy — not persisted here — so
    // reachability from each head includes the base the merge will need.
    for (const op of this.opLogger.getPendingOps()) {
      if (op.type === 'move') continue;
      dag.addVersion(op.id, op.parents, op.contentHash, op.fileId);
    }

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

      // Stage the bytes of every base reachable from this file's head (its DAG
      // ancestors) that the content store still holds, so the merge can three-way
      // against the true LCA even when it is deeper than the scalar ancestor.
      if (resolved.headVersionId) {
        for (const hash of dag.reachableContentHashes(resolved.headVersionId)) {
          if (!contentStore.has(hash)) {
            const bytes = await this.contentStore.get(hash);
            if (bytes) contentStore.set(hash, bytes);
          }
        }
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

  async applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<{ deferred: Set<string>; converged: Set<string> }> {
    return this.applicator.applyActions(actions, local, remote);
  }

  async clearPendingOps(): Promise<void> {
    await this.opLogger.clearOps();
  }

  async recordVersionEdges(ops: Operation[]): Promise<VersionDag> {
    const dag = await this.versionDagStore.load();
    if (ops.length === 0) return dag;
    // Key by op-id (the version identity), carrying the content hash as the blob
    // address. A `move` carries no content parent and is not a new content version;
    // recording it is harmless (a childless node) but adds nothing, so skip it.
    for (const op of ops) {
      if (op.type === 'move') continue;
      dag.addVersion(op.id, op.parents, op.contentHash, op.fileId);
    }
    await this.versionDagStore.save(dag);
    return dag;
  }

  loadCursor(): Promise<number> {
    return this.cursor.load();
  }

  saveCursor(cursor: number): Promise<void> {
    return this.cursor.save(cursor);
  }
}
