// ─────────────────────────────────────────────
//  File Identity Registry
//  Phase 1.2
// ─────────────────────────────────────────────
//
//  Maintains a stable UUID → path mapping so files can be tracked
//  through renames and moves. Stored at .vault-sync/file-registry.json.

import { App, TFile, normalizePath } from 'obsidian';
import { FileEntry, HLC, SyncSettings } from '../types';
import { hlcCompare } from './hlc';
import { isExcluded } from './exclusion-policy';

const REGISTRY_PATH = '.vault-sync/file-registry.json';

type SerializedRegistry = {
  version: number;
  entries: Array<[string, FileEntry]>;   // [uuid, entry]
};

export class FileRegistry {
  private entries: Map<string, FileEntry> = new Map();  // uuid → entry
  private pathIndex: Map<string, string> = new Map();   // path → uuid

  constructor(
    private app: App,
    private deviceId: string,
    private getSettings: () => SyncSettings,
  ) {}

  // ─── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(REGISTRY_PATH);
      const data = JSON.parse(raw) as SerializedRegistry;
      this.entries = new Map(data.entries);
      this.rebuildPathIndex();
    } catch {
      // Registry doesn't exist yet — start fresh
      this.entries = new Map();
      this.pathIndex = new Map();
    }
  }

  async save(): Promise<void> {
    const data: SerializedRegistry = {
      version: 1,
      entries: Array.from(this.entries.entries()),
    };
    const dir = normalizePath('.vault-sync');
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(REGISTRY_PATH, JSON.stringify(data, null, 2));
  }

  // ─── Mutation ─────────────────────────────────────────────────────────────

  /** Register a newly created file. Returns the assigned UUID. */
  async registerFile(file: TFile, hlc: HLC, contentHash: string): Promise<string> {
    const existing = this.pathIndex.get(file.path);
    if (existing) return existing;   // already tracked

    const id = this.generateUUID();
    const entry: FileEntry = {
      id,
      path: file.path,
      contentHash,
      hlcTimestamp: hlc,
      deleted: false,
      ancestorContentHash: null,
    };
    this.entries.set(id, entry);
    this.pathIndex.set(file.path, id);
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
  async adoptRemote(id: string, path: string, contentHash: string, hlc: HLC): Promise<void> {
    const existingId = this.pathIndex.get(path);
    if (existingId && existingId !== id) {
      this.entries.delete(existingId);
    }
    this.entries.set(id, {
      id,
      path,
      contentHash,
      hlcTimestamp: hlc,
      deleted: false,
      ancestorContentHash: contentHash,
      ancestorPath: path,
    });
    this.pathIndex.set(path, id);
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
    const allFiles = this.app.vault.getFiles();
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
    // Crypto.randomUUID() is available on all modern platforms including iOS
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
