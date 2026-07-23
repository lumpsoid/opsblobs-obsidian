// ─────────────────────────────────────────────
//  IoCounters — Layer-2 I/O instrumentation for the fakes
// ─────────────────────────────────────────────
//
//  The perf-baseline spec's Layer 2 (docs/mobile-perf-baseline-spec.md §4/§7):
//  the in-memory fakes tally how many times the stack reads/writes/renames/removes
//  and how many bytes it rewrites, so write-amplification and re-hash/re-read counts
//  are visible *device-independently* — no timing, pure counts. These are the most
//  portable signal we have: an in-memory Map can't reproduce flash latency, but it
//  reproduces exactly how many syscalls a round would issue and how many bytes it
//  would rewrite, which is the thing that scales badly on a phone.
//
//  Test/bench-only — never shipped. The counters are plain increments (free), so
//  they're always on; a bench brackets an operation with `snapshot()` + `diff()`.

export interface IoCounters {
  /** `read` calls (a full-file load). */
  reads: number;
  /** `write` calls (a full-file (over)write). In the production ObsidianMetadataStore
   *  each one is an *atomic* write = write-temp + remove + rename ≈ 3 fs syscalls;
   *  see METADATA_WRITE_FS_AMPLIFICATION. */
  writes: number;
  /** `append` calls (the DAG journal's delta-sized writer — the one store that does
   *  NOT rewrite the whole file). */
  appends: number;
  /** `remove` / `trash` calls. */
  removes: number;
  /** `move` / `rename` calls. */
  renames: number;
  /** `list` (directory enumeration) calls. */
  lists: number;
  /** `stat` calls. */
  stats: number;
  /** `exists` calls. */
  exists: number;
  /** Total bytes handed to `write` (full-file rewrite volume — the write-amplification
   *  headline: a per-mutation full-registry rewrite pushes this toward O(F) per mutated
   *  file, O(F²) per batch). */
  bytesWritten: number;
  /** Total bytes handed to `append` (delta-sized journal volume). */
  bytesAppended: number;
}

/** In the production ObsidianMetadataStore, one logical `write(path)` expands to an
 *  atomic write-temp → remove-old → rename dance (obsidian-metadata-store.ts) — so a
 *  bench multiplies a fake's `writes` by this to estimate real fs syscalls. The fake
 *  counts the logical port op; the amplification is a fixed adapter property. */
export const METADATA_WRITE_FS_AMPLIFICATION = 3;

export function newIoCounters(): IoCounters {
  return {
    reads: 0, writes: 0, appends: 0, removes: 0, renames: 0,
    lists: 0, stats: 0, exists: 0, bytesWritten: 0, bytesAppended: 0,
  };
}

/** A frozen copy, so a bench can capture a baseline before an operation. */
export function snapshotIoCounters(c: IoCounters): IoCounters {
  return { ...c };
}

/** The per-field delta `after - before` — the I/O a single operation issued. */
export function diffIoCounters(before: IoCounters, after: IoCounters): IoCounters {
  return {
    reads: after.reads - before.reads,
    writes: after.writes - before.writes,
    appends: after.appends - before.appends,
    removes: after.removes - before.removes,
    renames: after.renames - before.renames,
    lists: after.lists - before.lists,
    stats: after.stats - before.stats,
    exists: after.exists - before.exists,
    bytesWritten: after.bytesWritten - before.bytesWritten,
    bytesAppended: after.bytesAppended - before.bytesAppended,
  };
}
