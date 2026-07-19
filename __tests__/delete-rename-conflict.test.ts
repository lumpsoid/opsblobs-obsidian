// ─────────────────────────────────────────────
//  Regression: a concurrent delete must not silently erase a renamed file
// ─────────────────────────────────────────────
//
//  Reported sequence:
//    · A creates `my`, syncs.  B syncs and receives `my`.
//    · B renames `my` → `my-1`.
//    · A deletes `my`, syncs.  B syncs → `my-1` was silently DELETED on B.
//
//  Root cause: `isUnchangedSinceAncestor` compared only the content hash. A
//  rename leaves content untouched, so B's `my-1` looked "unchanged since the
//  ancestor" and A's delete propagated as a clean `delete_local` — B's rename
//  (a deliberate keep) was discarded with no prompt.
//
//  Fix: track the path at last sync (`ancestorPath`) and count a rename as a
//  modification. A delete concurrent with a rename is now a delete/rename
//  conflict, resolved by `deleteConflictStrategy` — exactly like delete-vs-edit.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerApi, ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { HybridLogicalClock } from '../src/core/hlc';
import { FakeSyncServer } from '../src/network/fake-server';
import { MemoryHost, seedFile, deleteFile, renameFile } from './helpers/memory-host';

const SALT = new Uint8Array([4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5]);

describe('concurrent delete vs rename', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const isDeleted = (h: MemoryHost, id = 'f1') => !!h.fileEntries.get(id)?.deleted;
  const pathOf = (h: MemoryHost, id = 'f1') => h.fileEntries.get(id)?.path;

  /** A creates `my`, both devices sync so B holds it with a recorded ancestor;
   *  then B renames my → my-1 and A deletes `my`. Returns wired clients. */
  async function setup() {
    const api: ServerApi = new FakeSyncServer();
    const client = (h: MemoryHost, d: string) =>
      new ServerSyncClient({ api, crypto: vc, host: h, hlc: new HybridLogicalClock(d) });

    const A = new MemoryHost('dev-a');
    const B = new MemoryHost('dev-b');

    const { hash } = await seedFile(A, 'dev-a', 'f1', 'my', 'content\n', 1000);
    await client(A, 'dev-a').runSync();
    A.fileEntries.get('f1')!.ancestorContentHash = hash;   // mirror first-sync ancestor
    A.fileEntries.get('f1')!.ancestorPath = 'my';
    await client(B, 'dev-b').runSync();                     // B adopts `my` (ancestorPath = my)
    expect(pathOf(B)).toBe('my');

    renameFile(B, 'dev-b', 'f1', 'my', 'my-1', 2000);       // B renames
    deleteFile(A, 'dev-a', 'f1', 'my', 2500);               // A deletes (concurrent)
    await client(A, 'dev-a').runSync();                     // A pushes its delete

    return { A, B, client };
  }

  test('B is NOT silently deleted — a delete/rename conflict is surfaced instead', async () => {
    const { B, client } = await setup();

    const before = B.applied.length;
    await client(B, 'dev-b').runSync();
    const bNew = B.applied.slice(before).map(a => a.type);

    expect(bNew).toContain('delete_conflict');   // surfaced for the user to decide
    expect(bNew).not.toContain('delete_local');  // ← the bug: it used to silently delete
    // With the default (keep_deleted unset ⇒ treated as keep_deleted in the host)
    // the file is only removed because the user/strategy said so, not silently.
  });

  test('keep the renamed file: both devices converge to `my-1`', async () => {
    const { A, B, client } = await setup();
    // Same strategy on both devices (realistic: one user, one setting).
    A.resolveDeleteConflict = () => 'restore';
    B.resolveDeleteConflict = () => 'restore';

    await client(B, 'dev-b').runSync();   // B keeps my-1
    await client(A, 'dev-a').runSync();   // A pulls B's rename, restores my-1

    expect(isDeleted(B)).toBe(false);
    expect(isDeleted(A)).toBe(false);
    expect(pathOf(B)).toBe('my-1');
    expect(pathOf(A)).toBe('my-1');
  });

  test('accept the deletion: both devices converge to removed', async () => {
    const { A, B, client } = await setup();
    A.resolveDeleteConflict = () => 'keep_deleted';
    B.resolveDeleteConflict = () => 'keep_deleted';

    await client(B, 'dev-b').runSync();
    await client(A, 'dev-a').runSync();

    expect(isDeleted(B)).toBe(true);
    expect(isDeleted(A)).toBe(true);
  });

  test('a plain one-sided delete (no rename) still propagates cleanly, no prompt', async () => {
    const api: ServerApi = new FakeSyncServer();
    const client = (h: MemoryHost, d: string) =>
      new ServerSyncClient({ api, crypto: vc, host: h, hlc: new HybridLogicalClock(d) });
    const A = new MemoryHost('dev-a');
    const B = new MemoryHost('dev-b');

    const { hash } = await seedFile(A, 'dev-a', 'f1', 'keep', 'x\n', 1000);
    await client(A, 'dev-a').runSync();
    A.fileEntries.get('f1')!.ancestorContentHash = hash;
    A.fileEntries.get('f1')!.ancestorPath = 'keep';
    await client(B, 'dev-b').runSync();                 // B holds `keep`, untouched

    deleteFile(A, 'dev-a', 'f1', 'keep', 2000);
    await client(A, 'dev-a').runSync();

    const before = B.applied.length;
    await client(B, 'dev-b').runSync();
    const bNew = B.applied.slice(before).map(a => a.type);

    expect(bNew).toContain('delete_local');            // clean, unchanged file
    expect(bNew).not.toContain('delete_conflict');     // no false prompt
    expect(isDeleted(B)).toBe(true);
  });
});
