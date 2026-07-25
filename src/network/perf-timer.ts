// ─────────────────────────────────────────────
//  PhaseTimer — per-phase wall-clock attribution (perf baseline, Layer 3)
// ─────────────────────────────────────────────
//
//  A monotonic stopwatch that emits the elapsed time of each named phase to a
//  sink. Used by `runSync()` and startup when the `perfLog` diagnostic setting is
//  on (docs/mobile-perf-baseline-spec.md §4 Layer 3 / §7.3) and by the bench
//  harness (Layer 1) for CPU/wall attribution. Obsidian-free and side-effect-free:
//  when no timer is constructed (the default), the instrumented code path does no
//  work beyond a couple of `?.` short-circuits.

export type PhaseTimingSink = (phase: string, ms: number) => void;

/** `performance.now()` where available (Obsidian's mobile WebView and Node both
 *  have it — a monotonic high-resolution clock unaffected by wall-clock jumps),
 *  falling back to `Date.now()` so the timer can never throw on an exotic host. */
export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class PhaseTimer {
  private last: number;
  private readonly startedAt: number;

  constructor(private readonly sink: PhaseTimingSink) {
    this.startedAt = this.last = nowMs();
  }

  /** Emit the elapsed time since the previous `lap()` (or construction) under
   *  `phase`, and reset the lap origin to now. */
  lap(phase: string): void {
    const t = nowMs();
    this.sink(phase, t - this.last);
    this.last = t;
  }

  /** Emit the *total* elapsed time since construction under `phase` (a summary
   *  line spanning every lap, not a per-phase delta). */
  end(phase: string): void {
    this.sink(phase, nowMs() - this.startedAt);
  }
}

/** ` heapMB=<used>/<limit>` for the perf log when the JS engine exposes heap stats
 *  (`performance.memory` — Chromium, so Android's WebView; absent on iOS/WKWebView and
 *  Node). Empty string when unavailable, so it appends harmlessly. Lets a progress
 *  line show whether a slowdown coincides with the heap approaching its ceiling
 *  (the memory-pressure / GC-thrash signature). */
export function heapNote(): string {
  const m = (performance as unknown as {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!m) return '';
  const mb = (b: number): number => Math.round(b / 1e6);
  return ` heapMB=${mb(m.usedJSHeapSize)}/${mb(m.jsHeapSizeLimit)}`;
}
