// ─────────────────────────────────────────────
//  FakeMetadataStore — in-memory MetadataStore for tests
// ─────────────────────────────────────────────
//
//  A `Map<string, string>` of file contents plus a parallel mtime map so tests
//  can drive retention GC deterministically. `stat` reports the recorded mtime
//  (default 0); `setMtime` lets a test age a blob past the retention window.

import { MetadataStore } from '../../../src/ports/metadata-store';

export class FakeMetadataStore implements MetadataStore {
  private files = new Map<string, string>();
  private mtimes = new Map<string, number>();
  /** Default mtime for files written without an explicit one. */
  clock = 0;

  async read(path: string): Promise<string | null> {
    return this.files.has(path) ? this.files.get(path)! : null;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    if (!this.mtimes.has(path)) this.mtimes.set(path, this.clock);
  }

  async exists(path: string): Promise<boolean> {
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
    this.files.delete(path);
    this.mtimes.delete(path);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return Array.from(this.files.keys()).filter(p => p.startsWith(prefix));
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
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
