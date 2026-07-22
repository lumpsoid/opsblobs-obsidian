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
    if (existing) return existing;   // already tracked

    const id = this.generateUUID();
    const entry: FileEntry = {
      id,
      path: ref.path,
      contentHash,
      hlcTimestamp: hlc,
      deleted: false,
      ancestorContentHash: null,
      // No synced version yet — the create op's id becomes the head via
      // setHeadVersion once the OperationLogger has minted it.
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
      ancestorContentHash: contentHash,
      ancestorPath: path,
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

  /** Set the ancestor (content hash + path) after a successful sync. The current
   *  path *is* the synced path at this point, so it becomes the ancestor path —
   *  a later local rename then reads as a change since the last sync. */
  async setAncestorHash(fileId: string, hash: string): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    entry.ancestorContentHash = hash;
    entry.ancestorPath = entry.path;
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
          ancestorContentHash: null,
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
   * current content; every entry with a synced ancestor keeps that ancestor.
   */
  referencedHashes(): Set<string> {
    const keep = new Set<string>();
    for (const entry of this.entries.values()) {
      if (!entry.deleted && entry.contentHash) keep.add(entry.contentHash);
      if (entry.ancestorContentHash) keep.add(entry.ancestorContentHash);
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
