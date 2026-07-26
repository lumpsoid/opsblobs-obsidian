// ─────────────────────────────────────────────
//  MetadataStore port  (pure — must not import 'obsidian')
// ─────────────────────────────────────────────
//
//  The narrow surface the sync stack needs for `.opsblobs/*` persistence —
//  today backed by `app.vault.adapter`. `ObsidianMetadataStore` is the live
//  implementation; a fake `Map`-backed implementation drives the real device
//  stack in tests. `read` returns null on a missing path (replacing the former
//  try/catch), and `stat` exposes an mtime so retention GC is deterministic.

export interface MetadataStore {
  /** File contents as text, or null if the path is absent. */
  read(path: string): Promise<string | null>;
  /** Create-or-overwrite the file with text data. Atomic — a reader never sees a
   *  torn/partial file even if the process is killed mid-write. Use for the durable
   *  singletons (oplog, registry, version-DAG, cursor, HLC) where a torn file is
   *  unrecoverable. */
  write(path: string, data: string): Promise<void>;
  /** Create-or-overwrite the file with text data, NON-atomically — a single native
   *  write straight to the target (no temp-file + rename ceremony). A crash mid-write
   *  can leave a torn file, so this is ONLY for **content-addressed, disposable** data
   *  whose integrity is guaranteed another way: the content store hashes a blob's path,
   *  so a torn read is caught by hash-verify-on-read (`ContentStore.get`) and degrades
   *  to a missing base (F1). On the Android/Capacitor bridge the atomic `rename` costs
   *  as much as the byte-write itself (A3 perf split), so skipping it ~halves the
   *  content-store write cost. Defaults to `write` where a store doesn't distinguish. */
  writeDirect(path: string, data: string): Promise<void>;
  /** Append text to the file, creating it if absent. Used by the version-DAG
   *  journal to persist a round's *new* edges in O(delta) rather than rewriting
   *  the whole graph. Need not be atomic — a torn trailing append is tolerated by
   *  the journal reader, which drops an unparseable final line. */
  append(path: string, data: string): Promise<void>;
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
