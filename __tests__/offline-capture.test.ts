// ─────────────────────────────────────────────
//  Cold-start capture & pre-sync pruning (H10, G11)
// ─────────────────────────────────────────────
//
//  Two edges of "getting local reality into the oplog" that don't go through a
//  live vault event:
//   · H10 — a vault that already had files before the plugin's listeners
//           attached. No `create` event ever fires for them, so without an
//           explicit offline scan their content would never become an op and
//           never reach the server. `captureOfflineChanges` is that scan.
//   · G11 — a file created and deleted before any sync. The remote never knew it
//           existed, so nothing about it should reach a peer.
//
//  Driven through the REAL device stack (TestDevice over in-memory fakes), so the
//  genuine OperationLogger / registry / round are exercised, not a look-alike.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { FakeSyncServer } from '../src/network/fake-server';
import { VaultCrypto } from '../src/network/encryption';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

let vc: VaultCrypto;
beforeAll(async () => {
  vc = new VaultCrypto();
  await vc.deriveFromPassphrase('correct horse battery staple', SALT);
});

const client = (api: FakeSyncServer, device: TestDevice): ServerSyncClient =>
  new ServerSyncClient({ api, crypto: vc, host: device.host, hlc: device.hlc });

const read = async (d: TestDevice, path: string): Promise<string | null> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : null;
};

describe('first-enable on a pre-existing vault (H10)', () => {
  test('captureOfflineChanges emits a create per pre-existing file and they reach a peer', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    // Files that were already in the vault before listeners attached — no create
    // event fires for them, and they are NOT yet in the registry.
    await A.seedExistingFile('welcome.md', '# Welcome\n');
    await A.seedExistingFile('notes/todo.md', '- [ ] sync\n');
    await A.seedExistingFile('deep/nested/log.md', 'entry one\n');
    expect(A.pendingOps).toHaveLength(0);            // nothing captured yet
    expect(A.entryByPath('welcome.md')).toBeUndefined();

    // The cold-start scan turns each on-disk file into a create op + registry entry.
    await A.opLogger.captureOfflineChanges();

    const created = A.pendingOps.filter(op => op.type === 'create').map(op => op.path).sort();
    expect(created).toEqual(['deep/nested/log.md', 'notes/todo.md', 'welcome.md']);
    expect(A.pendingOps).toHaveLength(3);            // exactly one op per file, nothing else
    // The registry now tracks each with its REAL content hash (not the '' placeholder).
    for (const path of ['welcome.md', 'notes/todo.md', 'deep/nested/log.md']) {
      const entry = A.entryByPath(path);
      expect(entry).toBeDefined();
      expect(entry!.contentHash).not.toBe('');
      expect(entry!.deleted).toBe(false);
    }

    // ── Push, then a fresh device pulls and materialises all three with content. ──
    await client(server, A).runSync();
    expect(A.pendingOps).toHaveLength(0);

    const B = await TestDevice.create('dev-b');
    await client(server, B).runSync();
    expect(await read(B, 'welcome.md')).toBe('# Welcome\n');
    expect(await read(B, 'notes/todo.md')).toBe('- [ ] sync\n');
    expect(await read(B, 'deep/nested/log.md')).toBe('entry one\n');
    expect(B.activeEntries()).toHaveLength(3);
  });

  test('captureOfflineChanges is idempotent — a second scan with no change emits nothing', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedExistingFile('a.md', 'body\n');
    await A.seedExistingFile('b.md', 'body\n');

    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(2);

    // Nothing on disk changed → the second scan must not re-emit or duplicate.
    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps).toHaveLength(2);
    expect(A.pendingOps.filter(op => op.path === 'a.md')).toHaveLength(1);
    expect(A.pendingOps.filter(op => op.path === 'b.md')).toHaveLength(1);
  });
});

describe('create-then-delete before any sync (G11)', () => {
  test('a peer never materialises a file that was created and deleted before its first sync', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    // A durable file so A has *something* to sync (keeps the round non-trivial).
    await A.seedFile('keep.md', 'keep me\n', 1000);

    // The transient file: created then deleted, both before any sync ever ran.
    const tmpId = await A.seedFile('tmp.md', 'ephemeral\n', 1100);
    await A.deleteFile('tmp.md', 1200);

    // ── A and a fresh B both sync. ──
    await client(server, A).runSync();
    const B = await TestDevice.create('dev-b');
    await client(server, B).runSync();

    // The user-facing guarantee: B has the durable file and NEVER the transient one.
    expect(await read(B, 'keep.md')).toBe('keep me\n');
    expect(await read(B, 'tmp.md')).toBeNull();
    const bTmp = B.entryByPath('tmp.md');
    expect(bTmp === undefined || bTmp.deleted).toBe(true); // absent, or at worst a tombstone
    // B never adopts the transient id as a live file.
    const bById = B.entry(tmpId);
    expect(bById === undefined || bById.deleted).toBe(true);
    expect(B.activeEntries().map(e => e.path)).toEqual(['keep.md']);
  });

  // KNOWN BUG (skipped, not forced green) — see report.
  // `handleDelete` calls `pruneCreateDeletePair(id)` (which removes the un-synced
  // create), but then STILL `recordOp(Ops.delete(...))`. So a file created and
  // deleted before any sync does NOT fully cancel: a phantom `delete` op survives
  // and is pushed to the server, referencing a contentHash whose blob was never
  // uploaded (the create was pruned). The comment on pruneCreateDeletePair —
  // "remove both ops. They cancel out — remote doesn't know the file ever existed"
  // — describes the INTENDED behaviour this test pins. It's currently only
  // cosmetically harmless (a peer no-ops the orphan tombstone, as the test above
  // proves), but it's a spurious op / audit-G-style leak of an unheld contentHash.
  // Fix: have handleDelete skip recordOp when pruneCreateDeletePair pruned a create
  // (i.e. the file was never synced). Then un-skip this test.
  test.skip('the create/delete pair fully cancels — no op for the transient file is ever pushed', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    await A.seedFile('keep.md', 'keep me\n', 1000);

    const tmpId = await A.seedFile('tmp.md', 'ephemeral\n', 1100);
    // Before the delete: a create op for tmp is queued.
    expect(A.pendingOps.some(op => op.fileId === tmpId)).toBe(true);

    await A.deleteFile('tmp.md', 1200);

    // The create/delete pair cancels out (pruneCreateDeletePair): the remote never
    // knew tmp existed, so NO op for it should survive to be pushed — not even a
    // delete that references content no peer holds.
    expect(A.pendingOps.filter(op => op.fileId === tmpId)).toEqual([]);

    // And nothing tmp-shaped lands on the server: only keep.md's create is durable.
    await client(server, A).runSync();
    const C = await TestDevice.create('dev-c');
    await client(server, C).runSync();
    expect(C.activeEntries().map(e => e.path)).toEqual(['keep.md']);
    expect(await read(C, 'tmp.md')).toBeNull();
  });
});
