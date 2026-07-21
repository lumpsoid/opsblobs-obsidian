// ─────────────────────────────────────────────
//  FakeVaultFiles — in-memory VaultFiles for tests
// ─────────────────────────────────────────────
//
//  A `Map<string, Uint8Array>` of note bytes covering the full VaultFiles
//  surface (list/read/write/move/trash/exists), so the real device stack runs
//  without Obsidian.

import { VaultFiles, VaultFileRef } from '../../../src/ports/vault-files';

export class FakeVaultFiles implements VaultFiles {
  private files = new Map<string, Uint8Array>();
  private listingReady = true;

  /** Test hook: reproduce Obsidian's cold-start window where `getFiles()` is not
   *  yet populated even though the files are on disk (readable). While `false`,
   *  `list()` reports empty but `read`/`exists` still work — the exact shape of
   *  the startup race that produced phantom deletes. */
  setListingReady(ready: boolean): void {
    this.listingReady = ready;
  }

  list(): VaultFileRef[] {
    if (!this.listingReady) return [];
    return Array.from(this.files.keys()).map(path => ({ path }));
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.has(path) ? this.files.get(path)! : null;
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const content = this.files.get(fromPath);
    if (content === undefined) return;
    this.files.delete(fromPath);
    this.files.set(toPath, content);
  }

  async trash(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
