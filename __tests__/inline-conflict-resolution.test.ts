// ─────────────────────────────────────────────
//  Sync v2 Step 5 — conflicts converge via inline markers + the next save, no modal
// ─────────────────────────────────────────────
//
//  The end-to-end contract for the non-blocking conflict flow, driven through the
//  REAL device stack (registry/content-store/op-logger/applicator/host) over the
//  in-memory FakeSyncServer:
//
//    1. two devices edit the same line concurrently → the conflict is written to the
//       real path as inline zdiff3 markers; the file is "two-headed" (no modal, no
//       cursor hold);
//    2. a save that STILL contains markers is a non-blocking notice, not a resolution
//       — no merge op yet, still two-headed;
//    3. the save that removes the markers re-emits a two-parent merge node; the peer
//       holding the other side fast-forwards onto it and both converge.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { hasConflictMarkers } from '../src/merge/diff3';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 5, 5, 5]);

describe('inline conflict resolution (Step 5)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const onDisk = async (d: TestDevice, path = 'note.md'): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('markers appear, an interim marker-save is a notice, the resolving save converges peers', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // Shared base on both devices.
    const id = await A.seedFile('note.md', '1\n2\n3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B)).toBe('1\n2\n3\n');

    // Concurrent same-line edits. A pushes first; B pulls it and conflicts.
    await A.editFile('note.md', '1\nAAA\n3\n', 2000);
    await client(A).runSync();
    await B.editFile('note.md', '1\nBBB\n3\n', 3000);
    const conflictRound = await client(B).runSync();

    // ── 1. Markers on disk, two-headed, non-blocking (no defer/hold). ──────────
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);
    expect(hasConflictMarkers(await onDisk(B))).toBe(true);
    expect(B.entryByPath('note.md')!.conflictParents?.length).toBe(2);
    expect(conflictRound.deferred).toHaveLength(0); // NOT deferred — the cursor advanced
    expect(B.pendingOps).toHaveLength(0);           // no op emitted for the markers

    // ── 2. A save that STILL has markers is a notice, not a resolution. ────────
    const stillMarked = '1\n<<<<<<< ours\nBBB\n=======\nAAA\n>>>>>>> theirs\nEDITED\n';
    await B.editFile('note.md', stillMarked, 4000);
    expect(B.notices.some(n => n.includes('conflict markers'))).toBe(true);
    expect(B.pendingOps).toHaveLength(0);           // still no merge op
    expect(B.entryByPath('note.md')!.conflictParents?.length).toBe(2); // still two-headed

    // ── 3. The resolving save (markers removed) re-emits a two-parent merge node. ─
    const RESOLVED = '1\nAAA\nBBB\n3\n';
    await B.editFile('note.md', RESOLVED, 5000);
    expect(B.entryByPath('note.md')!.conflictParents == null).toBe(true);
    const res = B.pendingOps.find(op => op.path === 'note.md')!;
    expect(res.id.startsWith('m-')).toBe(true);
    expect(res.parents).toHaveLength(2);

    // B pushes the resolution; A (still holding "AAA") fast-forwards onto it.
    await client(B).runSync();
    const aBefore = A.applied.length;
    await client(A).runSync();
    expect(A.applied.slice(aBefore).some(a => a.type === 'write_local')).toBe(true);
    expect(A.applied.slice(aBefore).some(a => a.type === 'conflict')).toBe(false);

    // Both converge, no modal ever ran.
    expect(await onDisk(A)).toBe(RESOLVED);
    expect(await onDisk(B)).toBe(RESOLVED);
    expect(A.entry(id)!.contentHash).toBe(B.entry(id)!.contentHash);
  });

  test('a peer that never opens the conflicted file still adopts the resolution', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', '1\n2\n3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    // A and B conflict; B is left two-headed with markers and never resolves.
    await A.editFile('note.md', '1\nAAA\n3\n', 2000);
    await client(A).runSync();
    await B.editFile('note.md', '1\nBBB\n3\n', 3000);
    await client(B).runSync();
    expect(hasConflictMarkers(await onDisk(B))).toBe(true);

    // A ALSO conflicts (pulls B's edit) and resolves on its side.
    await client(A).runSync();
    expect(hasConflictMarkers(await onDisk(A))).toBe(true);
    await A.editFile('note.md', '1\nAAA\nBBB\n3\n', 4000);
    await client(A).runSync(); // push A's resolution

    // B — still two-headed, its user never touched the markers — adopts A's
    // resolution automatically on the next sync (the two-headed fast-forward).
    const bBefore = B.applied.length;
    await client(B).runSync();
    expect(B.applied.slice(bBefore).some(a => a.type === 'write_local')).toBe(true);
    expect(B.entryByPath('note.md')!.conflictParents == null).toBe(true);
    expect(await onDisk(B)).toBe('1\nAAA\nBBB\n3\n');
    expect(await onDisk(A)).toBe(await onDisk(B));
  });
});
