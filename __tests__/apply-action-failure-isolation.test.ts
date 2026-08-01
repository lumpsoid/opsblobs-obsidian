// ─────────────────────────────────────────────
//  Regression: one throwing action must not abort the whole apply
// ─────────────────────────────────────────────
//
//  The real incident. A vault was reorganized on device A — many files moved into
//  newly-created folders, some deleted — and syncing those ops to device B failed
//  with "The parent object of the destination does not exist". Root cause was in the
//  adapter (`ObsidianVaultFiles.move` renamed into a folder it never created, unlike
//  `write`, which has always `ensureDir`'d — folders are not synced entities, so a
//  peer's reorganization replicates as moves into directories this device has never
//  seen). But the *damage* came from the applicator: the throw escaped the action
//  loop, so
//    · every action after it was skipped — the vault was left half-applied
//      (42 files tombstoned, 1 moved, thousands untouched);
//    · `updateSyncedPaths`, the resolution re-emit and the F5 recapture never ran;
//    · the cursor was correctly held — so the next round replayed the IDENTICAL
//      action list and threw at the IDENTICAL spot. Permanently wedged.
//
//  The adapter bug is fixed at its source, but the class is not adapter-specific
//  (permissions, a locked file, a full disk, the next Obsidian API quirk). So this
//  pins the ENGINE's behavior: an action that throws is isolated — that one file is
//  deferred (cursor held, retried next round) and reported in `applyFailures`, while
//  every other action in the round still applies.
//
//  `FakeVaultFiles.failNextOn` stands in for the adapter-level failure; the fake
//  cannot reproduce the Obsidian bug itself (that's the manual-smoke surface), but
//  it reproduces exactly the shape the engine has to survive.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 6]);
const MISSING_PARENT = 'The parent object of the destination does not exist';

const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<absent>';
};

describe('a throwing apply action is isolated, not fatal to the round', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('a failing move defers only its own file; the rest of the reorganization still applies', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // ── Both devices converged on a flat vault. ───────────────────────────────
    await A.seedFile('moved.md', 'M\n', 1000);
    await A.seedFile('edited.md', 'E1\n', 1010);
    await A.seedFile('removed.md', 'R\n', 1020);
    await A.seedFile('kept.md', 'K\n', 1030);
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, 'moved.md')).toBe('M\n');

    // ── A reorganizes: a move into a brand-new folder, plus an edit and a
    //    delete — the exact mix the incident vault pushed. ────────────────────
    await A.renameFile('moved.md', 'projects/archive/moved.md', 2000);
    await A.editFile('edited.md', 'E2\n', 2010);
    await A.deleteFile('removed.md', 2020);
    await client(A).runSync();

    // ── B applies it, but the move into the new folder throws (once). ─────────
    B.files.failNextOn('projects/archive/moved.md', MISSING_PARENT);
    const summary = await client(B).runSync();   // must NOT throw

    // The failure is reported, and names the action that failed.
    expect(summary.applyFailures).toHaveLength(1);
    expect(summary.applyFailures[0]!.actionType).toBe('move_local');
    expect(summary.applyFailures[0]!.message).toBe(MISSING_PARENT);

    // Its file is deferred, so the cursor is held and the op re-pulls next round.
    const failedId = summary.applyFailures[0]!.fileId;
    expect(summary.deferred).toContain(failedId);

    // ── The regression: everything else in the round still applied. Pre-fix the
    //    throw aborted the loop and whichever actions came after it were lost. ─
    expect(await onDisk(B, 'edited.md')).toBe('E2\n');   // the edit landed
    expect(await onDisk(B, 'removed.md')).toBe('<absent>'); // the delete landed
    expect(await onDisk(B, 'kept.md')).toBe('K\n');      // untouched file intact

    // The failed move left B's copy where it was — nothing dropped, nothing
    // half-written at the destination.
    expect(await onDisk(B, 'moved.md')).toBe('M\n');
    expect(await onDisk(B, 'projects/archive/moved.md')).toBe('<absent>');

    // ── Next round: the held cursor re-pulls the move and it now succeeds. ────
    const retry = await client(B).runSync();
    expect(retry.applyFailures).toHaveLength(0);
    expect(await onDisk(B, 'projects/archive/moved.md')).toBe('M\n');
    expect(await onDisk(B, 'moved.md')).toBe('<absent>');

    // ── And B converges with A. ───────────────────────────────────────────────
    await client(A).runSync();
    expect(await onDisk(A, 'projects/archive/moved.md')).toBe('M\n');
    expect(await onDisk(A, 'edited.md')).toBe(await onDisk(B, 'edited.md'));
  });

  test('a SYSTEMIC failure still fails the round loudly instead of deferring the whole vault', async () => {
    // Isolation is for one awkward file. When every action throws — disk full,
    // permissions revoked, the vault unmounted — grinding through thousands of
    // actions to defer each one buys nothing and would report a round that looks
    // like it merely deferred some files. Past MAX_ACTION_FAILURES the apply
    // rethrows, so the round fails the way it always did.
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a2');
    const B = await TestDevice.create('dev-b2');

    const paths = Array.from({ length: 30 }, (_, i) => `note-${i}.md`);
    for (const [i, p] of paths.entries()) await A.seedFile(p, `body ${i}\n`, 1000 + i);
    await client(A).runSync();

    for (const p of paths) B.files.failNextOn(p, 'EACCES: permission denied');
    await expect(client(B).runSync()).rejects.toThrow('EACCES');
  });
});
