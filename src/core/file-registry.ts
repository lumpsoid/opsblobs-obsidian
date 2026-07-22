// ─────────────────────────────────────────────
//  File Identity Registry
//  Phase 1.2
// ─────────────────────────────────────────────
//
//  Maintains a stable UUID → path mapping so files can be tracked
//  through renames and moves. Stored at .vault-sync/file-registry.json.

import { FileEntry, HLC, SyncSettings } from '../types';
import { MetadataStore } from '../ports/metadata-store';
import { VaultFiles, VaultFileRef } from '../ports/vault-files';
import { VersionDag } from './version-dag';
import { hlcCompare, hlcToString } from './hlc';
import { isExcluded } from './exclusion-policy';
import { randomUuid } from './encoding';

const REGISTRY_PATH = '.vault-sync/file-registry.json';

type SerializedRegistry = {
  version: number;
  entries: Array<[string, FileEntry]>;   // [uuid, entry]
};

export class FileRegistry {
  private entries: Map<string, FileEntry> = new Map();  // uuid → entry
  private pathIndex: Map<string, string> = new Map();   // path → uuid

  constructor(
    private metadata: MetadataStore,
    private files: VaultFiles,
    private deviceId: string,
    private getSettings: () => SyncSettings,
  ) {}

  // ─── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const raw = await this.metadata.read(REGISTRY_PATH);
    if (raw === null) {
      // Registry doesn't exist yet — start fresh
      this.entries = new Map();
      this.pathIndex = new Map();
      return;
    }
    const data = JSON.parse(raw) as SerializedRegistry;
    this.entries = new Map(data.entries);
    this.rebuildPathIndex();
  }

  async save(): Promise<void> {
    const data: SerializedRegistry = {
      version: 1,
      entries: Array.from(this.entries.entries()),
    };
    if (!(await this.metadata.exists('.vault-sync'))) {
      await this.metadata.mkdir('.vault-sync');
    }
    await this.metadata.write(REGISTRY_PATH, JSON.stringify(data, null, 2));
  }

  // ─── Mutation ─────────────────────────────────────────────────────────────

  /** Register a newly created file. Returns the assigned UUID. */
  async registerFile(ref: VaultFileRef, hlc: HLC, contentHash: string): Promise<string> {
    const existing = this.pathIndex.get(ref.path);
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
        await this.save();
      }
      return existing;   // already tracked (live), or resurrected just now
    }

    const id = this.generateUUID();
    const entry: FileEntry = {
      id,
      path: ref.path,
      contentHash,
      hlcTimestamp: hlc,
      deleted: false,
      // Not synced yet — no last-synced path, and the create op's id becomes the
      // head via setHeadVersion once the OperationLogger has minted it.
      lastSyncedPath: null,
      headVersionId: null,
    };
    this.entries.set(id, entry);
    this.pathIndex.set(ref.path, id);
    await this.save();
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
    await this.save();
  }

  /** Update the content hash for a file after modification. */
  async updateContentHash(path: string, contentHash: string, hlc: HLC): Promise<void> {
    const id = this.pathIndex.get(path);
    if (!id) return;

    const entry = this.entries.get(id)!;
    entry.contentHash = contentHash;
    entry.hlcTimestamp = hlc;
    this.entries.set(id, entry);
    await this.save();
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
    await this.save();
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
    await this.save();
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
    await this.save();
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
    await this.save();
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
    await this.save();
  }

  /** Clear a file's two-headed (conflict-awaiting-resolution) marker — called when
   *  the user's save removed the markers and the resolving merge node was minted, or
   *  when a peer's resolution was adopted. No-op if unknown. */
  async clearConflict(fileId: string): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry || entry.conflictParents == null) return;
    delete entry.conflictParents;
    this.entries.set(fileId, entry);
    await this.save();
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
    await this.save();
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
      }
    }

    // Mark deleted entries for files no longer on disk
    for (const [id, entry] of this.entries) {
      if (!entry.deleted && !vaultPaths.has(entry.path)) {
        entry.deleted = true;
        entry.hlcTimestamp = hlc;
        this.entries.set(id, entry);
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
   */
  referencedHashes(dag?: VersionDag): Set<string> {
    const keep = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.deleted) continue;
      if (entry.contentHash) keep.add(entry.contentHash);
      if (dag && entry.headVersionId) {
        for (const hash of dag.reachableContentHashes(entry.headVersionId)) keep.add(hash);
      }
    }
    return keep;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

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
