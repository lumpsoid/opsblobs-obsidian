// ─────────────────────────────────────────────
//  Regression: a user-resolved conflict must not re-prompt the other device
// ─────────────────────────────────────────────
//
//  Reported behaviour: two devices edit the same lines concurrently. One device
//  syncs, gets the conflict, and the user resolves it. When the OTHER device
//  syncs it was prompted to resolve the *same* conflict again — even though a
//  human already settled it. Worse, a different second choice re-diverges them.
//
//  Root cause: the resolution replicated as a plain `update` op, indistinguishable
//  from a fresh concurrent edit. The second device's merge base was still the
//  pre-conflict ancestor, so `threeWayMerge(oldBase, itsEdit, resolvedContent)`
//  re-detected the conflict.
//
//  Fix (sync v2): the conflict is surfaced as inline zdiff3 markers; the resolving
//  save re-emits a two-parent MERGE NODE (parents = the two conflicting heads). A
//  device still holding either side fast-forwards onto that node (write_local)
//  instead of re-merging. This drives the real ServerSyncClient round against the
//  fake server and asserts the second device converges silently.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { hasConflictMarkers } from '../src/merge/diff3';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('resolved conflict converges without re-prompting the peer', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const onDisk = async (d: TestDevice, path = 'note.md'): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('B resolves; A adopts the resolution silently and both converge', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    const RESOLVED = 'RESOLVED\n';

    // ── A creates the file and syncs; B receives it exactly. ─────────────────
    await A.seedFile('note.md', '1\n2\n3\n', 1000);
    await client(A).runSync();   // real applicator records A's first-sync ancestor
    await client(B).runSync();
    expect(await onDisk(B)).toBe('1\n2\n3\n');

    // ── A edits line 2 and syncs FIRST (no conflict — B hasn't pushed yet). ──
    await A.editFile('note.md', '1\nAAA\n3\n', 2000);
    await client(A).runSync();
    expect(A.applied.some(a => a.type === 'conflict')).toBe(false);

    // ── B edits the SAME line and syncs → the conflict surfaces as inline markers. ─
    await B.editFile('note.md', '1\nBBB\n3\n', 3000);
    await client(B).runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true); // conflict surfaced
    expect(hasConflictMarkers(await onDisk(B))).toBe(true);        // as in-context markers
    expect(B.entryByPath('note.md')!.conflictParents?.length).toBe(2); // B is two-headed

    // ── B's user resolves by editing the markers away and saving. The resolving
    //    save clears the two-headed marker and re-emits a two-parent MERGE NODE (a
    //    content-addressed `m-…` op whose parents are the two conflicting heads);
    //    peers adopt it by fast-forward. ──────────────────────────────────────────
    await B.editFile('note.md', RESOLVED, 4000);
    expect(await onDisk(B)).toBe(RESOLVED);
    expect(B.entryByPath('note.md')!.conflictParents == null).toBe(true);
    const bRes = B.pendingOps.find(op => op.path === 'note.md')!;
    expect(bRes.id.startsWith('m-')).toBe(true);
    expect(bRes.parents.length).toBe(2);

    // The resolution is a pending op for the *next* round, so B syncs once more to
    // push it to the server before any peer can see it.
    await client(B).runSync();

    // ── A syncs again, pulling B's resolution. It must NOT re-prompt: A still
    //    holds "1\nAAA\n3\n", one of the two sides the resolution superseded, so
    //    A adopts the resolution cleanly. ─────────────────────────────────────
    const before = A.applied.length;
    await client(A).runSync();
    const aNew = A.applied.slice(before).map(a => a.type);

    expect(aNew).not.toContain('conflict');   // ← the bug: A used to be re-prompted here
    expect(aNew).toContain('write_local');    // A adopts the resolution
    expect(await onDisk(A)).toBe(RESOLVED);    // both devices now hold the resolved content
    expect(await onDisk(A)).toBe(await onDisk(B)); // converged
  });

  test('a third device that only ever saw the base also adopts the resolution', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const C = await TestDevice.create('dev-c');

    await A.seedFile('note.md', '1\n2\n3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();
    await client(C).runSync();      // C also holds the base, unchanged
    expect(await onDisk(C)).toBe('1\n2\n3\n');

    await A.editFile('note.md', '1\nAAA\n3\n', 2000);
    await client(A).runSync();
    await B.editFile('note.md', '1\nBBB\n3\n', 3000);
    await client(B).runSync();      // B hits the conflict → inline markers
    await B.editFile('note.md', 'RESOLVED\n', 4000);  // B's user resolves the markers
    await client(B).runSync();      // and pushes the resolution merge node

    // C never edited — a clean write_local of the winning content, no prompt.
    await client(C).runSync();
    expect(C.applied.some(a => a.type === 'conflict')).toBe(false);
    expect(await onDisk(C)).toBe('RESOLVED\n');
  });
});
