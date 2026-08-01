// ─────────────────────────────────────────────
//  File Identity Registry
//  Phase 1.2
// ─────────────────────────────────────────────
//
//  Maintains a stable UUID → path mapping so files can be tracked
//  through renames and moves. Stored at .opsblobs/file-registry.json.

import { FileEntry, HLC, SyncSettings } from '../types';
import { MetadataStore } from '../ports/metadata-store';
import { VaultFiles, VaultFileStat } from '../ports/vault-files';
import { VersionDag, ReachableBounds } from './version-dag';
import { hlcCompare, hlcToString } from './hlc';
import { nowMs } from './perf-clock';
import { isExcluded } from './exclusion-policy';
import { randomUuid } from './encoding';

const REGISTRY_DIR = '.opsblobs';
const REGISTRY_PATH = '.opsblobs/file-registry.json';
/** The append-only NDJSON journal of entry mutations since the last snapshot
 *  (docs/registry-append-journal-spec.md §1). Each checkpoint `flush()` appends
 *  only the touched entries here (O(delta)) rather than rewriting the whole
 *  snapshot (O(N)); `compact()` folds it back into {@link REGISTRY_PATH} and
 *  truncates it. Mirrors `ContentStore`'s pack/index journal. */
const REGISTRY_JOURNAL_PATH = '.opsblobs/file-registry.journal';

/** A tombstone is never reclaimed until its deletion is at least this old, however
 *  short `ancestorRetentionDays` is set. The two windows share a *rationale* (past it,
 *  a merge base has no bytes left and a delete has reached every peer that still
 *  syncs) but not a *failure mode*: dropping a base's bytes early degrades a deep
 *  merge to a visible conflict, whereas dropping a tombstone early lets a peer that
 *  never pulled the delete resurrect the file. So shrinking the blob window to reclaim
 *  disk must not also shrink this safety margin. Equal to the default
 *  `ancestorRetentionDays` (30), so the default behaviour is exactly "reuse the blob
 *  window". See {@link FileRegistry.reclaimTombstones}. */
const MIN_TOMBSTONE_RETENTION_MS = 30 * 86_400_000;

/** The inputs {@link FileRegistry.compact} needs to reclaim stale tombstones. Absent →
 *  compaction is a pure journal fold and the entry set is left untouched. */
export interface TombstoneReclaim {
  /** Wall-clock now, in ms. Injected (never read from `Date.now()` inside) so the
   *  horizon is deterministic under test — mirrors `ContentStore.gc(keep, ms, now)`. */
  now: number;
  /** fileIds a still-*pending* (un-pushed) op references. A tombstone whose delete op
   *  hasn't reached the server yet must survive: no peer has seen the delete, so
   *  dropping the entry would leave the pending op citing an identity the registry no
   *  longer holds. Supply it only from a post-push checkpoint. */
  pinned: ReadonlySet<string>;
}

type SerializedRegistry = {
  version: number;
  entries: Array<[string, FileEntry]>;   // [uuid, entry]
};

/** A hard-delete journal record — a `{del:<uuid>}` line removes the id from the
 *  Map on replay (the `adoptRemote` divergent-duplicate drop). Distinct from an
 *  entry's ordinary `deleted:true` *tombstone flag*, which is a normal upsert. */
type JournalDelete = { del: string };

/** When non-null, {@link FileRegistry.flush} accumulates its serialize (JSON.stringify)
 *  time apart from its native-write time here — the load-bearing sub-split of the
 *  first-enable checkpoint cost (docs/oplog-append-journal-spec.md §3 Step 1: is the
 *  per-checkpoint registry rewrite CPU or the bridge?). Set by `main.ts` around the
 *  first-enable capture only (sink-gated), so a normal enable pays nothing; null by
 *  default → zero overhead. Mirrors `ContentStore.capturePutPerf` /
 *  `ObsidianMetadataStore.captureWritePerf`. */
export interface FlushPerf {
  stringifyMs: number;  // Σ JSON.stringify(the touched-entry delta) at capture checkpoints
  writeMs: number;      // Σ metadata.append of the delta to the journal at capture checkpoints
}

export class FileRegistry {
  private entries: Map<string, FileEntry> = new Map();  // uuid → entry
  private pathIndex: Map<string, string> = new Map();   // path → uuid

  /** When true, `save()` only marks the registry dirty instead of writing — a batch
   *  (e.g. captureOfflineChanges over thousands of files) suspends the per-mutation
   *  autosave so it doesn't re-serialize the WHOLE registry once per file (the O(F²)
   *  rewrite that saturates GC on mobile), then `flush()`es periodically. */
  private deferSave = false;
  /** Ids upserted-or-hard-deleted since the last `flush()` append — the delta a
   *  checkpoint must journal. Resolved against the live Map at flush time: still
   *  present → an upsert line, gone → a `{del}` line. A single Set collapses any
   *  number of intra-window mutations to the same id into one appended line
   *  (register → setHeadVersion → recordStat → one line). */
  private dirtyIds: Set<string> = new Set();

  /** Journal accounting since the last snapshot, for the compaction size-valves
   *  (docs/registry-append-journal-spec.md §3). `journalBytes`/`journalRecords`
   *  grow with each append and reset on `compact()`; `snapshotBytes` is the size
   *  of the current on-disk snapshot. Tracked in-memory so the valve needs no
   *  extra read. */
  private journalBytes = 0;
  private journalRecords = 0;
  private snapshotBytes = 0;

  /** When non-null, `flush()` records its serialize-vs-write sub-split here (A3 capture
   *  diagnostics, docs/oplog-append-journal-spec.md §3 Step 1). Set by `main.ts` around
   *  the first-enable capture; null otherwise → zero overhead. */
  captureFlushPerf: FlushPerf | null = null;

  constructor(
    private metadata: MetadataStore,
    private files: VaultFiles,
    private deviceId: string,
    private getSettings: () => SyncSettings,
  ) {}

  // ─── Persistence ──────────────────────────────────────────────────────────

  /** Rebuild the in-memory Map from the on-disk snapshot, then replay the
   *  append-journal over it last-write-wins (docs/registry-append-journal-spec.md §3).
   *  The Map produced is byte-identical to the pre-journal format's, so every
   *  consumer (`getById`/`getByPath`/`referencedHashes`/…) is untouched. A torn
   *  trailing journal line (crash mid-append) is dropped — append only ever cuts the
   *  end, so interior lines are intact; a dropped tail strands that file (registry
   *  slightly behind → rebaseline heals), never orphans an op (§4). An old flat
   *  `file-registry.json` with no journal loads exactly as before (§5 migration). */
  async load(): Promise<void> {
    const snapRaw = await this.metadata.read(REGISTRY_PATH);
    this.entries = snapRaw
      ? new Map((JSON.parse(snapRaw) as SerializedRegistry).entries)
      : new Map();
    this.snapshotBytes = snapRaw?.length ?? 0;

    const jrnl = await this.metadata.read(REGISTRY_JOURNAL_PATH);
    let records = 0;
    if (jrnl !== null) {
      for (const line of jrnl.split('\n')) {
        if (line === '') continue;
        let rec: JournalDelete | FileEntry;
        try { rec = JSON.parse(line); } catch { continue; } // torn trailing line → drop
        if (typeof (rec as JournalDelete).del === 'string') {
          this.entries.delete((rec as JournalDelete).del);
        } else if (typeof (rec as FileEntry).id === 'string') {
          this.entries.set((rec as FileEntry).id, rec as FileEntry); // last-write-wins
        }
        records++;
      }
    }
    this.journalBytes = jrnl?.length ?? 0;
    this.journalRecords = records;

    this.rebuildPathIndex();
    this.dirtyIds.clear();
    await this.maybeCompactOnLoad();
  }

  async save(id?: string): Promise<void> {
    if (id !== undefined) this.dirtyIds.add(id);
    if (this.deferSave) return;   // batched — defer the write to flush()
    await this.flush();
  }

  /** Append the touched-entry delta to the journal if any mutation is pending (a
   *  no-op otherwise) — O(delta), not the former O(N) whole-registry rewrite. Used
   *  both by the per-mutation `save()` and, while saves are suspended, by a batch's
   *  explicit checkpoint. Resolves each touched id against the live Map: present →
   *  an upsert line, gone → a `{del}` line. Off the deferred (capture) path it also
   *  runs the compaction size-valve so a long-lived interactive session can't grow
   *  the journal unbounded (§3.4). */
  async flush(): Promise<void> {
    if (this.dirtyIds.size === 0) return;
    await this.ensureDir();
    // Serialize-vs-write sub-split (sink-gated): the delta serialize vs the native
    // append — both now O(delta), confirming the post-fix floor (Step 1 metrics).
    const ts = nowMs();
    let delta = '';
    let records = 0;
    for (const id of this.dirtyIds) {
      const e = this.entries.get(id);
      delta += (e ? JSON.stringify(e) : JSON.stringify({ del: id })) + '\n';
      records++;
    }
    if (this.captureFlushPerf) this.captureFlushPerf.stringifyMs += nowMs() - ts;
    const tw = nowMs();
    // One native append per checkpoint — the O(delta) win (mirrors ContentStore.flushPack).
    await this.metadata.append(REGISTRY_JOURNAL_PATH, delta);
    if (this.captureFlushPerf) this.captureFlushPerf.writeMs += nowMs() - tw;
    this.journalBytes += delta.length;
    this.journalRecords += records;
    this.dirtyIds.clear();
    // Safety valve — never on the deferred capture path (checkpoints are pure appends,
    // which is what keeps the O(N²) rewrite from sneaking back in). Amortized O(1).
    if (!this.deferSave && this.shouldCompact()) await this.compact();
  }

  /** Fold the journal back into the snapshot and truncate it. Snapshot first,
   *  truncate second — never the reverse: a crash after the snapshot write but
   *  before the truncate leaves a redundant journal that replays idempotently
   *  (last-write-wins) onto an already-current snapshot; a crash that truncated
   *  first would lose every mutation the journal still held. Both writes are atomic
   *  (tmp+rename), so neither can tear. Runs off the per-checkpoint hot path only —
   *  at capture/merge end, opportunistically on load, or the live-path valve (§3).
   *
   *  When `reclaim` is supplied this is also where stale tombstones are dropped (see
   *  {@link reclaimTombstones}) — the one place that already rewrites the whole
   *  snapshot, so the drop costs nothing extra and is durable by construction (full
   *  rewrite + journal truncate) without needing a `{del}` journal line of its own. */
  async compact(reclaim?: TombstoneReclaim): Promise<void> {
    // Prune before serializing, so the snapshot written below IS the pruned Map.
    const dropped = reclaim ? this.reclaimTombstones(reclaim) : 0;
    // Nothing journalled since the last snapshot and nothing dropped → the snapshot
    // already reflects the current Map, so there is nothing to fold. Skipping keeps a
    // routine no-op capture (and an empty vault) from redundantly rewriting the
    // snapshot / creating files. A drop forces the rewrite even with an empty journal —
    // otherwise the entry would be gone from memory but still in the snapshot, and the
    // next `load()` would resurrect it.
    if (this.journalRecords === 0 && dropped === 0) return;
    await this.ensureDir();
    const data: SerializedRegistry = {
      version: 1,
      entries: Array.from(this.entries.entries()),
    };
    // No pretty-print — the snapshot is machine-read; `null, 2` ~doubles the bytes.
    const json = JSON.stringify(data);
    await this.metadata.write(REGISTRY_PATH, json);   // atomic
    await this.metadata.write(REGISTRY_JOURNAL_PATH, '');  // atomic truncate — MUST come second
    this.snapshotBytes = json.length;
    this.journalBytes = 0;
    this.journalRecords = 0;
    this.dirtyIds.clear();
  }

  /** Wipe the registry back to empty — in-memory and on disk (vault-switch guard).
   *  Unlike `compact()`, which folds the journal into the snapshot, this discards
   *  both: every entry's headVersionId points into a version DAG that a vault
   *  switch also clears, so keeping stale entries around would let a later capture
   *  resolve merges against a base that no longer exists. */
  async resetAll(): Promise<void> {
    this.entries = new Map();
    this.pathIndex = new Map();
    this.dirtyIds.clear();
    this.journalBytes = 0;
    this.journalRecords = 0;
    this.snapshotBytes = 0;
    if (await this.metadata.exists(REGISTRY_PATH)) await this.metadata.remove(REGISTRY_PATH);
    if (await this.metadata.exists(REGISTRY_JOURNAL_PATH)) await this.metadata.remove(REGISTRY_JOURNAL_PATH);
  }

  /** Suspend the per-mutation autosave (mutations mark the registry dirty but don't
   *  write). Pair with `flush()` to persist at controlled checkpoints and
   *  `resumeSaves()` to restore normal behaviour — always in a `finally`. */
  suspendSaves(): void { this.deferSave = true; }

  /** Restore the per-mutation autosave. Does NOT flush — call `flush()` first to
   *  persist anything accumulated while suspended. */
  resumeSaves(): void { this.deferSave = false; }

  // ─── Mutation ─────────────────────────────────────────────────────────────

  /** Register a newly created file. Returns the assigned UUID. `stat` (present when
   *  the caller hashed the file off a listing) seeds the O1 capture stat-gate cache;
   *  omitted by the live create-handler, which self-heals on the next capture. */
  async registerFile(path: string, hlc: HLC, contentHash: string, stat?: VaultFileStat): Promise<string> {
    const existing = this.pathIndex.get(path);
    if (existing) {
      // A create event for a path we still track as a TOMBSTONE is a re-create: the
      // file was deleted, then a new file was made at the same path. Resurrect the
      // entry in place (reusing its id) so it isn't left marked `deleted` with a stale
      // contentHash while the caller's setHeadVersion advances its head to the new
      // create op — otherwise buildLocalState would project the just-created file as
      // deleted. The create op is still a fresh DAG root (`parents: []`); this fixes
      // only local registry consistency, not the causal link, so a peer that deleted
      // the file still sees a delete/create conflict (the safe outcome), not a silent
      // un-delete.
      const entry = this.entries.get(existing);
      if (entry && entry.deleted) {
        entry.deleted = false;
        entry.contentHash = contentHash;
        entry.hlcTimestamp = hlc;
        if (stat) { entry.mtime = stat.mtime; entry.size = stat.size; }
        await this.save(existing);
      }
      return existing;   // already tracked (live), or resurrected just now
    }

    const id = this.generateUUID();
    const entry: FileEntry = {
      id,
      path,
      contentHash,
      hlcTimestamp: hlc,
      deleted: false,
      // Not synced yet — no last-synced path, and the create op's id becomes the
      // head via setHeadVersion once the OperationLogger has minted it.
      lastSyncedPath: null,
      headVersionId: null,
      ...(stat ? { mtime: stat.mtime, size: stat.size } : {}),
    };
    this.entries.set(id, entry);
    this.pathIndex.set(path, id);
    await this.save(id);
    return id;
  }

  /** Update the path for an existing UUID (rename/move). */
  async updatePath(oldPath: string, newPath: string, hlc: HLC): Promise<void> {
    const id = this.pathIndex.get(oldPath);
    if (!id) return;

    const entry = this.entries.get(id)!;
    this.pathIndex.delete(oldPath);
    entry.path = newPath;
    entry.hlcTimestamp = hlc;
    this.pathIndex.set(newPath, id);
    this.entries.set(id, entry);
    await this.save(id);
  }

  /** Update the content hash for a file after modification. `stat` (present when the
   *  caller hashed off a listing) refreshes the O1 capture stat-gate cache. */
  async updateContentHash(path: string, contentHash: string, hlc: HLC, stat?: VaultFileStat): Promise<void> {
    const id = this.pathIndex.get(path);
    if (!id) return;

    const entry = this.entries.get(id)!;
    entry.contentHash = contentHash;
    entry.hlcTimestamp = hlc;
    if (stat) { entry.mtime = stat.mtime; entry.size = stat.size; }
    this.entries.set(id, entry);
    await this.save(id);
  }

  /**
   * Record the file's on-disk `mtime`/`size` after a capture hashed its content and
   * found it UNCHANGED (O1 self-heal). The stat drifted — a sync wrote the file, or
   * this entry predates the gate — but the bytes still match, so no op is emitted;
   * we only refresh the cheap-gate cache so the next capture skips the read+hash.
   * No-op if the path is unknown.
   */
  async recordStat(path: string, mtime: number, size: number): Promise<void> {
    const id = this.pathIndex.get(path);
    if (!id) return;
    const entry = this.entries.get(id)!;
    entry.mtime = mtime;
    entry.size = size;
    this.entries.set(id, entry);
    await this.save(id);
  }

  /** Mark a file as deleted (tombstone). */
  async markDeleted(path: string, hlc: HLC): Promise<void> {
    const id = this.pathIndex.get(path);
    if (!id) return;

    const entry = this.entries.get(id)!;
    entry.deleted = true;
    entry.hlcTimestamp = hlc;
    this.entries.set(id, entry);
    // Keep path index for now — GC will clean up
    await this.save(id);
  }

  /** Apply a remote FileEntry (during merge). */
  async applyRemoteEntry(entry: FileEntry): Promise<void> {
    const existing = this.entries.get(entry.id);
    if (existing && hlcCompare(existing.hlcTimestamp, entry.hlcTimestamp) >= 0) {
      return; // our version is newer or equal, don't overwrite
    }
    // Remove old path index entry if path changed
    if (existing && existing.path !== entry.path) {
      this.pathIndex.delete(existing.path);
    }
    this.entries.set(entry.id, { ...entry });
    if (!entry.deleted) {
      this.pathIndex.set(entry.path, entry.id);
    }
    await this.save(entry.id);
  }

  /**
   * Adopt a file's identity from the remote side after its content has been
   * written locally: track `path` under the remote's `id` so both devices key it
   * the same way. The state merge is id-based — if each device kept its own id
   * for the same path, their edits would look like unrelated files and could
   * never conflict or converge (permanent divergence). Any pre-existing local
   * entry at this path under a *different* id is dropped as a divergent
   * duplicate. The just-written content becomes the new synced ancestor.
   */
  async adoptRemote(id: string, path: string, contentHash: string, hlc: HLC, headVersionId?: string): Promise<void> {
    const existingId = this.pathIndex.get(path);
    if (existingId && existingId !== id) {
      this.entries.delete(existingId);
      // A hard Map-delete (divergent-duplicate drop) — journal a `{del}` line for it,
      // since it's no longer in the Map for flush() to resolve as an upsert.
      this.dirtyIds.add(existingId);
    }
    // If this id currently lives at a DIFFERENT path, drop that stale path→id
    // mapping — otherwise a rename adopted alongside a content merge (H5) leaves
    // the old path indexed, so a later reconcile could tombstone the moved file or
    // refuse to track a new file created at the old path.
    const prev = this.entries.get(id);
    if (prev && prev.path !== path) {
      this.pathIndex.delete(prev.path);
    }
    this.entries.set(id, {
      id,
      path,
      contentHash,
      hlcTimestamp: hlc,
      deleted: false,
      // The path we just synced to becomes the last-synced path, so a later local
      // rename reads as a change since the sync (delete-vs-rename detection). The
      // content base is the op-id DAG's LCA, not a scalar hash, so no ancestor
      // content is recorded here.
      lastSyncedPath: path,
      // Adopting a remote version makes that version this file's head. For a plain
      // remote write / fast-forward / conflict resolution the adopted op's id is
      // `hlcToString(hlc)` (an op's id is the string form of its HLC), so the head
      // is derivable from the hlc the applicator passes. A clean *merge* node has a
      // content-addressed id that is NOT `hlcToString(hlc)`, so the applicator
      // passes it explicitly (`headVersionId`) — otherwise the head would name a
      // version-id no DAG node carries and the next edit would lose its base.
      headVersionId: headVersionId ?? hlcToString(hlc),
    });
    this.pathIndex.set(path, id);
    await this.save(id);
  }

  /**
   * Advance a file's head to `versionId` — the op-id of the content version it
   * now points at (sync v2). Called by the OperationLogger right after it mints a
   * content op (create/update/delete/resolution) with that op's id, so the next
   * local edit descends from it. A `move` never calls this: a rename is not a new
   * content version, so the head is unchanged. No-op if the file is unknown.
   */
  async setHeadVersion(fileId: string, versionId: string): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    entry.headVersionId = versionId;
    this.entries.set(fileId, entry);
    await this.save(fileId);
  }

  /**
   * Mark a file *two-headed*: a text conflict was surfaced as inline zdiff3 markers
   * written to `path`, and both `parents` (the two conflicting head version-ids) stay
   * open until the user resolves (sync v2 Step 5). Records the markers' hash as the
   * entry's content (so a stray modify event for our own marker write is suppressed by
   * the hash-equality guard) and stores the open heads. The head version is left
   * unchanged — the markers are a local working copy, not a new pushed version; the
   * resolving save mints the merge node that closes both heads. No-op if unknown.
   */
  async markConflicted(path: string, contentHash: string, hlc: HLC, parents: string[]): Promise<void> {
    const id = this.pathIndex.get(path);
    if (!id) return;
    const entry = this.entries.get(id)!;
    entry.contentHash = contentHash;
    entry.hlcTimestamp = hlc;
    entry.conflictParents = parents;
    this.entries.set(id, entry);
    await this.save(id);
  }

  /** Clear a file's two-headed (conflict-awaiting-resolution) marker — called when
   *  the user's save removed the markers and the resolving merge node was minted, or
   *  when a peer's resolution was adopted. No-op if unknown. */
  async clearConflict(fileId: string): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry || entry.conflictParents == null) return;
    delete entry.conflictParents;
    this.entries.set(fileId, entry);
    await this.save(fileId);
  }

  /** Record the file's current path as its last-synced path after a successful
   *  sync (a no-op / send_remote that leaves it in sync). A later local rename then
   *  reads as a change since the last sync, so a concurrent delete surfaces as a
   *  delete/rename conflict. The content base lives in the op-id DAG (LCA), so no
   *  content hash is recorded — only the path. */
  async setSyncedPath(fileId: string): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    entry.lastSyncedPath = entry.path;
    this.entries.set(fileId, entry);
    await this.save(fileId);
  }

  // ─── Scan & reconcile ─────────────────────────────────────────────────────

  /**
   * Scan the entire vault and reconcile against the registry.
   * - Assigns UUIDs to untracked files
   * - Marks registry entries as deleted if the file is gone from disk
   */
  async reconcileWithVault(hlc: HLC): Promise<void> {
    const allFiles = this.files.list();
    const vaultPaths = new Set(allFiles.map(f => f.path));

    // Assign UUIDs to new files
    for (const file of allFiles) {
      if (!this.pathIndex.has(file.path) && !this.isExcluded(file.path)) {
        const id = this.generateUUID();
        const entry: FileEntry = {
          id,
          path: file.path,
          contentHash: '',   // will be filled in by operation logger
          hlcTimestamp: hlc,
          deleted: false,
          lastSyncedPath: null,
          headVersionId: null,   // set once its first op is minted
        };
        this.entries.set(id, entry);
        this.pathIndex.set(file.path, id);
        this.dirtyIds.add(id);
      }
    }

    // Mark deleted entries for files no longer on disk
    for (const [id, entry] of this.entries) {
      if (!entry.deleted && !vaultPaths.has(entry.path)) {
        entry.deleted = true;
        entry.hlcTimestamp = hlc;
        this.entries.set(id, entry);
        this.dirtyIds.add(id);
      }
    }

    await this.save();
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getById(id: string): FileEntry | undefined {
    return this.entries.get(id);
  }

  getByPath(path: string): FileEntry | undefined {
    const id = this.pathIndex.get(path);
    return id ? this.entries.get(id) : undefined;
  }

  getAllEntries(): Map<string, FileEntry> {
    return new Map(this.entries);
  }

  /**
   * A read-only iterator over every entry (live *and* tombstoned), in insertion
   * order — the allocation-free counterpart to {@link getAllEntries}, whose defensive
   * `new Map(this.entries)` copy costs O(F) per call. Use this for any *counting* or
   * *scanning* read: the conflict count behind the status bar and ribbon recomputes
   * after every debounced edit, so a Map copy there is O(F) churn per save on a
   * registry that only ever grows.
   *
   * Callers must treat the yielded entries as read-only (they are the live objects,
   * not copies) and must not mutate the registry while iterating — go through the
   * mutation methods above.
   */
  entriesIterator(): IterableIterator<FileEntry> {
    return this.entries.values();
  }

  getActiveEntries(): FileEntry[] {
    return Array.from(this.entries.values()).filter(e => !e.deleted);
  }

  /**
   * The content hashes still referenced by the registry — the keep-set for
   * garbage-collecting the content store. A live (non-deleted) entry keeps its
   * current content. When a {@link VersionDag} is supplied (sync v2, Step 8), the
   * keep-set additionally retains the bytes of every version *reachable from each
   * live head* — the plausible three-way merge bases, since `LCA(head, peerHead)`
   * is always an ancestor of `head`. Retaining them keeps deep merges byte-exact
   * across the retention window; a base that IS dropped (unreachable, or the DAG is
   * absent) degrades a deep merge to a conflict (safe — the merge surfaces markers
   * rather than fabricating an empty ancestor), never data loss. The DAG parent
   * links themselves are tiny and persisted separately, so they outlive the bytes.
   *
   * `bounds` bounds each head's ancestor walk (see
   * {@link VersionDag.reachableContentHashes}) so the keep-set costs O(live entries ×
   * retained history) instead of O(live entries × edits-ever). Pass the content
   * store's `hasStored` as `bounds.has`: a hash the store does not hold cannot be
   * garbage-collected anyway (GC only ever deletes what it holds), so cutting the
   * walk there never shortens the keep-set below what `gc()` needs — the boundary
   * hash is still returned, and only strictly-older ancestors are dropped. Do NOT
   * pass a `maxDepth` shorter than the retention window: that WOULD drop still-stored
   * bases and let GC delete them early.
   */
  referencedHashes(dag?: VersionDag, bounds?: ReachableBounds): Set<string> {
    const keep = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.deleted) continue;
      if (entry.contentHash) keep.add(entry.contentHash);
      if (dag && entry.headVersionId) {
        for (const hash of dag.reachableContentHashes(entry.headVersionId, bounds)) keep.add(hash);
      }
    }
    return keep;
  }

  /**
   * Every version-id the registry still names — the root set for
   * {@link VersionDag.prune}'s mark-and-sweep. Deliberately *wider* than
   * {@link referencedHashes}' roots, which cover only live entries' content:
   *
   *  · **Tombstoned entries too.** A tombstone's head is what makes a peer's late edit to
   *    a file we deleted surface as a delete/edit conflict; dropping its lineage would
   *    take the base for that merge with it. (Once the tombstone itself is reclaimed past
   *    its horizon the entry is gone from here and the subgraph becomes collectable —
   *    which is exactly the garbage this sweep exists to reclaim.)
   *  · **Both `conflictParents`.** While a file is two-headed, the *remote* head is not
   *    the entry's `headVersionId` and is named nowhere else; the resolving save re-emits
   *    it as the merge node's second parent, so it must survive until then.
   *
   * Ancestors are not listed — `prune` walks them itself. Callers should union in any
   * version-ids held outside the registry (the pending oplog) before sweeping.
   */
  versionRoots(): Set<string> {
    const roots = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.headVersionId) roots.add(entry.headVersionId);
      if (entry.conflictParents) {
        for (const p of entry.conflictParents) if (p) roots.add(p);
      }
    }
    return roots;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Drop tombstones that are safely past the retention horizon; returns how many.
   * Called only from {@link compact}.
   *
   * WHY. `markDeleted` only flips `deleted = true` — the entry then sits in the Map
   * forever (the sole other hard-delete is `adoptRemote`'s divergent-duplicate drop).
   * So the registry grows with the vault's *lifetime* file churn even when the live
   * file count is flat: create and delete a scratch note daily for a year and you
   * carry 365 dead entries that are re-serialized by every `compact()`, re-parsed by
   * every `load()`, re-iterated by `buildLocalIdentity` every round, and unioned by
   * every merge. Reclaiming bounds the registry by the live vault plus one retention
   * window of churn instead.
   *
   * An entry is dropped only when ALL of:
   *  · it is a tombstone (`deleted`);
   *  · its deletion is at least {@link tombstoneRetentionMs} old, measured on the HLC
   *    wall time `markDeleted` stamped. An HLC merged from a remote can run *ahead* of
   *    real time, which only ever makes a tombstone look younger — it is retained
   *    longer, never dropped sooner, so the drift direction is the safe one;
   *  · no pending op references it ({@link TombstoneReclaim.pinned}) — i.e. its delete
   *    is already on the server;
   *  · it carries no `conflictParents` — an unresolved conflict is still the user's to
   *    settle and the Conflicts panel reads it straight off the registry.
   *
   * THE TRADEOFF (deliberate; it is what the horizon buys time against). The tombstone
   * is what makes a peer's *late* edit to a file we deleted surface as a delete/edit
   * conflict. Once it's gone we hold no entry for that id, so such an op reads as a
   * plain new remote file and the file comes back. That is a *visible* resurrection,
   * not silent divergence (guide §7's actual enemy): nothing is dropped or overwritten,
   * and it takes a peer that went a full retention window without pulling our delete.
   * The durable record of a delete is the **server op log**, not this Map — a fresh
   * device replays the delete op and rebuilds the tombstone — so reclaiming here is a
   * local-cache decision of the same kind as the blob and DAG windows.
   *
   * Dropping an id does not prune its version-DAG nodes here, but it does make them
   * collectable: the entry no longer appears in {@link versionRoots}, so the next
   * reachability sweep (`sweepToRoots`, run on the GC's schedule) takes the whole
   * subgraph. Until then they are harmless — tiny, and unreachable from any live head, so
   * they stop feeding `referencedHashes`' keep-set immediately.
   */
  private reclaimTombstones({ now, pinned }: TombstoneReclaim): number {
    const horizon = now - this.tombstoneRetentionMs();
    let dropped = 0;
    // Deleting the current key while iterating a Map is well-defined (the iterator
    // only ever moves forward over remaining entries).
    for (const [id, entry] of this.entries) {
      if (!entry.deleted) continue;
      if (entry.conflictParents) continue;
      if (pinned.has(id)) continue;
      if (entry.hlcTimestamp.wallTime > horizon) continue;
      this.entries.delete(id);
      // `markDeleted` deliberately leaves the path→id mapping in place so a re-create
      // can resurrect the entry under its original id. With the entry gone that mapping
      // would dangle and `registerFile` would hand back an id the Map no longer holds,
      // so drop it too: a later re-create at this path mints a fresh id, exactly as it
      // would for a brand-new file (the create op is a fresh DAG root either way, so a
      // peer still holding the file sees a create/create collision — F2 converges it).
      if (this.pathIndex.get(entry.path) === id) this.pathIndex.delete(entry.path);
      dropped++;
    }
    return dropped;
  }

  /** How long a tombstone must have been dead before it can be reclaimed: the blob
   *  retention window, floored at {@link MIN_TOMBSTONE_RETENTION_MS}. */
  private tombstoneRetentionMs(): number {
    // `ancestorRetentionDays` comes from user-editable JSON; a missing/garbage value
    // must fall back to the floor, never propagate a NaN — `wallTime > now - NaN` is
    // false for every entry, which would make the whole tombstone set droppable.
    const days = this.getSettings().ancestorRetentionDays;
    const configured = Number.isFinite(days) ? days * 86_400_000 : 0;
    return Math.max(configured, MIN_TOMBSTONE_RETENTION_MS);
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.metadata.exists(REGISTRY_DIR))) {
      await this.metadata.mkdir(REGISTRY_DIR);
    }
  }

  /** Whether the journal has grown large enough relative to the snapshot to be
   *  worth folding back in — the compaction trigger shared by the load-time and
   *  live-path valves (§3). Bounds both subsequent load cost and live-session
   *  journal growth. */
  private shouldCompact(): boolean {
    return this.journalBytes > this.snapshotBytes ||
      this.journalRecords > Math.max(1000, 2 * this.entries.size);
  }

  /** Opportunistic compaction on load: the read+replay was already paid, so folding
   *  a large journal back into the snapshot here is near-free and bounds every
   *  subsequent load (§3.3). */
  private async maybeCompactOnLoad(): Promise<void> {
    if (this.journalRecords > 0 && this.shouldCompact()) await this.compact();
  }

  private rebuildPathIndex(): void {
    this.pathIndex = new Map();
    for (const [id, entry] of this.entries) {
      if (!entry.deleted) {
        this.pathIndex.set(entry.path, id);
      }
    }
  }

  private isExcluded(path: string): boolean {
    return isExcluded(path, this.getSettings());
  }

  private generateUUID(): string {
    return randomUuid();
  }
}
