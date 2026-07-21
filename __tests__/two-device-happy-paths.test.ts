// ─────────────────────────────────────────────
//  Two-device happy paths (spec Part 2 — H2, H5, H7, H8, H9)
// ─────────────────────────────────────────────
//
//  The everyday, NON-conflicting flows two devices must get right: a one-sided
//  edit, a rename that also changes content, a batch round touching several files,
//  an identical concurrent edit that must NOT conflict, and three-device fan-out.
//  Each drives the REAL device stack (TestDevice → ServerSyncClient → the genuine
//  mergeVaultStates/SyncApplicator) and asserts the merge DECISION via
//  `device.applied` — not just the end state — so a regression that reached the
//  right bytes by the wrong path (e.g. a spurious conflict) still fails.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { MergeAction } from '../src/types';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

const dec = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);

/** Content on disk at `path`, or null if the file is absent. */
const onDisk = async (d: TestDevice, path: string): Promise<string | null> => dec(await d.files.read(path));

describe('two-device happy paths', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  /** The merge actions a device applied during the most recent round — snapshot
   *  `d.applied.length` before the round, pass it here after. `applied` accumulates
   *  across rounds, so this isolates one round's decisions. */
  const since = (d: TestDevice, mark: number): MergeAction[] => d.applied.slice(mark);
  const typesFor = (actions: MergeAction[], id: string): string[] =>
    actions.filter(a => a.fileId === id).map(a => a.type);

  // ── H2 ─────────────────────────────────────────────────────────────────────
  test('H2: a one-sided text edit reaches the peer as a clean write_local, never a conflict', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // Shared base: A creates and pushes; B pulls it (write_local establishes the
    // common ancestor on B, so a later one-sided edit is unambiguous).
    const id = await A.seedFile('note.md', 'v1\n', 1000);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(dec(await B.content(B.entry(id)!.contentHash))).toBe('v1\n');

    // A edits (only A touches the file) and pushes.
    await A.editFile('note.md', 'v2\n', 2000);
    await client(server, A).runSync();

    // B pulls the edit. Its own copy is untouched since the ancestor, so the merge
    // adopts the remote content: a write_local — NOT a conflict.
    const mark = B.applied.length;
    await client(server, B).runSync();
    const roundTypes = typesFor(since(B, mark), id);
    expect(roundTypes).toContain('write_local');
    expect(roundTypes).not.toContain('conflict');
    expect(await onDisk(B, 'note.md')).toBe('v2\n');
    expect(B.entry(id)!.contentHash).toBe(A.entry(id)!.contentHash);
  });

  // ── H5 ─────────────────────────────────────────────────────────────────────
  //
  //  BUG (found by this test — currently skipped): a rename combined with a content
  //  edit before syncing does NOT propagate the rename to the peer. A emits a `move`
  //  op then an `update` op for the same file; `reconstructRemoteState` keeps only
  //  ONE op per file (the highest-HLC one = the update, whose path is new.md but
  //  whose merge action is a content `write_local`), and `mergeVaultStates` applies
  //  that write at B's LOCAL path (old.md), dropping the move. Observed: B ends up
  //  with the NEW content at the OLD path (old.md), no entry at new.md — and on the
  //  next round B even `send_remote`s the stale path back, so the divergence can
  //  propagate. Un-skip once the projection/merge carries a same-round move+update
  //  as both a path change and a content change. See docs/sync-test-coverage-spec.md H5.
  test.skip('H5 (BUG): a rename that also changes content propagates — new path, new bytes, id stable, old path gone', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // Shared base: A creates old.md; both hold it.
    const id = await A.seedFile('old.md', 'body v1\n', 1000);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(B.entry(id)!.path).toBe('old.md');

    // A renames old.md → new.md AND edits the content in the same logical step,
    // then pushes (a move op followed by an update op at the new path).
    await A.renameAndEdit('old.md', 'new.md', 'body v2\n', 2000);
    await client(server, A).runSync();
    expect(A.entry(id)!.path).toBe('new.md');
    expect(await onDisk(A, 'old.md')).toBeNull();

    // B pulls both ops. It must land on new.md with the new bytes, keep the SAME
    // file id, and not leave the old path orphaned on disk.
    await client(server, B).runSync();
    await client(server, B).runSync(); // settle any two-op ordering into convergence
    expect(B.entryByPath('new.md')?.id).toBe(id);
    expect(await onDisk(B, 'new.md')).toBe('body v2\n');
    expect(await onDisk(B, 'old.md')).toBeNull();
    expect(B.entry(id)!.contentHash).toBe(A.entry(id)!.contentHash);
  });

  // The working variant of the same intent: when the rename and the edit are synced
  // in SEPARATE rounds (a move_local round, then a write_local round), both changes
  // propagate cleanly and the id stays stable. This is the path that currently holds.
  test('H5a: a rename then a later edit (separate rounds) both propagate, id stable', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    const id = await A.seedFile('old.md', 'body v1\n', 1000);
    await client(server, A).runSync();
    await client(server, B).runSync();

    // Round 1: rename only (content unchanged) → move_local on B.
    await A.renameFile('old.md', 'new.md', 2000);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(B.entryByPath('new.md')?.id).toBe(id);
    expect(await onDisk(B, 'old.md')).toBeNull();

    // Round 2: edit at the new path → write_local on B.
    await A.editFile('new.md', 'body v2\n', 3000);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(await onDisk(B, 'new.md')).toBe('body v2\n');
    expect(B.entry(id)!.contentHash).toBe(A.entry(id)!.contentHash);
    expect(B.entry(id)!.path).toBe('new.md');
  });

  // ── H7 ─────────────────────────────────────────────────────────────────────
  test('H7: a batch round (edit + delete + rename + create) replicates every file independently, no cross-talk', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // Shared base: A creates three files; both hold them.
    const id1 = await A.seedFile('f1.md', 'f1 v1\n', 1000);
    const id2 = await A.seedFile('f2.md', 'f2 v1\n', 1000);
    const id3 = await A.seedFile('f3.md', 'f3 stable\n', 1000);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(B.entry(id2)!.deleted).toBe(false);

    // One batch of edits on A: edit f1, delete f2, rename f3 → f3b, create f4.
    await A.editFile('f1.md', 'f1 v2\n', 2000);
    await A.deleteFile('f2.md', 2000);
    await A.renameFile('f3.md', 'f3b.md', 2000);
    const id4 = await A.seedFile('f4.md', 'f4 new\n', 2000);

    // A pushes the whole batch in ONE round; B pulls it in ONE round.
    await client(server, A).runSync();
    const mark = B.applied.length;
    await client(server, B).runSync();

    // Every file landed on B by its own merge action — and none conflicted.
    const batch = since(B, mark);
    expect(batch.some(a => a.type === 'conflict')).toBe(false);
    expect(await onDisk(B, 'f1.md')).toBe('f1 v2\n');
    expect(B.entry(id2)!.deleted).toBe(true);
    expect(await onDisk(B, 'f2.md')).toBeNull();
    expect(B.entry(id3)!.path).toBe('f3b.md'); // id-stable rename
    expect(await onDisk(B, 'f3b.md')).toBe('f3 stable\n');
    expect(await onDisk(B, 'f3.md')).toBeNull();
    expect(await onDisk(B, 'f4.md')).toBe('f4 new\n');
    expect(B.entry(id4)).toBeTruthy();
  });

  // ── H8 ─────────────────────────────────────────────────────────────────────
  test('H8: an identical concurrent edit converges with NO conflict (same hash short-circuits)', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // Shared base.
    const id = await A.seedFile('note.md', 'start\n', 1000);
    await client(server, A).runSync();
    await client(server, B).runSync();

    // Both devices, independently, edit to the EXACT SAME resulting bytes.
    await A.editFile('note.md', 'agreed\n', 2000);
    await B.editFile('note.md', 'agreed\n', 2000);

    // A pushes first; B pushes on top and pulls A's identical op. Since the content
    // hash matches on both sides, the merge no_ops it — a conflict must NOT be
    // raised. A settles by pulling B's (also-identical) op.
    await client(server, A).runSync();
    const markB = B.applied.length;
    await client(server, B).runSync();
    await client(server, A).runSync();

    const bRound = since(B, markB);
    expect(bRound.some(a => a.fileId === id && a.type === 'conflict')).toBe(false);
    expect(A.applied.some(a => a.fileId === id && a.type === 'conflict')).toBe(false);

    // Both converge to the shared content under one hash.
    expect(await onDisk(A, 'note.md')).toBe('agreed\n');
    expect(await onDisk(B, 'note.md')).toBe('agreed\n');
    expect(A.entry(id)!.contentHash).toBe(B.entry(id)!.contentHash);
  });

  // ── H9 ─────────────────────────────────────────────────────────────────────
  test('H9: three devices converge on a one-sided edit, no conflicts, id stable', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const C = await TestDevice.create('dev-c');

    // A creates and pushes; B and C both pull it.
    const id = await A.seedFile('shared.md', 'origin\n', 1000);
    await client(server, A).runSync();
    await client(server, B).runSync();
    await client(server, C).runSync();
    expect(dec(await C.content(C.entry(id)!.contentHash))).toBe('origin\n');

    // B (and only B) edits, then pushes. A and C each pull it as a clean adoption.
    await B.editFile('shared.md', 'edited by B\n', 2000);
    await client(server, B).runSync();

    const markA = A.applied.length;
    const markC = C.applied.length;
    await client(server, A).runSync();
    await client(server, C).runSync();

    expect(typesFor(since(A, markA), id)).not.toContain('conflict');
    expect(typesFor(since(C, markC), id)).not.toContain('conflict');

    // All three agree on B's content under B's file id.
    const want = 'edited by B\n';
    expect(await onDisk(A, 'shared.md')).toBe(want);
    expect(await onDisk(B, 'shared.md')).toBe(want);
    expect(await onDisk(C, 'shared.md')).toBe(want);
    const h = B.entry(id)!.contentHash;
    expect(A.entry(id)!.contentHash).toBe(h);
    expect(C.entry(id)!.contentHash).toBe(h);
  });
});
