// ─────────────────────────────────────────────
//  Tests — append micro-benchmark harness (correctness, not timing)
// ─────────────────────────────────────────────
//
//  The bench's *numbers* are only meaningful on the device (the in-memory fake has
//  no flash latency). These tests pin the harness's CORRECTNESS: it issues the right
//  I/O shape, computes the summary fields, and — critically — leaves NO scratch files
//  behind (a leak would pollute `.opsblobs` on a real vault).

import { describe, test, expect } from 'vitest';
import { runAppendBench, formatAppendBench } from '../src/core/append-bench';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const params = { iterations: 8, payloadChars: 16, chunks: 3, chunkChars: 32 };

describe('append-bench harness', () => {
  test('issues iterations appends + iterations writeDirect + chunks appends, and cleans up', async () => {
    const meta = new FakeMetadataStore();
    const before = { ...meta.io };

    const r = await runAppendBench(meta, params);

    // Probe A (8 appends to one growing file) + probe C (3 appends to 3 fresh files).
    expect(meta.io.appends - before.appends).toBe(params.iterations + params.chunks);
    // Probe B — one writeDirect per iteration.
    expect(meta.io.writesDirect - before.writesDirect).toBe(params.iterations);

    // Summary fields are populated and self-consistent.
    expect(r.growth.finalFileChars).toBe(params.iterations * params.payloadChars);
    expect(r.baseline.perWriteAvgMs).toBeCloseTo(r.baseline.totalMs / params.iterations, 6);
    expect(r.packed.perChunkAvgMs).toBeCloseTo(r.packed.totalMs / params.chunks, 6);

    // No scratch files survive — every bench path is removed in the `finally`.
    const leaked = await meta.list('.opsblobs/bench');
    expect(leaked).toEqual([]);
  });

  test('formatAppendBench emits a verdict line first', async () => {
    const meta = new FakeMetadataStore();
    const r = await runAppendBench(meta, params);
    const lines = formatAppendBench(r);
    expect(lines[0]).toMatch(/^append-bench VERDICT:/);
    // The fake is constant-time, so the growth ratio reads as O(delta).
    expect(lines[0]).toMatch(/O\(delta\)|COST GROWS/);
  });
});
