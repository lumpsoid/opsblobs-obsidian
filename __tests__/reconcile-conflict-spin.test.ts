// ─────────────────────────────────────────────
//  Regression: reconcileConcurrentHeads must not spin on a non-collapsing fold
// ─────────────────────────────────────────────
//
//  A two-headed TEXT conflict cannot be folded away — the pairwise merge of the two
//  heads re-conflicts, leaving both heads open. `reconcileConcurrentHeads` used to set
//  `folded = true` whenever it *attempted* a foldable leaf, so it re-picked that same
//  un-collapsing leaf every iteration and spun until `maxFolds` (≈ the number of ops
//  pulled this round), re-running the full `buildLocalState` (vault re-read + re-hash +
//  base staging) each time. A conflict pulled alongside a long history therefore made
//  the round O(pulled) instead of O(extra leaves) — the B2 deep-history blow-up
//  (docs/mobile-perf-baseline-spec.md): at K edits it re-ran buildLocalState ~K times.
//
//  Fix: remember attempted (fileId, leafId) pairs so a non-collapsing fold is not
//  retried. This drives the REAL stack over fakes via TestDevice and asserts BOTH the
//  data-safety outcome (the conflict is still surfaced, neither edit lost) AND that the
//  round's buildLocalState count is bounded, not O(pulled).

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { hasConflictMarkers } from '../src/merge/diff3';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

describe('reconcileConcurrentHeads — a non-collapsing conflict fold must not spin', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const onDisk = async (d: TestDevice, path: string): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('a two-headed text conflict pulled alongside a deep history stays O(extra leaves)', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'note.md';
    const K = 40; // deep history ⇒ maxFolds ≈ K; the buggy loop spun ~K times

    // ── A creates the file and syncs; B receives it exactly. ────────────────────
    await A.seedFile(path, 'base\n2\n3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    // ── A edits line 1 K times (a deep lineage) and pushes the whole chain. ─────
    let wall = 2000;
    for (let k = 0; k < K; k++) {
      await A.editFile(path, `a-${k}\n2\n3\n`, wall++);
    }
    await client(A).runSync();

    // ── B edits line 1 ONCE, concurrently off the create version → a genuine
    //    text conflict with A's head. B then syncs, pulling A's whole K-op chain. ─
    await B.editFile(path, 'bbb\n2\n3\n', 1500);

    // Count local snapshot builds during B's reconciling round. Post-A2 each build is
    // a cheap `buildLocalIdentity` (no O(vault) staging); the bound is what matters.
    let buildCount = 0;
    const origBuild = B.host.buildLocalIdentity.bind(B.host);
    B.host.buildLocalIdentity = async (dag) => { buildCount++; return origBuild(dag); };

    await client(B).runSync();

    // ── The conflict must still be surfaced with neither edit lost (data safety). ─
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);
    const marked = await onDisk(B, path);
    expect(hasConflictMarkers(marked)).toBe(true);
    expect(marked).toContain('bbb');      // B's edit preserved…
    expect(marked).toContain(`a-${K - 1}`); // …alongside A's head

    // ── And the round is bounded: one buildLocalState for the main merge plus a
    //    couple of reconcile iterations — NOT one per pulled op. With the bug this
    //    was ≈ K + 1 (~41); the fix keeps it in the single digits regardless of K. ─
    expect(buildCount).toBeLessThanOrEqual(6);
  });

  test('a converged pull (no concurrent divergence) skips the reconcile buildLocalState', async () => {
    // The common case: B pulls a peer edit that fast-forwards, with no second open head.
    // reconcileConcurrentHeads has nothing to fold, so its DAG pre-check must short-circuit
    // BEFORE the whole-vault buildLocalState (~69s on a large mobile vault in the perf
    // logs). Only the main merge's single build should run this round — not a second one.
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a2');
    const B = await TestDevice.create('dev-b2');
    const path = 'note.md';

    await A.seedFile(path, 'base\n', 1000);
    await client(A).runSync();
    await client(B).runSync();       // B converges on A's create

    await A.editFile(path, 'edited\n', 2000);
    await client(A).runSync();       // A pushes a linear edit (single head)

    let buildCount = 0;
    const origBuild = B.host.buildLocalIdentity.bind(B.host);
    B.host.buildLocalIdentity = async (dag) => { buildCount++; return origBuild(dag); };

    await client(B).runSync();       // B pulls the fast-forward — no divergence to reconcile

    expect(await onDisk(B, path)).toBe('edited\n'); // the edit still applied…
    expect(buildCount).toBe(1);                     // …with NO extra reconcile build
  });
});
