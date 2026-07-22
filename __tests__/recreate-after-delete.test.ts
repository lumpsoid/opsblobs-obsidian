// ─────────────────────────────────────────────
//  Re-create after delete — local registry consistency + intended conflict behavior
// ─────────────────────────────────────────────
//
//  From the causal-decision audit (finding A, re-diagnosed). A re-create of a
//  tombstoned path emits a fresh-root `create` op reusing the fileId. Two facts:
//   1. BUG FIXED: `registerFile` must resurrect the tombstoned entry in place
//      (deleted=false, fresh contentHash) — otherwise the just-created file is left
//      marked deleted with a stale hash and buildLocalState mis-projects it.
//   2. BY DESIGN (kept): a re-create is a causally-unrelated new file (a DAG root), so
//      a peer that concurrently deleted the file gets a delete/create conflict — the
//      safe outcome (never silently un-delete a file the peer removed). NOT a bug.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([4, 2, 4, 2, 8, 8, 8, 8, 4, 2, 4, 2, 8, 8, 8, 8]);
const onDisk = async (d: TestDevice, p = 'my.md') => {
  const b = await d.files.read(p); return b ? new TextDecoder().decode(b) : '<deleted>';
};

describe('re-create after delete', () => {
  let vc: VaultCrypto;
  beforeAll(async () => { vc = new VaultCrypto(); await vc.deriveFromPassphrase('pp', SALT); });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('FIX: re-creating a tombstoned path resurrects a consistent live entry', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const fid = await A.seedFile('my.md', 'X', 1000);
    await client(api, A).runSync();

    await A.deleteFile('my.md', 2000);
    await client(api, A).runSync();
    expect(A.entryByPath('my.md')?.deleted).toBe(true);

    // Re-create at the same path.
    const fid2 = await A.seedFile('my.md', 'reborn', 3000);
    expect(fid2).toBe(fid);                                   // id reused
    const e = A.entryByPath('my.md')!;
    expect(e.deleted).toBe(false);                            // ← was stuck `true` before the fix
    // contentHash reflects the new content, not the stale delete-time hash.
    const rebornHash = e.contentHash;
    expect(rebornHash).not.toBe('');
    expect(e.headVersionId).toBe('000000000003000-00000000-dev-a');

    // The re-created file syncs as a present file (not mis-projected as deleted).
    await client(api, A).runSync();
    const B = await TestDevice.create('dev-b');
    await client(api, B).runSync();
    expect(await onDisk(B)).toBe('reborn');
  });

  test('BY DESIGN: re-create concurrent with a peer delete surfaces a conflict, never a silent un-delete', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    await A.seedFile('my.md', 'X', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();

    // Both delete; then A re-creates (a new, unrelated file at the same path).
    await A.deleteFile('my.md', 2000);
    await client(api, A).runSync();
    await B.deleteFile('my.md', 3000);
    await client(api, B).runSync();
    await A.seedFile('my.md', 'reborn', 4000);
    await client(api, A).runSync();

    // B must NOT silently un-delete: a delete/create conflict is the safe outcome.
    await client(api, B).runSync();
    expect(B.applied.some(a => a.type === 'delete_conflict')).toBe(true);
  });
});
