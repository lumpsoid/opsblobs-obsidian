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
import { VaultFiles, VaultFileRef } from '../ports/vault-files';
import { FileRegistry } from '../core/file-registry';
import { ContentStore, hashContent } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { SyncApplicator } from './sync-applicator';
import { HybridLogicalClock } from '../core/hlc';
import { CursorStore } from './cursor-store';
import { VersionDagStore, EdgeRecord } from './version-dag-store';
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

  /** Load the persisted version-DAG once for the whole round. `runSync` calls this
   *  a single time after the key/dag guard and threads the instance into
   *  `dagNeedsRebuild`, `buildLocalState`, and `recordVersionEdges`, so the graph is
   *  deserialized once per round instead of three times (round-residual spec §3). */
  loadDag(): Promise<VersionDag> {
    return this.versionDagStore.load();
  }

  /**
   * Snapshot the local vault for a sync round: the registry entries, the
   * un-pushed pending ops, and a content store populated with the current bytes
   * of every live file (covers every pending op's content, whose hash equals the
   * live entry's) plus any retained ancestor content the three-way merge needs.
   *
   * `dag` is the round's single loaded graph (see {@link loadDag}). We must NOT
   * mutate it: `recordVersionEdges` later journals this round's genuinely-new edges
   * by asking `addVersion` whether each is absent, so pre-adding the pending ops
   * here would make it return `false` and silently drop them from the journal
   * (round-residual spec §3.1). Fold them into a private `clone()` instead.
   */
  async buildLocalState(dag: VersionDag): Promise<VaultState> {
    const fileEntries = new Map<string, FileEntry>();
    const contentStore = new Map<string, Uint8Array>();
    // Stage the bytes of every version reachable from each file's head (its
    // ancestors). The three-way merge base LCA(localHead, peerHead) is always one of
    // these, so pre-staging them makes any base available to the pure merge —
    // including one deeper than the last-synced version (a multi-round offline
    // divergence), which the scalar ancestor alone could not reach (#4).
    //
    // This round's own edits aren't in the persisted DAG yet (recordVersionEdges
    // runs later), so a fresh head can't reach its base for staging. Fold the pending
    // ops into a CLONE — never the shared round DAG (see the doc comment) — so
    // reachability from each head includes the base the merge will need.
    const working = dag.clone();
    for (const op of this.opLogger.getPendingOps()) {
      if (op.type === 'move') continue;
      working.addVersion(op.id, op.parents, op.contentHash, op.fileId);
    }

    // Stat every live file once (no extra syscall — `TFile.stat` rides on the
    // listing) so the per-entry loop can gate its read+hash on an mtime/size
    // comparison, exactly as the capture pass does (R1, steady-state-round-
    // optimization-spec §3).
    const refs = new Map<string, VaultFileRef>();
    for (const r of this.files.list()) refs.set(r.path, r);

    for (const [id, entry] of this.registry.getAllEntries()) {
      let resolved = entry;

      if (!entry.deleted) {
        const ref = refs.get(entry.path);
        // ── R1 round stat-gate (steady-state-round-optimization-spec §3) ──────
        // `captureOfflineChanges` ran milliseconds ago under this exact mtime+size
        // gate and reconciled the registry with disk, so a tracked file whose stat
        // is unchanged since we last hashed it has content byte-identical to
        // `entry.contentHash`. Skip the read + SHA-256 and stage its bytes straight
        // from the content store (a memCache/blob hit), disk-reading only on a
        // store miss (no re-hash — the stat already says unchanged). This turns the
        // round's O(F) whole-vault re-hash into O(touched). A placeholder
        // (`contentHash === ''`), head-less, stat-drifted, or stat-absent entry
        // fails the strict `===` and falls through to today's read+hash +
        // snapshot-correction path unchanged — the F5 / un-opped-edit safeguards
        // (§5) are preserved up to the same heuristic capture already accepts.
        if (
          entry.headVersionId &&
          entry.contentHash !== '' &&
          ref !== undefined &&
          entry.mtime === ref.mtime &&
          entry.size === ref.size
        ) {
          let bytes = await this.contentStore.get(entry.contentHash);
          if (bytes === null) bytes = await this.files.read(entry.path);
          if (bytes !== null) contentStore.set(entry.contentHash, bytes);
        } else {
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
      }

      fileEntries.set(id, resolved);

      // Stage the bytes of every base reachable from this file's head (its DAG
      // ancestors) that the content store still holds, so the merge can three-way
      // against the true LCA even when it is deeper than the scalar ancestor.
      if (resolved.headVersionId) {
        for (const hash of working.reachableContentHashes(resolved.headVersionId)) {
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

  async applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<{ deferred: Set<string>; deferredConflicts: Set<string> }> {
    return this.applicator.applyActions(actions, local, remote);
  }

  async clearPendingOps(): Promise<void> {
    await this.opLogger.clearOps();
  }

  async recordVersionEdges(ops: Operation[], dag: VersionDag): Promise<VersionDag> {
    if (ops.length === 0) return dag;
    // Key by op-id (the version identity), carrying the content hash as the blob
    // address. A `move` carries no content parent and is not a new content version;
    // recording it is harmless (a childless node) but adds nothing, so skip it.
    //
    // Persist incrementally: append only the edges that actually changed the graph
    // (addVersion reports it) — our own ops re-pull every round, so appending
    // unconditionally would grow the journal without bound. The O(N) full rewrite
    // is deferred to a periodic compaction.
    const newEdges: EdgeRecord[] = [];
    for (const op of ops) {
      if (op.type === 'move') continue;
      if (dag.addVersion(op.id, op.parents, op.contentHash, op.fileId)) {
        newEdges.push({ v: op.id, p: op.parents, c: op.contentHash, f: op.fileId });
      }
    }
    if (newEdges.length > 0) {
      await this.versionDagStore.appendEdges(newEdges);
      if (await this.versionDagStore.shouldCompact()) {
        await this.versionDagStore.compact(dag);
      }
    }
    return dag;
  }

  async dagNeedsRebuild(dag: VersionDag): Promise<boolean> {
    // A torn/deleted version-dag.json loads as an EMPTY graph (VersionDagStore maps
    // any corruption to `new VersionDag()`). If we've consumed server ops before
    // (cursor > 0) the DAG must have been populated by recordVersionEdges, so an
    // empty graph now means it was lost — signal a rebuild-from-log. A fresh device
    // (cursor 0) legitimately has an empty DAG and is not a loss. After a rebuild
    // the DAG is non-empty, so this can't loop. Reads the round's single loaded
    // `dag` (round-residual spec §3) — no extra deserialization.
    if (await this.cursor.load() === 0) return false;
    return dag.size() === 0;
  }

  loadCursor(): Promise<number> {
    return this.cursor.load();
  }

  saveCursor(cursor: number): Promise<void> {
    return this.cursor.save(cursor);
  }
}
