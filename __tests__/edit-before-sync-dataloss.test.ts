// ─────────────────────────────────────────────
//  Regression (S1): an edit made just BEFORE a sync must ship in that same round
// ─────────────────────────────────────────────
//
//  Distinct from edit-during-sync-dataloss.test.ts (F5), where the edit lands
//  *inside* the pull→apply window. Here the edit lands on disk *before* runSync,
//  but was never turned into a pending op — exactly the state when a user types,
//  the bytes reach disk, and they hit "Sync" before the debounced `modify` event
//  fires an op. `buildLocalState` would re-hash the disk bytes for the local
//  snapshot, but with no pending op the edit is never PUSHED, so it only reaches
//  the server on a later sync ("the sync didn't take my change").
//
//  The fix: `main.ts::triggerSync` runs `flush()` + `captureOfflineChanges()`
//  before building local state, so any on-disk drift becomes a durable pending op
//  and is pushed in THIS round. runSync itself doesn't call those (that's the
//  plugin's pre-sync step), so this test invokes the same capture explicitly to
//  model what triggerSync now does, then asserts single-round propagation.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 6]);

const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

/** The pre-sync capture main.ts::triggerSync performs before buildLocalState. */
async function preSyncCapture(device: TestDevice): Promise<void> {
  await device.opLogger.flush();
  await device.opLogger.captureOfflineChanges();
}

describe('edit made just before a sync (S1)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('an on-disk edit with no pending op is captured and pushed in the SAME round', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'note.md';

    // ── A creates the file and syncs; B syncs and receives it. ────────────────
    await A.seedFile(path, 'v1\n', 1000);
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('v1\n');

    // ── A edits on disk with NO watcher event and NO flush — bytes on disk, but
    //    the registry hash is stale and there is NO pending op. This is the
    //    pre-sync window a fast type→save→sync produces. ───────────────────────
    A.setWall(2000);
    await A.files.write(path, new TextEncoder().encode('v2-EDITED\n'));
    expect(A.pendingOps.some(op => op.path === path)).toBe(false); // bug precondition

    // ── The pre-sync capture triggerSync now performs turns the drift into a
    //    durable pending op. Without this, the sync below would push nothing for
    //    the file and B would still see v1. ────────────────────────────────────
    await preSyncCapture(A);
    expect(A.pendingOps.some(op => op.path === path)).toBe(true);

    // ── One sync round from A pushes it; one sync from B receives it. The edit
    //    propagates in a SINGLE round, not a later one. ────────────────────────
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('v2-EDITED\n');
    expect(await onDisk(A, path)).toBe('v2-EDITED\n');
  });

  test('capture is idempotent — an unchanged file produces no op and no second-round drift', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const path = 'note.md';

    await A.seedFile(path, 'stable\n', 1000);
    await preSyncCapture(A);        // nothing drifted since seed
    await client(A).runSync();

    // A second pre-sync capture with no on-disk change must emit nothing.
    await preSyncCapture(A);
    expect(A.pendingOps.length).toBe(0);
  });
});
