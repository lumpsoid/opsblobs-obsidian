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
});
