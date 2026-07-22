// ─────────────────────────────────────────────
//  withTimeout — bound a hung request
// ─────────────────────────────────────────────
//
//  Obsidian's `requestUrl` has no built-in timeout, so a hung server or a flaky
//  link would leave a sync round waiting indefinitely. This races the request
//  against a timer and rejects with a {@link TimeoutError} when it overruns. Pure
//  and obsidian-free so it's unit-testable; used by the HTTP transport.
//
//  The underlying request is NOT cancelled (requestUrl exposes no abort) — it just
//  becomes detached and its result ignored. That's safe: appends are idempotent by
//  clientOpId and blob PUTs by hash, so a detached write that later lands can't
//  duplicate, and the round fails loud and retries next interval.

import { TimeoutError } from './sync-errors';

/**
 * Resolve/reject with `op`'s outcome, unless `ms` elapses first — then reject with
 * a `TimeoutError` labelled by `label` (e.g. the request description). A non-positive
 * `ms` disables the bound and returns `op` unchanged.
 */
export function withTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return op;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    op.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}
