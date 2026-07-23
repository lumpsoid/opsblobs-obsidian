// ─────────────────────────────────────────────
//  FakeMetadataStore — in-memory MetadataStore for tests
// ─────────────────────────────────────────────
//
//  A `Map<string, string>` of file contents plus a parallel mtime map so tests
//  can drive retention GC deterministically. `stat` reports the recorded mtime
//  (default 0); `setMtime` lets a test age a blob past the retention window.

import { MetadataStore } from '../../../src/ports/metadata-store';
import { IoCounters, newIoCounters } from './io-counters';

export class FakeMetadataStore implements MetadataStore {
  private files = new Map<string, string>();
  private mtimes = new Map<string, number>();
  /** Default mtime for files written without an explicit one. */
  clock = 0;
  /** `list()` semantics. The Obsidian adapter returns only files *directly*
   *  under a dir (it discards `.folders`); the fake defaults to the more
   *  permissive recursive prefix match, but a test can flip it to `'one-level'`
   *  to pin behavior against the real device semantics (e.g. sharded content). */
  listMode: 'recursive' | 'one-level' = 'recursive';

  /** Layer-2 I/O tallies (perf-baseline spec §4). Pure increments — always on, free.
   *  A bench brackets an operation with `snapshotIoCounters` + `diffIoCounters`. */
  readonly io: IoCounters = newIoCounters();

  async read(path: string): Promise<string | null> {
    this.io.reads++;
    return this.files.has(path) ? this.files.get(path)! : null;
  }

  async write(path: string, data: string): Promise<void> {
    this.io.writes++;
    this.io.bytesWritten += data.length;
    this.files.set(path, data);
    if (!this.mtimes.has(path)) this.mtimes.set(path, this.clock);
  }

  async append(path: string, data: string): Promise<void> {
    this.io.appends++;
    this.io.bytesAppended += data.length;
    this.files.set(path, (this.files.get(path) ?? '') + data);
    if (!this.mtimes.has(path)) this.mtimes.set(path, this.clock);
  }

  async exists(path: string): Promise<boolean> {
    this.io.exists++;
    if (this.files.has(path)) return true;
    // A directory "exists" if any file lives under it.
    const prefix = path.endsWith('/') ? path : path + '/';
    for (const p of this.files.keys()) if (p.startsWith(prefix)) return true;
    return false;
  }

  async mkdir(_path: string): Promise<void> {
    /* directories are implicit in the flat map */
  }

  async remove(path: string): Promise<void> {
    this.io.removes++;
    this.files.delete(path);
    this.mtimes.delete(path);
  }

  async list(dir: string): Promise<string[]> {
    this.io.lists++;
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return Array.from(this.files.keys()).filter(p => {
      if (!p.startsWith(prefix)) return false;
      // One-level: exclude anything nested in a subdirectory of `dir`.
      if (this.listMode === 'one-level') return !p.slice(prefix.length).includes('/');
      return true;
    });
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
    this.io.stats++;
    if (!this.files.has(path)) return null;
    return { mtime: this.mtimes.get(path) ?? 0 };
  }

  // ─── Test controls ──────────────────────────────────────────────────────────

  /** Directly seed a file's contents (and optionally its mtime). */
  set(path: string, data: string, mtime = this.clock): void {
    this.files.set(path, data);
    this.mtimes.set(path, mtime);
  }

  /** Set (or clear, with null) the mtime a `stat` will report for a path. */
  setMtime(path: string, mtime: number): void {
    this.mtimes.set(path, mtime);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }
}
