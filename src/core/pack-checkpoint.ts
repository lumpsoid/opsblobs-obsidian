// ─────────────────────────────────────────────
//  PackCheckpoint — bounded pack-flush cadence for bulk write passes
// ─────────────────────────────────────────────
//
//  Any pass that buffers many blobs through `ContentStore.putBuffered` — the
//  first-enable offline capture (operation-logger) and the bulk sync apply
//  (sync-applicator) — must NOT flush once at the very end. A single flush packs
//  the whole vault into ONE giant pack, which then (a) has to be read in full to
//  extract any one blob later (getFromPack has no ranged read), (b) is built by an
//  O(N²) string concatenation in `flushPack`, and (c) can only be compacted whole.
//  It also pins the whole pass's base64 in RAM until the end.
//
//  This is the exact reason `captureOfflineChanges` flushes every N files instead
//  of once. This module extracts that cadence into ONE place so both the capture
//  and the apply side share it — flush a bounded pack every N items and drop the
//  mem cache — rather than each re-deriving it and one of them forgetting a part.
//
//  The load-bearing invariant it encodes is **blob-before-op** (sync-engineering-
//  guide §5): at every checkpoint the pack is flushed FIRST, then whatever ops /
//  registry entries reference those blobs are persisted — so a crash between the two
//  never leaves a durable op citing an unflushed blob.

/** The minimal slice of `ContentStore` a checkpoint drives. An interface (not the
 *  concrete store) so the checkpoint is trivially testable and callers can wrap
 *  `flushPack` to time it without the module knowing about perf stats. */
export interface PackFlushTarget {
  /** Append the buffered blobs to a fresh bounded pack + index (a no-op on an empty
   *  buffer, so it is always safe to call). */
  flushPack(): Promise<void>;
  /** Drop the in-memory blob cache, so a long pass doesn't accumulate the whole
   *  vault's content in RAM. */
  clearMemCache(): void;
}

/** Default flush cadence (items between checkpoints). Matches the capture path's
 *  long-standing `CAPTURE_CHECKPOINT_EVERY`: modest so a mobile pass never buffers
 *  more than ~N blobs of base64 or writes an unbounded pack. Not load-bearing for
 *  correctness — only for how coarse each pack (and each RAM peak) gets. */
export const PACK_CHECKPOINT_EVERY = 200;

export class PackCheckpoint {
  private since = 0;

  /**
   * @param target  the content store to flush / cache-clear.
   * @param every   items between automatic checkpoints (see {@link PACK_CHECKPOINT_EVERY}).
   * @param persistReferrers  optional extra durability the caller batches on the SAME
   *   cadence, run AFTER the pack flush so every referencing op/registry entry is
   *   written only once its blobs are durable (blob-before-op). The capture path
   *   persists the registry then the oplog here; the bulk apply omits it (it batches
   *   the registry once at end, and clears its ops once). Must preserve its own
   *   internal ordering (registry before oplog).
   */
  constructor(
    private readonly target: PackFlushTarget,
    private readonly every: number = PACK_CHECKPOINT_EVERY,
    private readonly persistReferrers?: () => Promise<void>,
  ) {}

  /**
   * Record one processed item; fire a bounded checkpoint once `every` have accrued.
   * A mid-pass checkpoint always drops the mem cache (`keepWarm: false`) — the whole
   * point is to bound RAM — so call this per item and let it self-throttle.
   */
  async tick(): Promise<void> {
    if (++this.since < this.every) return;
    await this.flush({ keepWarm: false });
  }

  /**
   * Flush the current sub-`every` tail (end of pass, abort, or the run-on-throw
   * `finally` of an apply). Safe to call with an empty buffer (`flushPack` no-ops)
   * and resets the counter, so it composes with `tick`.
   *
   * `keepWarm` leaves the just-written blobs in the mem cache: a pass whose blobs are
   * read again immediately after (capture → the sync round that follows; apply → the
   * head reconcile that follows) keeps its tail warm instead of forcing a disk read +
   * C4 re-verify. A mid-pass `tick` never keeps warm.
   */
  async flush({ keepWarm }: { keepWarm: boolean }): Promise<void> {
    await this.target.flushPack();
    if (this.persistReferrers) await this.persistReferrers();
    if (!keepWarm) this.target.clearMemCache();
    this.since = 0;
  }
}
