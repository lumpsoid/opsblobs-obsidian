// ─────────────────────────────────────────────
//  Append micro-benchmark  (A3 pack-writes — the load-bearing measurement)
// ─────────────────────────────────────────────
//
//  The pack-writes optimization (docs/pack-writes-spec.md) rests on ONE unverified
//  assumption (§6.1 / §8): that `MetadataStore.append` is **O(delta) / one native
//  call** on the Android/Capacitor bridge — not a read-whole-file + concat +
//  write-whole-file underneath. If append secretly rewrites the whole file, a single
//  growing pack/index regresses to O(N²) exactly like the registry did, and the plan
//  changes (per-chunk packs + a single index write instead of repeated appends).
//
//  This can only be answered on the device — the TS adapter just delegates to
//  `app.vault.adapter.append`, whose cost lives in the native layer. So this module
//  runs three tiny probes through the real `MetadataStore` port and reports the
//  numbers `main.ts` writes to `.opsblobs/perf-log.txt`:
//
//    A. GROWTH   — append a fixed chunk N times to ONE file. The go/no-go signal:
//                  if the per-append time of the LAST quartile ≈ the FIRST quartile,
//                  append is O(delta) → proceed as specced. If it climbs with file
//                  size, append is O(whole-file) → reconsider the index strategy.
//    B. BASELINE — `writeDirect` the same chunk to N separate files. The status-quo
//                  loose-blob cost (one native write per blob), for the head-to-head.
//    C. PACKED   — append one big (≈200-blob) chunk to each of CHUNKS fresh files.
//                  Models the chosen per-chunk-pack write path; its total is the
//                  write phase the projection (§6, ~0.5 s) must land near.
//
//  Obsidian-free: it takes the `MetadataStore` port, so it runs identically over the
//  in-memory fake in a unit test (correctness of the harness itself) and over the
//  real device adapter (the actual latency numbers). No timing is asserted in tests.

import { MetadataStore } from '../ports/metadata-store';
import { nowMs } from './perf-clock';

/** Scratch directory the probe writes into and wipes afterwards. Under `.opsblobs`
 *  so it is excluded from sync and disposable like the rest of the store. */
const BENCH_DIR = '.opsblobs/bench';

export interface AppendBenchParams {
  /** Appends in probe A / writes in probe B. The spec's "append 200× and time it". */
  iterations: number;
  /** Char length of the per-iteration payload in A and B (a base64-ish blob body). */
  payloadChars: number;
  /** Per-chunk pack count in probe C (≈ ceil(F/200) at F≈8389 → ~42). */
  chunks: number;
  /** Char length of one packed chunk in C (≈ 200 blobs × payloadChars). */
  chunkChars: number;
}

export const DEFAULT_APPEND_BENCH: AppendBenchParams = {
  iterations: 200,
  payloadChars: 4096,
  chunks: 42,
  chunkChars: 200 * 4096,
};

export interface AppendBenchResult {
  params: AppendBenchParams;
  /** Probe A — append to one growing file. */
  growth: {
    totalMs: number;
    /** Mean per-append ms over the first quarter of iterations (small file). */
    firstQuartileAvgMs: number;
    /** Mean per-append ms over the last quarter (large file). The tell: a ratio
     *  near 1 means O(delta); a large ratio means O(whole-file). */
    lastQuartileAvgMs: number;
    perAppendAvgMs: number;
    /** `lastQuartileAvgMs / firstQuartileAvgMs` — the O(delta)-vs-O(n) verdict.
     *  ~1 ⇒ constant-time append (proceed). ≫1 ⇒ cost grows with file size. */
    growthRatio: number;
    finalFileChars: number;
  };
  /** Probe B — writeDirect to N separate files (status-quo loose blob path). */
  baseline: {
    totalMs: number;
    perWriteAvgMs: number;
  };
  /** Probe C — per-chunk pack append (the chosen write path). */
  packed: {
    totalMs: number;
    perChunkAvgMs: number;
  };
}

/** Repeat a single character into a payload of `n` chars without any per-call RNG
 *  (which the harness must not use — `Math.random` is unavailable in some contexts). */
function payload(n: number, fill: string): string {
  return fill.repeat(n);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Run the three probes and return the timing summary. Cleans up all scratch files in
 * a `finally` so a thrown probe can't leave the bench dir behind. Deterministic and
 * side-effect-free outside `BENCH_DIR`.
 */
export async function runAppendBench(
  metadata: MetadataStore,
  params: AppendBenchParams = DEFAULT_APPEND_BENCH,
): Promise<AppendBenchResult> {
  const { iterations, payloadChars, chunks, chunkChars } = params;
  const chunkPaths: string[] = [];
  const growthPath = `${BENCH_DIR}/growth.append`;

  try {
    if (!(await metadata.exists(BENCH_DIR))) await metadata.mkdir(BENCH_DIR);

    // ── Probe A — append to ONE growing file ────────────────────────────────
    // Start clean (a prior run's file would skew the growth curve).
    await metadata.remove(growthPath).catch(() => {});
    const perAppend: number[] = [];
    const chunk = payload(payloadChars, 'a');
    const aStart = nowMs();
    for (let i = 0; i < iterations; i++) {
      const t = nowMs();
      await metadata.append(growthPath, chunk);
      perAppend.push(nowMs() - t);
    }
    const aTotal = nowMs() - aStart;
    const q = Math.max(1, Math.floor(iterations / 4));
    const firstQ = mean(perAppend.slice(0, q));
    const lastQ = mean(perAppend.slice(iterations - q));

    // ── Probe B — writeDirect to N separate files (status-quo baseline) ──────
    const bStart = nowMs();
    for (let i = 0; i < iterations; i++) {
      const p = `${BENCH_DIR}/loose-${i}.bin`;
      chunkPaths.push(p);
      await metadata.writeDirect(p, chunk);
    }
    const bTotal = nowMs() - bStart;

    // ── Probe C — one append of a big chunk to each of `chunks` fresh files ──
    const bigChunk = payload(chunkChars, 'b');
    const cStart = nowMs();
    for (let i = 0; i < chunks; i++) {
      const p = `${BENCH_DIR}/pack-${i}.pack`;
      chunkPaths.push(p);
      await metadata.append(p, bigChunk);
    }
    const cTotal = nowMs() - cStart;

    return {
      params,
      growth: {
        totalMs: aTotal,
        firstQuartileAvgMs: firstQ,
        lastQuartileAvgMs: lastQ,
        perAppendAvgMs: mean(perAppend),
        growthRatio: firstQ > 0 ? lastQ / firstQ : 0,
        finalFileChars: iterations * payloadChars,
      },
      baseline: { totalMs: bTotal, perWriteAvgMs: bTotal / Math.max(1, iterations) },
      packed: { totalMs: cTotal, perChunkAvgMs: cTotal / Math.max(1, chunks) },
    };
  } finally {
    await metadata.remove(growthPath).catch(() => {});
    for (const p of chunkPaths) await metadata.remove(p).catch(() => {});
  }
}

/** Flatten a result into the `label\tms` lines `main.ts` streams to perf-log.txt,
 *  plus a one-line human verdict. Kept here so the formatting is unit-testable. */
export function formatAppendBench(r: AppendBenchResult): string[] {
  const f = (n: number) => n.toFixed(1);
  const verdict =
    r.growth.growthRatio < 1.5
      ? `append is ~O(delta) (ratio ${f(r.growth.growthRatio)}) — pack-writes projection holds`
      : `append COST GROWS with file size (ratio ${f(r.growth.growthRatio)}) — reconsider index strategy`;
  return [
    `append-bench VERDICT: ${verdict}`,
    `append-bench A growth total (${r.params.iterations}× ${r.params.payloadChars}ch)\t${f(r.growth.totalMs)}`,
    `append-bench A firstQuartileAvg\t${f(r.growth.firstQuartileAvgMs)}`,
    `append-bench A lastQuartileAvg\t${f(r.growth.lastQuartileAvgMs)}`,
    `append-bench A perAppendAvg\t${f(r.growth.perAppendAvgMs)}`,
    `append-bench B writeDirect baseline total (${r.params.iterations}× ${r.params.payloadChars}ch)\t${f(r.baseline.totalMs)}`,
    `append-bench B perWriteAvg\t${f(r.baseline.perWriteAvgMs)}`,
    `append-bench C per-chunk pack total (${r.params.chunks}× ${r.params.chunkChars}ch)\t${f(r.packed.totalMs)}`,
    `append-bench C perChunkAvg\t${f(r.packed.perChunkAvgMs)}`,
  ];
}
