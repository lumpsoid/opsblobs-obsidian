// ─────────────────────────────────────────────
//  ObsidianMetadataStore — live MetadataStore implementation
// ─────────────────────────────────────────────
//
//  Wraps `app.vault.adapter` (the `.vault-sync/*` persistence surface). The one
//  place `normalizePath` and the adapter APIs live for metadata reads/writes;
//  `read`/`list`/`stat` return null/empty on a missing path so callers never
//  need a try/catch.

import { App, normalizePath } from 'obsidian';
import { MetadataStore } from '../ports/metadata-store';

export class ObsidianMetadataStore implements MetadataStore {
  constructor(private app: App) {}

  async read(path: string): Promise<string | null> {
    const p = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(p))) return null;
    return this.app.vault.adapter.read(p);
  }

  async write(path: string, data: string): Promise<void> {
    await this.app.vault.adapter.write(normalizePath(path), data);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  async mkdir(path: string): Promise<void> {
    await this.app.vault.adapter.mkdir(normalizePath(path));
  }

  async remove(path: string): Promise<void> {
    await this.app.vault.adapter.remove(normalizePath(path));
  }

  async list(dir: string): Promise<string[]> {
    const p = normalizePath(dir);
    if (!(await this.app.vault.adapter.exists(p))) return [];
    const result = await this.app.vault.adapter.list(p);
    return result.files;
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
    const stat = await this.app.vault.adapter.stat(normalizePath(path));
    return stat ? { mtime: stat.mtime } : null;
  }
}
