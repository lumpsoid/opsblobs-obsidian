// ─────────────────────────────────────────────
//  Regression: concurrent conflicting edits must not silently lose data
// ─────────────────────────────────────────────
//
//  Reproduces a reported bug and locks in its fix. Two devices (A, B) edit the
//  same lines of one file concurrently. The bug was that A's edit got *silently*
//  replaced by B's — no conflict prompt, data lost — and the devices diverged.
//
//  Reported sequence (verbatim):
//    · A creates `test-conflict.md`:      1 / 2 / 3         and syncs
//    · B syncs, gets it exactly, edits:   1 / 2 / 999       and syncs
//    · concurrently A edits:              1 / 2 / 4 / 5      and syncs
//        → A ended up showing             1 / 2 / 999        (A's edit lost!)
//
//  Root cause (client-side, server-agnostic): the edit hadn't been recorded as
//  an op yet when sync ran — `triggerSync` didn't flush the OperationLogger's
//  debounce, so an edit-then-immediately-sync raced it — and
//  `PluginVaultSyncHost.buildLocalState` then read the *current* file bytes but
//  keyed them under the registry's now-*stale* `contentHash`. That aliased the
//  new bytes over the ancestor, so the three-way merge saw A's side as unchanged
//  and cleanly adopted the remote → silent clobber.
//
//  The merge itself was always correct:
//  `threeWayMerge('1\n2\n3', '1\n2\n4\n5', '1\n2\n999')` reports a conflict. The
//  defect was the inconsistent state fed into it.
//
//  Fix (both landed): `triggerSync` flushes the debounce before building state,
//  and `buildLocalState` keys content under the *actual* hash of the bytes on
//  disk (correcting the entry if the registry hash is stale) so current bytes can
//  never masquerade as the ancestor. This drives the REAL device stack (registry,
//  content store, op logger, applicator, host) over in-memory fakes via
//  `TestDevice` and asserts the fixed behaviour: a conflict is surfaced and A
//  keeps its edit rather than silently taking B's.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { hasConflictMarkers } from '../src/merge/diff3';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

/**
 * Model the debounce race: the file on disk now reads `newText`, but no vault
 * modify event was ever delivered to the op logger — so the registry entry's
 * `contentHash` (and ancestor) are still the old ones and there is no pending op.
 * This is exactly the state a sync sees when it runs inside the op-logger's
 * debounce window; `buildLocalState` re-hashes the disk bytes so the merge still
 * compares the real content against the true ancestor.
 */
async function editWithoutLogging(device: TestDevice, path: string, newText: string): Promise<void> {
  await device.files.write(path, new TextEncoder().encode(newText));
  // deliberately: no watcher event → no registry hash update, no pending op.
}

describe('concurrent conflicting edits (reported data-loss bug)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  /** A device's current file content = its on-disk bytes. */
  const onDisk = async (d: TestDevice, path: string): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('A must not silently lose its edit when B changed the same lines', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'test-conflict.md';

    // ── A creates `test-conflict.md` = "1\n2\n3" and syncs. ──────────────────
    await A.seedFile(path, '1\n2\n3\n', 1000);
    await client(A).runSync();   // real applicator records A's first-sync ancestor

    // ── B syncs, receiving A's file exactly. ────────────────────────────────
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('1\n2\n3\n');

    // ── B edits line 3 → "1\n2\n999" and syncs (a normal, logged edit). ─────
    await B.editFile(path, '1\n2\n999\n', 2000);
    await client(B).runSync();

    // ── Concurrently, A edits line 3 and appends → "1\n2\n4\n5". The edit
    //    reaches the file but hasn't been logged as an op when A's sync fires
    //    (the debounce race). ─────────────────────────────────────────────────
    await editWithoutLogging(A, path, '1\n2\n4\n5\n');
    await client(A).runSync();

    // ── With the fix: A's edit and B's edit touch the same line, so this is a
    //    genuine conflict — it must be surfaced, and A must keep its own edit
    //    rather than silently adopting B's "1\n2\n999". Sync v2 Step 5: the conflict
    //    is surfaced as inline markers, with A's edit preserved in the "ours" side. ─
    expect(A.applied.some(a => a.type === 'conflict')).toBe(true);   // conflict surfaced
    expect(A.applied.some(a => a.type === 'write_local')).toBe(false); // NOT a silent overwrite
    const marked = await onDisk(A, path);
    expect(hasConflictMarkers(marked)).toBe(true);                  // inline conflict markers
    expect(marked).toContain('4');                                  // A's edit preserved…
    expect(marked).toContain('5');
    expect(marked).toContain('999');                               // …alongside B's side
    expect(marked).not.toBe('1\n2\n999\n');                        // and not silently clobbered
  });

  // A second, distinct data-loss path reported after the debounce fix landed:
  // here both edits ARE logged, but the *first* device to sync its edit re-pulled
  // its own ops and merged its fresh edit against that stale self-projection,
  // producing a clean `write_local` of its own content that advanced its ancestor
  // to its un-acknowledged edit. Its later merge against the peer's concurrent
  // edit then used the wrong base and silently clobbered its own change.
  // Fix: exclude own ops from the remote projection (reconstructRemoteState) and
  // derive the base from the op-id DAG (LCA), so syncing your own edit never
  // corrupts the base a later concurrent merge compares against — both exercised
  // through the REAL stack, not a fake's approximation.
  test('the device that syncs its edit first must not clobber its own change', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'my-first';

    // ── A creates `my-first` = "1\n2\n3", syncs; B syncs and receives it. ────
    const id = await A.seedFile(path, '1\n2\n3\n', 1000);
    const baseHash = A.entry(id)!.contentHash;
    await client(A).runSync();   // real applicator records A's first-sync ancestor
    await client(B).runSync();

    // ── A edits → "1\n2\n4\n5" and syncs FIRST (a normal logged edit). ───────
    await A.editFile(path, '1\n2\n4\n5\n', 2000);
    await client(A).runSync();
    // Syncing its own edit must not corrupt A's base to that edit (sync v2: the base
    // is the op-id DAG's LCA, not a scalar ancestor). A is genuinely at its own edit
    // (its head's content IS the edit), and the ORIGINAL base "1\n2\n3" is still
    // reachable as an ancestor — so a later merge against B's concurrent edit uses
    // the true common base, not the un-acknowledged edit.
    const dag = await A.versionDagStore.load();
    const head = A.entry(id)!.headVersionId!;
    expect(dag.contentHashOf(head)).toBe(A.entry(id)!.contentHash);
    expect(dag.reachableContentHashes(head).has(baseHash)).toBe(true);
    expect(A.applied.some(a => a.type === 'write_local')).toBe(false);

    // ── B concurrently edits the same line → "1\n2\n999" and syncs. ──────────
    await B.editFile(path, '1\n2\n999\n', 3000);
    await client(B).runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true); // B sees the conflict

    // ── A syncs again, pulling B's concurrent edit. ──────────────────────────
    const before = A.applied.length;
    await client(A).runSync();
    const aActions = A.applied.slice(before).map(a => a.type);

    // A must surface a conflict against the TRUE base "1\n2\n3" and keep its own
    // edit — never silently adopt B's "1\n2\n999".
    expect(aActions).toContain('conflict');
    expect(aActions).not.toContain('write_local');
    const marked = await onDisk(A, path);
    expect(hasConflictMarkers(marked)).toBe(true);   // surfaced as inline markers
    expect(marked).toContain('4');                   // A's edit preserved…
    expect(marked).toContain('5');
    expect(marked).toContain('999');                 // …alongside B's concurrent edit
    expect(marked).not.toBe('1\n2\n999\n');          // never silently adopted B's version
  });
});
