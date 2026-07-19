// ─────────────────────────────────────────────
//  MetadataStore port  (pure — must not import 'obsidian')
// ─────────────────────────────────────────────
//
//  The narrow surface the sync stack needs for `.vault-sync/*` persistence —
//  today backed by `app.vault.adapter`. `ObsidianMetadataStore` is the live
//  implementation; a fake `Map`-backed implementation drives the real device
//  stack in tests. `read` returns null on a missing path (replacing the former
//  try/catch), and `stat` exposes an mtime so retention GC is deterministic.

export interface MetadataStore {
  /** File contents as text, or null if the path is absent. */
  read(path: string): Promise<string | null>;
  /** Create-or-overwrite the file with text data. */
  write(path: string, data: string): Promise<void>;
  /** Whether a file or directory exists at the path. */
  exists(path: string): Promise<boolean>;
  /** Create a directory (and any missing parents). */
  mkdir(path: string): Promise<void>;
  /** Remove the file at the path. */
  remove(path: string): Promise<void>;
  /** File paths directly under `dir`. */
  list(dir: string): Promise<string[]>;
  /** Modification time for retention GC, or null if it can't be determined. */
  stat(path: string): Promise<{ mtime: number } | null>;
}
