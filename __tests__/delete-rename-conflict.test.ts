// ─────────────────────────────────────────────
//  Regression: a concurrent delete must not silently erase a renamed file
// ─────────────────────────────────────────────
//
//  Reported sequence:
//    · A creates `my`, syncs.  B syncs and receives `my`.
//    · B renames `my` → `my-1`.
//    · A deletes `my`, syncs.  B syncs → `my-1` was silently DELETED on B.
//
//  Root cause: the clean-delete check compared only content. A rename leaves
//  content untouched, so B's `my-1` looked "unchanged since the base" and A's
//  delete propagated as a clean `delete_local` — B's rename (a deliberate keep)
//  was discarded with no prompt.
//
//  Fix (sync v2): track the path at last sync (`lastSyncedPath`) and count a rename
//  as a modification in `isUnchangedSinceBase`. A delete concurrent with a rename is
//  a delete/rename conflict, resolved by `deleteConflictStrategy` — like delete-vs-edit.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5]);

describe('concurrent delete vs rename', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const isDeleted = (d: TestDevice, id: string) => !!d.entry(id)?.deleted;
  const pathOf = (d: TestDevice, id: string) => d.entry(id)?.path;

  /** A creates `my`, both devices sync so B holds it with a recorded ancestor;
   *  then B renames my → my-1 and A deletes `my`. Returns wired clients. */
  async function setup() {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    const id = await A.seedFile('my', 'content\n', 1000);
    await client(A).runSync();     // real applicator records A's ancestor (hash + path 'my')
    await client(B).runSync();     // B adopts `my` (adoptRemote sets lastSyncedPath = my)
    expect(pathOf(B, id)).toBe('my');

    await B.renameFile('my', 'my-1', 2000);   // B renames
    await A.deleteFile('my', 2500);           // A deletes (concurrent)
    await client(A).runSync();                // A pushes its delete

    return { A, B, id, client };
  }

  test('B is NOT silently deleted — a delete/rename conflict is surfaced instead', async () => {
    const { B, id, client } = await setup();

    const before = B.applied.length;
    await client(B).runSync();
    const bNew = B.applied.slice(before).map(a => a.type);

    expect(bNew).toContain('delete_conflict');   // surfaced for the user to decide
    expect(bNew).not.toContain('delete_local');  // ← the bug: it used to silently delete
    // With the default (keep_deleted unset ⇒ treated as keep_deleted in the host)
    // the file is only removed because the user/strategy said so, not silently.
  });

  test('restore replicates: B keeps my-1, A adopts it WITHOUT re-prompting', async () => {
    const { A, B, id, client } = await setup();
    // Only B (the device that surfaces the conflict) resolves. A has no resolver
    // — it must adopt B's decision, not raise its own prompt.
    B.resolveDeleteConflict = () => 'restore';

    await client(B).runSync();   // B hits the conflict, keeps my-1
    expect(B.applied.some(a => a.type === 'delete_conflict')).toBe(true);
    await client(B).runSync();   // pushes the restore resolution op

    const before = A.applied.length;
    await client(A).runSync();   // A pulls B's rename + resolution
    const aNew = A.applied.slice(before).map(a => a.type);

    expect(aNew).not.toContain('delete_conflict'); // ← A is NOT re-prompted
    expect(aNew).toContain('write_local');         // A adopts the restored file
    expect(isDeleted(A, id)).toBe(false);
    expect(isDeleted(B, id)).toBe(false);
    expect(pathOf(A, id)).toBe('my-1');
    expect(pathOf(B, id)).toBe('my-1');
  });

  test('keep_deleted replicates: resolver accepts deletion, peer adopts WITHOUT re-prompting', async () => {
    // Rename-first ordering so the *deleter* (A) surfaces the conflict and the
    // *survivor* (B) later fast-forwards onto the keep-deleted tombstone merge node.
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    A.resolveDeleteConflict = () => 'keep_deleted';   // only A resolves

    const id = await A.seedFile('my', 'content\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    await B.renameFile('my', 'my-1', 2000);
    await client(B).runSync();               // B pushes its rename (no conflict yet)

    await A.deleteFile('my', 2500);
    await client(A).runSync();               // A pulls the rename → conflict → keep_deleted
    expect(A.applied.some(a => a.type === 'delete_conflict')).toBe(true);
    await client(A).runSync();               // A pushes the keep-deleted resolution

    const before = B.applied.length;
    await client(B).runSync();               // B (survivor) pulls A's resolution
    const bNew = B.applied.slice(before).map(a => a.type);

    expect(bNew).not.toContain('delete_conflict');   // ← B is NOT re-prompted
    expect(bNew).toContain('delete_local');          // B accepts the deletion
    expect(isDeleted(B, id)).toBe(true);
    expect(isDeleted(A, id)).toBe(true);
  });

  test('a plain one-sided delete (no rename) still propagates cleanly, no prompt', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    const id = await A.seedFile('keep', 'x\n', 1000);
    await client(A).runSync();
    await client(B).runSync();                 // B holds `keep`, untouched

    await A.deleteFile('keep', 2000);
    await client(A).runSync();

    const before = B.applied.length;
    await client(B).runSync();
    const bNew = B.applied.slice(before).map(a => a.type);

    expect(bNew).toContain('delete_local');            // clean, unchanged file
    expect(bNew).not.toContain('delete_conflict');     // no false prompt
    expect(isDeleted(B, id)).toBe(true);
  });
});
