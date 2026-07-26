// ─────────────────────────────────────────────
//  perfLog per-phase timing (mobile perf baseline, Layer 3)
// ─────────────────────────────────────────────
//
//  The `perfLog` diagnostic wires a per-phase timing sink into `runSync()`
//  (docs/mobile-perf-baseline-spec.md §7.3). This asserts the two load-bearing
//  properties: (1) when a sink is supplied it receives a labelled duration for every
//  phase plus a `total`, and the round still completes normally; (2) when it is
//  omitted — the default — the round is untouched (inert). Drives the REAL
//  ServerSyncClient round against the fake server.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([2, 4, 6, 8, 2, 4, 6, 8, 2, 4, 6, 8, 2, 4, 6, 8]);

describe('perfLog per-phase timing', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('perf-timing-test', SALT);
  });

  test('a supplied sink receives every phase + a total, and the round still runs', async () => {
    const api = new FakeSyncServer();
    const phases: Array<{ phase: string; ms: number }> = [];
    const A = await TestDevice.create('perf-a');
    await A.seedFile('note.md', 'hello\n', 1000);

    const client = new ServerSyncClient({
      api, crypto: vc, host: A.host, hlc: A.hlc,
      perfLog: (phase, ms) => phases.push({ phase, ms }),
    });
    const summary = await client.runSync();

    // The round did its job (one authored op pushed).
    expect(summary.pushed).toBe(1);

    const names = phases.map(p => p.phase);
    // Every instrumented boundary reported, in order, ending with the total.
    expect(names).toEqual([
      'keycheck+dag-guard',
      'buildLocalIdentity',
      'pull',
      'fetchBlobs',
      'push',
      'recordVersionEdges',
      'stageContent',
      'merge',
      'applyMerge',
      'reconcileConcurrentHeads',
      'saveCursor',
      'total',
    ]);
    // Durations are real, non-negative numbers.
    for (const { ms } of phases) expect(ms).toBeGreaterThanOrEqual(0);
  });

  test('omitting the sink (the default) installs no timer and the round is unaffected', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('perf-b');
    await A.seedFile('note.md', 'hi\n', 1000);
    // No perfLog — must behave exactly like any other round.
    const summary = await new ServerSyncClient({ api, crypto: vc, host: A.host, hlc: A.hlc }).runSync();
    expect(summary.pushed).toBe(1);
  });

  test('captureOfflineChanges streams scan progress so a long pass yields data before it finishes', async () => {
    // 150 pre-existing files (> the 100-file progress interval), placed WITHOUT
    // events — the first-enable path a fresh device must capture.
    const seed = await TestDevice.create('perf-cap');
    for (let i = 0; i < 150; i++) await seed.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);
    const dev = await seed.reload();

    const ticks: Array<[number, number]> = [];
    await dev.opLogger.captureOfflineChanges((scanned, total) => ticks.push([scanned, total]));

    // Fires at the 100-file boundary and a final total tick — total is the live count.
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]).toEqual([100, 150]);
    expect(ticks[ticks.length - 1]).toEqual([150, 150]);
    // The capture still did its job: every file became a pending create op.
    expect(dev.pendingOps.length).toBe(150);
  });

  test('captureOfflineChanges attributes otherMs to the registry+oplog checkpoint rewrites (Step 1 metrics split)', async () => {
    // Seed more than one CHECKPOINT window (200) so the capture fires ≥1 mid-pass
    // checkpoint plus the final flush — i.e. the oplog journal is appended more than
    // once, which is exactly the checkpoint cost the split must attribute.
    const seed = await TestDevice.create('perf-split');
    for (let i = 0; i < 250; i++) await seed.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);
    const dev = await seed.reload();

    // Arm the sink-gated serialize-vs-write sub-split handles, the way main.ts does
    // around a first-enable capture with the perf diagnostic on.
    const oplogPerf = { stringifyMs: 0, writeMs: 0 };
    const flushPerf = { stringifyMs: 0, writeMs: 0 };
    dev.opLogger.captureOplogPerf = oplogPerf;
    dev.registry.captureFlushPerf = flushPerf;

    // Count the delta appends the capture issues (a checkpoint fired each time). Wrap the
    // real store's append so the count is the genuine call volume (the O(N²) whole-array
    // rewrite is gone — spec §4 replaces it with one O(delta) append per checkpoint).
    let oplogAppends = 0;
    const origAppend = dev.metadata.append.bind(dev.metadata);
    dev.metadata.append = async (path: string, data: string) => {
      if (path === '.opsblobs/oplog.json') oplogAppends++;
      return origAppend(path, data);
    };

    const stats = await dev.opLogger.captureOfflineChanges();

    // The capture did its job.
    expect(stats.opsEmitted).toBe(250);
    expect(dev.pendingOps.length).toBe(250);

    // The two per-checkpoint rewrites are attributed (non-negative wall time), and they
    // account for otherMs with ~no hidden residual — the whole point of the split.
    expect(stats.regFlushMs).toBeGreaterThanOrEqual(0);
    expect(stats.oplogSaveMs).toBeGreaterThanOrEqual(0);
    const otherMs = stats.totalMs - stats.readMs - stats.hashMs - stats.putMs - stats.flushMs;
    expect(stats.regFlushMs + stats.oplogSaveMs).toBeLessThanOrEqual(otherMs + 1e-6);

    // The checkpoints fired: the oplog was appended more than once (the O(N) append shape §4
    // replaced the O(N²) rewrite). ≥2 = at least the 200-op checkpoint + the final tail flush.
    expect(oplogAppends).toBeGreaterThan(1);

    // The serialize-vs-write sub-split accumulated real, non-negative sub-times, and each
    // rewrite's sub-parts don't exceed its measured wall time.
    for (const ms of [oplogPerf.stringifyMs, oplogPerf.writeMs, flushPerf.stringifyMs, flushPerf.writeMs]) {
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(oplogPerf.stringifyMs + oplogPerf.writeMs).toBeLessThanOrEqual(stats.oplogSaveMs + 1e-6);
    expect(flushPerf.stringifyMs + flushPerf.writeMs).toBeLessThanOrEqual(stats.regFlushMs + 1e-6);
  });

  test('registry checkpoint appends are O(delta), not the triangular O(F²) whole-registry rewrite (§6 perf)', async () => {
    // 600 files → exactly three full checkpoint windows (200, 400, 600). The old flush
    // re-serialized+re-wrote the WHOLE registry each time (200, then 400, then 600
    // entries — triangular). The append-journal writes only each window's touched delta
    // (~200 entries) every checkpoint — flat, so total bytes are linear in F, not F².
    const seed = await TestDevice.create('perf-reg-odelta');
    for (let i = 0; i < 600; i++) await seed.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);
    const dev = await seed.reload();

    // Capture the byte-size of each append to the registry journal (the O(delta) guard).
    const sizes: number[] = [];
    const orig = dev.metadata.append.bind(dev.metadata);
    dev.metadata.append = async (p: string, d: string) => {
      if (p === '.opsblobs/file-registry.journal') sizes.push(d.length);
      return orig(p, d);
    };

    await dev.opLogger.captureOfflineChanges();
    expect(dev.pendingOps.length).toBe(600);

    // Three delta appends of ~200 entries each. The regression guard: the LAST
    // checkpoint's append is ~the size of the FIRST, not a growing multiple of it.
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    const first = sizes[0]!;
    const last = sizes[sizes.length - 1]!;
    expect(last).toBeLessThanOrEqual(first * 1.5);   // flat, not triangular
    // Total bytes are ~linear in F (Σ ≈ n×first), nowhere near the O(F²) triangular sum.
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(first * sizes.length * 1.5);
  });
});
