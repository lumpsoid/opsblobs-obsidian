// ─────────────────────────────────────────────
//  FakeVaultFiles — in-memory VaultFiles for tests
// ─────────────────────────────────────────────
//
//  A `Map<string, Uint8Array>` of note bytes covering the full VaultFiles
//  surface (list/read/write/move/trash/exists), so the real device stack runs
//  without Obsidian.

import { VaultFiles, VaultFileRef } from '../../../src/ports/vault-files';
import { IoCounters, newIoCounters } from './io-counters';

export class FakeVaultFiles implements VaultFiles {
  private files = new Map<string, Uint8Array>();
  private listingReady = true;

  /** Layer-2 I/O tallies (perf-baseline spec §4) for the *vault* side — above all
   *  the per-round `read` count `buildLocalState` issues (one per live file, the
   *  suspected O(F) re-read). Pure increments; always on, free. */
  readonly io: IoCounters = newIoCounters();

  /** Test hook: reproduce Obsidian's cold-start window where `getFiles()` is not
   *  yet populated even though the files are on disk (readable). While `false`,
   *  `list()` reports empty but `read`/`exists` still work — the exact shape of
   *  the startup race that produced phantom deletes. */
  setListingReady(ready: boolean): void {
    this.listingReady = ready;
  }

  list(): VaultFileRef[] {
    this.io.lists++;
    if (!this.listingReady) return [];
    return Array.from(this.files.keys()).map(path => ({ path }));
  }

  async read(path: string): Promise<Uint8Array | null> {
    this.io.reads++;
    return this.files.has(path) ? this.files.get(path)! : null;
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    this.io.writes++;
    this.io.bytesWritten += content.length;
    this.files.set(path, content);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    this.io.renames++;
    const content = this.files.get(fromPath);
    if (content === undefined) return;
    this.files.delete(fromPath);
    this.files.set(toPath, content);
  }

  async trash(path: string): Promise<void> {
    this.io.removes++;
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    this.io.exists++;
    return this.files.has(path);
  }
}
