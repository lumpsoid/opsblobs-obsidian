// ─────────────────────────────────────────────
//  nowMs — a monotonic millisecond clock for perf instrumentation
// ─────────────────────────────────────────────
//
//  `performance.now()` where available (Obsidian's mobile WebView and Node both
//  expose it — a monotonic high-resolution clock unaffected by wall-clock jumps),
//  falling back to `Date.now()` so it can never throw on an exotic host. Single
//  source shared by the obsidian-free core (operation-logger, content-store) and the
//  adapters, so the several perf accumulators all read the same clock. `network/
//  perf-timer` keeps its own private copy to stay self-contained for the PhaseTimer.

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
