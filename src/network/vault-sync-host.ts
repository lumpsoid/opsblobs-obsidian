// ─────────────────────────────────────────────
//  OpsBlobs Host  (Phase 4)
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
import { dedupeOpsById } from '../core/operations';
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
   * Snapshot the local vault's IDENTITY for a sync round: the registry entries and
   * the un-pushed pending ops, with an **empty** content store. No file bytes are
   * staged — that is `stageContent`'s job, called after the pull once the round
   * knows which files the merge actually needs (A2, §4.2). This is the cheap,
   * O(vault)-map-only half that runs *before* the pull.
   *
   * It keeps the A1 stat-gate's **snapshot-correction**: for a stat-drifted file it
   * re-reads + re-hashes disk and corrects `entry.contentHash` to the true disk hash,
   * so the merge's `localAtHead` guard (guide §5) can tell a real head from an
   * unlogged in-window edit. That correction only *reads+hashes* the drift set (the
   * stat gate bounds it to O(touched)). The contentStore is otherwise **empty** —
   * with one exception: the drift set's bytes are *already in hand* from the
   * correction read, so we keep them (O(drift), tiny) rather than force `stageContent`
   * to read the same file a second time. Every un-drifted (gated) file stages nothing
   * here; that is the O(vault)→O(touched) cut.
   *
   * `dag` is the round's single loaded graph (see {@link loadDag}); identity does not
   * mutate it and does not walk it (no base staging here).
   */
  async buildLocalIdentity(dag: VersionDag): Promise<VaultState> {
    const fileEntries = new Map<string, FileEntry>();
    // Only ever holds the drift set's bytes (read for hash-correction below), so a
    // later `stageContent` doesn't re-read a file we just read. Empty on a converged
    // round (no drift).
    const contentStore = new Map<string, Uint8Array>();

    // Stat every live file once (no extra syscall — `TFile.stat` rides on the
    // listing) so the per-entry loop can gate its read+hash on an mtime/size
    // comparison, exactly as the capture pass does (R1, steady-state-round-
    // optimization-spec §3).
    const refs = new Map<string, VaultFileRef>();
    for (const r of this.files.list()) refs.set(r.path, r);

    // Iterate the registry in place (`entriesIterator`) instead of copying it —
    // `getAllEntries()`'s defensive Map copy is O(F) and this loop only reads. The copy
    // never gave a stable snapshot anyway: `new Map(this.entries)` is shallow, so a
    // live-watcher mutation between the awaits below (markDeleted, updateContentHash)
    // already showed through by reference. The one semantic delta is that a file
    // *created* mid-loop is now visited rather than missed — which matches the
    // `getPendingOps()` snapshot taken right after, so it's the more consistent side.
    for (const entry of this.registry.entriesIterator()) {
      const id = entry.id;
      let resolved = entry;

      if (!entry.deleted) {
        const ref = refs.get(entry.path);
        // ── R1 round stat-gate (steady-state-round-optimization-spec §3) ──────
        // `captureOfflineChanges` ran milliseconds ago under this exact mtime+size
        // gate and reconciled the registry with disk, so a tracked file whose stat
        // is unchanged since we last hashed it has content byte-identical to
        // `entry.contentHash` — no read, no re-hash, and the recorded hash is
        // already the true disk hash. A placeholder (`contentHash === ''`),
        // head-less, stat-drifted, or stat-absent entry fails the strict `===` and
        // falls through to the read+hash + snapshot-correction path — the F5 /
        // un-opped-edit safeguards (§5) are preserved up to the same heuristic
        // capture already accepts. Unlike pre-A2, NEITHER branch stages bytes.
        if (
          entry.headVersionId &&
          entry.contentHash !== '' &&
          ref !== undefined &&
          entry.mtime === ref.mtime &&
          entry.size === ref.size
        ) {
          // Unchanged — `entry.contentHash` is correct as recorded. No byte read.
        } else {
          const content = await this.files.read(entry.path);
          if (content !== null) {
            const hash = await hashContent(content);
            // Correct the snapshot to the *actual* disk hash, never the registry's
            // recorded one. If an edit hasn't been logged yet the recorded hash is
            // stale; leaving it would make the three-way merge's `localAtHead` guard
            // treat the stale head as representing local and adopt a remote descendant,
            // silently clobbering the in-window edit. Trust the disk.
            if (hash !== entry.contentHash) resolved = { ...entry, contentHash: hash };
            // Keep the bytes we just read under their true hash so `stageContent`
            // needn't re-read this file if the merge ends up needing it.
            contentStore.set(hash, content);
          }
        }
      }

      fileEntries.set(id, resolved);
    }

    return {
      deviceId: this.deviceId,
      hlc: this.hlc.getCurrent(),
      fileEntries,
      // Defence in depth at the push boundary: a duplicated op id is rejected by the
      // server for the whole batch, and the retry replays the same batch — so a local
      // bookkeeping fault upstream wedges sync permanently rather than transiently.
      // The dedupe is O(n) once per round (see `dedupeOpsById` for the measured cost).
      pendingOps: dedupeOpsById(this.opLogger.getPendingOps()),
      contentStore,
    };
  }

  /**
   * Fill `state.contentStore` with the bytes for exactly `hashes` — the files the
   * merge will actually reconcile this round (their local bytes + their DAG-reachable
   * bases), scoped by the caller after the pull (A2, §4.3). Each hash is served from
   * the content-cache (`ContentStore.get`, a memCache/blob hit); on a miss, if the
   * hash is a live entry's *current* content we fall back to a disk read of its path
   * (mirroring the pre-A2 staging fallback). A base whose bytes are genuinely absent
   * (GC'd / never fetched) is simply left unstaged — the merge then degrades it to a
   * conflict rather than a union (F1), exactly as before; scoping only changes *which*
   * hashes are present, never the missing-base semantics.
   *
   * Already-present hashes are skipped, so a caller may pass a superset harmlessly.
   */
  async stageContent(state: VaultState, hashes: Iterable<string>): Promise<void> {
    // A live entry's current bytes may not be in the content store yet (e.g. an
    // un-opped in-window edit); its hash maps to a real vault path we can read on a
    // store miss. Bases have no current path (they are prior versions) and so have no
    // disk fallback — a miss there correctly leaves them unstaged.
    const pathByHash = new Map<string, string>();
    for (const entry of state.fileEntries.values()) {
      if (!entry.deleted && entry.contentHash !== '') pathByHash.set(entry.contentHash, entry.path);
    }

    for (const hash of hashes) {
      if (hash === '' || state.contentStore.has(hash)) continue;
      let bytes = await this.contentStore.get(hash);
      if (bytes === null) {
        const path = pathByHash.get(hash);
        if (path !== undefined) bytes = await this.files.read(path);
      }
      if (bytes !== null) state.contentStore.set(hash, bytes);
    }
  }

  /** Whether the pack store already holds `hash` — the in-memory index/cache probe
   *  ({@link ContentStore.hasStored}), synchronous so the caller can use it as the
   *  per-node guard of the version-DAG ancestor walk (`stageForFiles`). */
  hasStoredContent(hash: string): boolean {
    return this.contentStore.hasStored(hash);
  }

  /**
   * Stage every hash the persistent pack store already durably holds into
   * `state.contentStore`, returning the set served so the pull can drop them from its
   * download list (Tier 1). NO live-path fallback (contrast {@link stageContent}): a
   * pack miss is "not held", never a disk read of a vault path keyed by this hash —
   * for a REMOTE projection that path is this device's own file, whose bytes may have
   * diverged from the remote hash, and staging them unverified would corrupt the
   * merge's view of remote. `ContentStore.get` hash-verifies (F1-safe), so a blob
   * served here is exactly as trustworthy as one downloaded and re-verified.
   */
  async stageLocalContent(state: VaultState, hashes: Iterable<string>): Promise<Set<string>> {
    const served = new Set<string>();
    for (const hash of hashes) {
      if (hash === '') continue;
      if (state.contentStore.has(hash)) { served.add(hash); continue; }
      const bytes = await this.contentStore.get(hash);
      if (bytes !== null) {
        state.contentStore.set(hash, bytes);
        served.add(hash);
      }
    }
    return served;
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
