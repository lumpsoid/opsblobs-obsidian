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
  // path → { bytes, mtime }. mtime is a monotonic counter bumped on every write,
  // modelling a real fs's "modified time" (Obsidian's `TFile.stat.mtime`): an edit
  // advances it, an untouched file keeps it, a move carries it over — exactly what
  // the O1 capture stat-gate keys on. `size` is derived from the bytes' length.
  private files = new Map<string, { content: Uint8Array; mtime: number }>();
  private clock = 0;
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
    return Array.from(this.files.entries()).map(([path, f]) => ({
      path,
      mtime: f.mtime,
      size: f.content.length,
    }));
  }

  /** Test hook: overwrite a file's bytes WITHOUT advancing its mtime — models the
   *  (astronomically rare) case a real fs leaves mtime unchanged across a same-instant
   *  write, so a test can prove the O1 capture stat-gate still catches the change via
   *  `size`. A no-op'd mtime on an *unknown* path just gets a fresh tick. */
  async writeKeepingMtime(path: string, content: Uint8Array): Promise<void> {
    const prev = this.files.get(path);
    this.io.writes++;
    this.io.bytesWritten += content.length;
    this.files.set(path, { content, mtime: prev?.mtime ?? ++this.clock });
  }

  async read(path: string): Promise<Uint8Array | null> {
    this.io.reads++;
    return this.files.get(path)?.content ?? null;
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    this.io.writes++;
    this.throwIfArmed(path);
    this.io.bytesWritten += content.length;
    // Every write advances the file's mtime (a fresh monotonic tick), so the
    // capture stat-gate re-hashes it next pass; an unwritten file keeps its mtime.
    this.files.set(path, { content, mtime: ++this.clock });
  }

  /** Test hook: make the next `move`/`write`/`trash` of `path` throw. Models an
   *  adapter-level failure the engine cannot anticipate — Obsidian rejecting a
   *  rename into a folder it won't create, a permissions error, a locked file. The
   *  engine must isolate it (defer that one file, hold the cursor) rather than let
   *  it abort the whole apply; see `apply-action-failure-isolation.test.ts`. */
  failNextOn(path: string, message: string): void {
    this.failures.set(path, message);
  }
  private failures = new Map<string, string>();
  private throwIfArmed(path: string): void {
    const message = this.failures.get(path);
    if (message === undefined) return;
    this.failures.delete(path);
    throw new Error(message);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    this.io.renames++;
    this.throwIfArmed(toPath);
    const f = this.files.get(fromPath);
    if (f === undefined) return;
    // A move preserves content *and* mtime (a rename isn't a content change).
    this.files.delete(fromPath);
    this.files.set(toPath, f);
  }

  async trash(path: string): Promise<void> {
    this.io.removes++;
    this.throwIfArmed(path);
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    this.io.exists++;
    return this.files.has(path);
  }
}
