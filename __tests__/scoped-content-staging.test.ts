// ─────────────────────────────────────────────
//  A2 — scoped post-pull content staging (build-local-state-perf-spec §4.3, §6)
// ─────────────────────────────────────────────
//
//  Before A2, `buildLocalState` staged the bytes of EVERY live file into the round's
//  snapshot content map, plus each head's DAG-reachable bases — O(vault) every round,
//  ~92% of a converged round at F≈8390 (docs/build-local-state-perf-spec.md §1). A2
//  splits that into a cheap identity build (before the pull) and `stageContent` scoped,
//  after the pull, to exactly the files the merge reconciles.
//
//  These tests pin the scoping through the REAL device stack (TestDevice over the fakes)
//  by spying on `host.stageContent` and summing the hash-set sizes it is asked to stage:
//    · a converged round stages ZERO hashes (nothing touched, nothing pending);
//    · a round that pulls one edit out of N stages O(1), not O(N).
//  The correctness twin — data still flows, the vault is unchanged/updated — is asserted
//  alongside, so a "stages nothing" that also *did* nothing can't pass.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';
import { affectsLocalVault, VaultState } from '../src/types';

const SALT = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

/** Wrap a device's `host.stageContent` to record how many hashes each call is asked to
 *  stage, and return the running total. Restores nothing (the device is disposable). */
function spyStageContent(d: TestDevice): { total: () => number; calls: number[] } {
  const calls: number[] = [];
  const orig = d.host.stageContent.bind(d.host);
  d.host.stageContent = async (state: VaultState, hashes: Iterable<string>): Promise<void> => {
    const arr = [...hashes];
    calls.push(arr.length);
    return orig(state, arr);
  };
  return { total: () => calls.reduce((a, b) => a + b, 0), calls };
}

describe('A2 scoped content staging', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('scoped-staging-test', SALT);
  });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  // ── The converged round: stage nothing ──────────────────────────────────────
  test('a converged self-sync of N files stages ZERO hashes and writes nothing locally', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-solo');
    const N = 40;
    for (let i = 0; i < N; i++) await A.seedFile(`n${i}.md`, `body ${i}`, 1000 + i);

    // First sync pushes the whole baseline (its pending content IS staged for upload —
    // that O(N) is the push, not the merge). Then the vault is converged.
    await client(api, A).runSync();

    // The SECOND round changes nothing: no pending ops, an empty remote projection
    // (our own re-pulled ops are excluded). The merge still emits one send_remote per
    // file, but the scoped stage must fetch NOT ONE byte.
    const spy = spyStageContent(A);
    const appliedBefore = A.applied.length;
    const summary = await client(api, A).runSync();

    expect(spy.total()).toBe(0);                       // ← the A2 win: zero staging
    expect(summary.pushed).toBe(0);                    // nothing to push
    // The merge produced one action per file, but none touches the local vault.
    const roundActions = A.applied.slice(appliedBefore);
    expect(roundActions.length).toBe(N);
    expect(roundActions.filter(affectsLocalVault).length).toBe(0);
    expect(roundActions.every(a => a.type === 'send_remote' || a.type === 'no_op')).toBe(true);

    // And the files are all still intact at their content.
    for (let i = 0; i < N; i++) expect(await onDisk(A, `n${i}.md`)).toBe(`body ${i}`);
  });

  // ── Touch one file out of N: stage O(1), not O(N) ───────────────────────────
  test('pulling a single edit out of N stages O(1) hashes, independent of vault size', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const N = 40;

    for (let i = 0; i < N; i++) await A.seedFile(`n${i}.md`, `body ${i}\n`, 1000 + i);
    await client(api, A).runSync();       // A pushes N files
    await client(api, B).runSync();       // B pulls + converges on all N

    // A edits exactly ONE of the N files and pushes it.
    await A.editFile('n0.md', 'body 0 EDITED\n', 5000);
    await client(api, A).runSync();

    // B pulls that single edit. The scoped stage must touch only n0 — its local bytes
    // plus its (shallow) DAG-reachable bases — NOT the other 39 files.
    const spy = spyStageContent(B);
    const summary = await client(api, B).runSync();

    expect(summary.pulled).toBeGreaterThanOrEqual(1);
    // O(1): n0's current bytes + a base or two. A hard ceiling far below N proves the
    // stage does not scale with the vault — the whole point of A2.
    expect(spy.total()).toBeLessThanOrEqual(4);
    expect(spy.total()).toBeLessThan(N);

    // And B actually applied the edit (data flowed — a "stages nothing" that also did
    // nothing would fail here).
    expect(await onDisk(B, 'n0.md')).toBe('body 0 EDITED\n');
    // The untouched files are unchanged and were never staged.
    expect(await onDisk(B, 'n39.md')).toBe('body 39\n');
  });

  // ── Constant-independence: the staged total does NOT grow with the vault ─────
  // The ceilings above prove "small"; this proves "constant". Run the identical
  // touch-one-of-N scenario at two vault sizes and assert B stages the SAME number of
  // hashes both times — the tell-tale of O(touched), not O(vault). If staging ever
  // silently reverted to scanning all files, the larger N would stage more and this
  // equality would break.
  test('the staged total for pulling one edit is identical at N=10 and N=80 (constant in vault size)', async () => {
    // Returns how many hashes B's host is asked to stage while pulling a single edit
    // made to one file of a converged N-file vault.
    const stagedForVaultSize = async (N: number): Promise<number> => {
      const api = new FakeSyncServer();
      const A = await TestDevice.create(`ci-a-${N}`);
      const B = await TestDevice.create(`ci-b-${N}`);
      for (let i = 0; i < N; i++) await A.seedFile(`n${i}.md`, `body ${i}\n`, 1000 + i);
      await client(api, A).runSync();
      await client(api, B).runSync();

      await A.editFile('n0.md', 'body 0 EDITED\n', 5000);
      await client(api, A).runSync();

      const spy = spyStageContent(B);
      await client(api, B).runSync();
      // Sanity: the edit really propagated, so a staged-total of e.g. 0 means "scoped",
      // not "did nothing".
      expect(await onDisk(B, 'n0.md')).toBe('body 0 EDITED\n');
      return spy.total();
    };

    const small = await stagedForVaultSize(10);
    const large = await stagedForVaultSize(80);
    expect(large).toBe(small);         // ← constant: 8× the vault, identical staging
    expect(small).toBeLessThan(10);    // …and genuinely O(1), not "equal but large"
  });

  // ── A concurrent divergence still stages its base (F1 not degraded to a lie) ──
  test('a genuine concurrent edit stages the touched file so it three-way merges, not conflicts', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const N = 20;

    for (let i = 0; i < N; i++) await A.seedFile(`n${i}.md`, `L1\nL2\nL3\n`, 1000 + i);
    await client(api, A).runSync();
    await client(api, B).runSync();

    // A and B edit different lines of the SAME file, concurrently.
    await A.editFile('n5.md', 'A1\nL2\nL3\n', 4000);
    await B.editFile('n5.md', 'L1\nL2\nB3\n', 5000);
    await client(api, B).runSync();       // B pushes its head first

    // A pulls B's head. The scoped stage must include n5's local bytes AND its
    // DAG-reachable base, so the three-way merge cleanly reconciles both edits rather
    // than degrading to a conflict for want of a staged base (F1).
    const spy = spyStageContent(A);
    await client(api, A).runSync();

    const merged = await onDisk(A, 'n5.md');
    expect(merged).toContain('A1');
    expect(merged).toContain('B3');
    expect(merged).not.toContain('<<<<<<<');
    expect(A.applied.some(a => a.type === 'write_merge')).toBe(true);
    // Still scoped to n5: A's own pending edit (push-stage) + n5's local bytes + its
    // base + the reconcile pass — a small constant, NOT the other 19 untouched files.
    expect(spy.total()).toBeLessThanOrEqual(10);
    expect(spy.total()).toBeLessThan(N);
  });
});
