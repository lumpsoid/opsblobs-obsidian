// ─────────────────────────────────────────────
//  Regression (F5): an edit made DURING the sync window must not be dropped
// ─────────────────────────────────────────────
//
//  Distinct from concurrent-conflict-dataloss.test.ts. There the in-window edit
//  lands *before* runSync, so `buildLocalState` re-hashes the disk bytes and the
//  merge sees the fresh content. Here the edit lands *after* buildLocalState has
//  already snapshotted the pre-edit bytes but *before* `applyMerge` runs — the
//  TOCTOU window between the snapshot and the destructive apply.
//
//  Sequence:
//    · A creates `note.md` = "L1/L2/L3" and syncs; B syncs, receives it.
//    · B edits line 3 → "L1/L2/B3" (a normal logged edit) and syncs → op on server.
//    · A runs a sync. buildLocalState snapshots the UNCHANGED base. Then, inside
//      the pull→apply window (modelled by injecting into applyMerge, which runs
//      after buildLocalState), A's user edits line 1 → "A1/L2/L3". That edit is
//      on disk but is NOT a durable op when applyMerge runs.
//    · The merge computed on the stale snapshot is a clean `write_local` of B's
//      content (A's snapshot looked unchanged). Pre-fix, applyMerge overwrites
//      the file with "L1/L2/B3" while listeners are paused → A's in-window edit
//      "A1/L2/L3" is silently, permanently lost.
//
//  With the F5 fix: the applicator detects the file drifted since the snapshot,
//  declines the destructive write (keeps A's bytes), holds the cursor so B's op
//  re-pulls, and re-captures A's edit as a durable pending op. Next round it is a
//  real three-way merge (base "L1/L2/L3", local "A1/L2/L3", remote "L1/L2/B3") →
//  clean "A1/L2/B3": neither edit lost.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 6]);

/** Write disk bytes with no watcher event: on disk, but no registry-hash update
 *  and no pending op — exactly an edit still inside the debounce window. */
async function editWithoutLogging(device: TestDevice, path: string, newText: string): Promise<void> {
  await device.files.write(path, new TextEncoder().encode(newText));
}

const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

describe('edit made during the sync window (F5)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('A must not silently lose an edit that lands after buildLocalState but before apply', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'note.md';

    // ── A creates the file and syncs; B syncs and receives it exactly. ────────
    await A.seedFile(path, 'L1\nL2\nL3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('L1\nL2\nL3\n');

    // ── B edits line 3 and syncs (a normal, logged edit). Its op is on the
    //    server; A will pull it next round. ────────────────────────────────────
    await B.editFile(path, 'L1\nL2\nB3\n', 2000);
    await client(B).runSync();

    // ── A syncs. buildLocalState snapshots the still-unchanged base; then, in
    //    the window before applyMerge, A's user edits line 1. The edit hits disk
    //    but isn't a durable op when applyMerge runs. ──────────────────────────
    A.setWall(3000);
    const realApply = A.host.applyMerge.bind(A.host);
    let injected = false;
    A.host.applyMerge = async (actions, local, remote) => {
      if (!injected) {
        injected = true;
        await editWithoutLogging(A, path, 'A1\nL2\nL3\n'); // in-window local edit
      }
      return realApply(actions, local, remote);
    };

    await client(A).runSync();

    // ── A's in-window edit must survive the round — NOT be overwritten by B's
    //    content — and must be captured as a pending op for the next round. ────
    expect(await onDisk(A, path)).toBe('A1\nL2\nL3\n');       // A's edit preserved on disk
    expect(await onDisk(A, path)).not.toBe('L1\nL2\nB3\n');   // NOT silently clobbered by remote
    expect(A.pendingOps.some(op => op.path === path)).toBe(true); // re-captured as a durable op

    // ── Restore the plain applyMerge and sync again: B's op re-pulls and now
    //    three-way merges against A's captured edit. Both edits converge. ──────
    A.host.applyMerge = realApply;
    await client(A).runSync();

    const finalA = await onDisk(A, path);
    expect(finalA).toContain('A1'); // A's edit present
    expect(finalA).toContain('B3'); // B's edit present — neither silently dropped

    // ── And B, on its next sync, converges to the same combined content. ──────
    await client(B).runSync();
    const finalB = await onDisk(B, path);
    expect(finalB).toContain('A1');
    expect(finalB).toContain('B3');
    expect(finalB).toBe(finalA);
  });
});
