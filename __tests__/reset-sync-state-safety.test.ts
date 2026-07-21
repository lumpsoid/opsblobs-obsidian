// ─────────────────────────────────────────────
//  Regression (S3): "Reset sync state" must not discard un-synced changes
// ─────────────────────────────────────────────
//
//  The old resetSyncState did `reconcileWithVault` + `clearOps()` — throwing away
//  the pending oplog, so any edit captured-but-not-yet-synced was silently lost.
//  The fixed path replaces `clearOps()` with `captureOfflineChanges()`: the
//  registry is rebuilt and every on-disk file re-captured as ops, so nothing the
//  user hasn't synced disappears. main.ts wires a confirmation modal (not
//  unit-testable without real Obsidian) around this sequence; here we drive the
//  underlying store sequence directly via TestDevice.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 1, 1, 1, 1, 1, 1, 1, 1]);

const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

/** The non-destructive reset sequence main.ts::resetSyncState now performs. */
async function safeReset(d: TestDevice): Promise<void> {
  await d.registry.reconcileWithVault(d.hlc.now());
  await d.opLogger.captureOfflineChanges();
}

describe('reset sync state safety (S3)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('a reset with un-synced pending ops does NOT lose the change', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'note.md';

    // A creates + syncs; B receives it.
    await A.seedFile(path, 'v1\n', 1000);
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('v1\n');

    // A edits — the update op is now PENDING and un-synced.
    await A.editFile(path, 'v2-EDITED\n', 2000);
    expect(A.pendingOps.some(op => op.path === path)).toBe(true);

    // The user rebuilds sync metadata mid-flight. The safe reset must preserve
    // the un-synced edit (either as the surviving pending op or re-captured).
    await safeReset(A);
    expect(A.pendingOps.some(op => op.path === path)).toBe(true);

    // The edit still propagates in the next round.
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('v2-EDITED\n');
  });

  test('the old clearOps() path WOULD have dropped the edit (documents the guard)', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'note.md';

    await A.seedFile(path, 'v1\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    await A.editFile(path, 'v2-EDITED\n', 2000);

    // Simulate the OLD destructive reset: reconcile then clear the oplog. Because
    // the registry hash already matches disk, a re-capture finds no drift — so the
    // cleared edit is gone for good.
    await A.registry.reconcileWithVault(A.hlc.now());
    await A.opLogger.clearOps();
    await A.opLogger.captureOfflineChanges();
    expect(A.pendingOps.some(op => op.path === path)).toBe(false);

    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('v1\n'); // edit was lost — the bug S3 fixes
  });

  test('a reset re-derives an op when the registry drifted from disk', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'note.md';

    await A.seedFile(path, 'v1\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    // Bytes change on disk with no watcher event and no pending op — the registry
    // hash is now stale. captureOfflineChanges (run by the reset) must re-derive
    // the update op from the drift.
    A.setWall(3000);
    await A.files.write(path, new TextEncoder().encode('v3-DRIFTED\n'));
    expect(A.pendingOps.length).toBe(0);

    await safeReset(A);
    expect(A.pendingOps.some(op => op.path === path)).toBe(true);

    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B, path)).toBe('v3-DRIFTED\n');
  });
});
