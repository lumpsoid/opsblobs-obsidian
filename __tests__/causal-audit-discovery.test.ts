// ─────────────────────────────────────────────
//  Causal-decision audit — discovery tests (sync v2)
// ─────────────────────────────────────────────
//
//  Asserts the CORRECT behavior for an OPEN finding from the causal-decision audit
//  (docs/causal-decision-audit.md). `test.skip` because it is not yet fixed — un-skip
//  when the fix lands. Same class as the fixed "identical content ≠ causal convergence"
//  bug (concurrent-identical-edit-convergence.test.ts, guide §7): a causal decision made
//  from a proxy (here an HLC-max projection) that leaves a DAG head stranded and silently
//  drops an edit.
//
//  Finding A (delete-convergence) is NOT here: it was re-diagnosed as a benign stranding
//  plus a by-design delete/create conflict, and its one real (minor) bug is fixed and
//  pinned in `recreate-after-delete.test.ts`. See the audit doc.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([5, 5, 5, 5, 1, 1, 1, 1, 5, 5, 5, 5, 1, 1, 1, 1]);
const onDisk = async (d: TestDevice, p = 'my.md') => {
  const b = await d.files.read(p); return b ? new TextDecoder().decode(b) : '<deleted>';
};

describe('causal-decision audit — open findings (correct behavior asserted)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => { vc = new VaultCrypto(); await vc.deriveFromPassphrase('pp', SALT); });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  // ── Finding B: server-sync.ts reconstructRemoteState HLC-max collapse (line ~437) ─
  // ROOT CAUSE: the remote projection keeps only the HLC-max op PER fileId. When a
  // device pulls TWO concurrent remote heads for one file (3 devices: B and C both edit
  // and push without merging), only the higher-HLC head drove the merge; the other was
  // recorded as a DAG leaf but never reconciled, and the cursor advanced past it. The
  // losing edit was invisible on the puller until one of the original editors happened
  // to re-sync and merge — a silent, latent divergence.
  //
  // FIXED: the round now runs a multi-head reconciliation sweep after the main merge
  // (`ServerSyncClient.reconcileConcurrentHeads`). It enumerates the file's open DAG
  // leaves, and folds every extra concurrent leaf into the local head via the ordinary
  // pairwise `mergeVaultStates` — minting a `write_merge` node on a clean fold — so the
  // puller converges itself. See docs/causal-decision-audit.md Finding B.
  test('three devices: two concurrent edits to one file both converge on the puller', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const C = await TestDevice.create('dev-c');

    await A.seedFile('my.md', 'base\nx\n', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();
    await client(api, C).runSync();

    // B and C edit DIFFERENT lines (a clean 3-way) concurrently and push.
    await B.editFile('my.md', 'B-edit\nx\n', 2000);
    await client(api, B).runSync();
    await C.editFile('my.md', 'base\nC-edit\n', 3000);
    await client(api, C).runSync();

    // A pulls both. It must converge to a state that reflects BOTH edits — not silently
    // adopt only the HLC-max one and strand the other.
    await client(api, A).runSync();
    await client(api, A).runSync(); // allow a reconciling second round if needed

    expect(await onDisk(A)).toBe('B-edit\nC-edit\n');
  });

  // The permanent-divergence angle the old code left open: once A has pulled BOTH
  // concurrent heads, it must converge on its OWN — without B or C ever syncing again
  // (the earlier gap: A stayed at the partial "base\nC-edit" indefinitely if the peer
  // that computed the merge went offline before pushing it). Proves the sweep reconciles
  // locally rather than depending on a specific peer staying online.
  test('puller converges to the merged content on its own, no further B/C sync', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const C = await TestDevice.create('dev-c');

    const fileId = await A.seedFile('my.md', 'base\nx\n', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();
    await client(api, C).runSync();

    // Two concurrent, non-overlapping edits pushed WITHOUT either peer merging.
    await B.editFile('my.md', 'B-edit\nx\n', 2000);
    await client(api, B).runSync();
    await C.editFile('my.md', 'base\nC-edit\n', 3000);
    await client(api, C).runSync();

    // A pulls both heads in one round. B and C are now offline forever.
    await client(api, A).runSync();

    // A reconciled BOTH edits by itself in this single round — the sweep folded the
    // stranded head (B1) into the HLC-max head (C1) it adopted first.
    expect(await onDisk(A)).toBe('B-edit\nC-edit\n');
    // It did so by minting a real two-parent merge node, not by silently picking a side.
    expect(A.applied.some(a => a.type === 'write_merge')).toBe(true);

    // The file is now a SINGLE converged head in A's DAG (no stranded leaf left).
    const dag = await A.versionDagStore.load();
    expect(dag.leaves(fileId).length).toBe(1);
    const head = A.entryByPath('my.md')!.headVersionId!;
    expect(head.startsWith('m-')).toBe(true);          // the content-addressed merge node
    expect(dag.leaves(fileId)[0]).toBe(head);

    // And it survives a restart (the merge node is durable), still with no re-sync.
    const A2 = await A.reload();
    expect(await onDisk(A2)).toBe('B-edit\nC-edit\n');

    // The merge node replicates: when B finally comes back it fast-forwards onto A's
    // node rather than re-conflicting (it descends from both original heads).
    await client(api, A2).runSync();   // A pushes its merge node
    await client(api, B).runSync();    // B pulls it
    expect(await onDisk(B)).toBe('B-edit\nC-edit\n');
    expect(B.applied.some(a => a.type === 'conflict')).toBe(false);
  });
});
