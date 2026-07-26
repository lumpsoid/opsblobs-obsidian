// ─────────────────────────────────────────────
//  Sync cancellation — cooperative, checkpoint-gated
// ─────────────────────────────────────────────
//
//  A user-triggered "Cancel sync" must never risk the data-safety invariants the
//  round is built on (sync-engineering-guide.md §4-5): it is honored only at
//  checkpoints BEFORE the round has started mutating the local vault (before
//  `recordVersionEdges`/`mergeVaultStates`/`applyMerge` — server-sync.ts step 4).
//  Everything checked before that point is either read-only (pull, blob download)
//  or already-idempotent/durable network state (pushed ops, uploaded blobs) — so
//  cancelling there is exactly as safe as the round never having started: the next
//  sync simply redoes some bookkeeping, never loses or duplicates anything. Once
//  step 4 begins, `runSync` stops checking and runs the round to completion —
//  interrupting a vault write mid-apply is the one thing this deliberately never
//  does, so "cancel" can never leave a half-applied merge on disk.
//
//  Obsidian-free so it can be threaded through `ServerSyncClient` and unit-tested
//  like the rest of the transport (see sync-errors.ts for the sibling pattern).

/** Thrown by {@link SyncCancelToken.throwIfCancelled} when a cancel was requested.
 *  The coordinator catches this distinctly from a real failure (sync-coordinator.ts):
 *  no error toast, no persisted `lastError` — just a quiet "cancelled" outcome. */
export class SyncCancelledError extends Error {
  constructor() {
    super('Sync cancelled');
    this.name = 'SyncCancelledError';
  }
}

/** One round's cancellation flag. A fresh token is created per round (mirroring
 *  the plugin's per-round `ServerSyncClient`), so a stale click from a previous,
 *  already-finished round can never cancel a later one. */
export class SyncCancelToken {
  private cancelled = false;

  /** Request cancellation. Idempotent — a second call is a no-op. */
  request(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Throw {@link SyncCancelledError} if a cancel was requested. Call only from a
   *  checkpoint where throwing is safe (see the module doc) — never from inside
   *  the merge/apply phase. */
  throwIfCancelled(): void {
    if (this.cancelled) throw new SyncCancelledError();
  }
}
