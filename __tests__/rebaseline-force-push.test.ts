// ─────────────────────────────────────────────
// Rebaseline / force-push (S4): this device is the source of truth
// ─────────────────────────────────────────────
//
// `OperationLogger.captureAllAsBaseline()` re-asserts EVERY live file as a
// pending op — even one whose registry hash already matches — so a normal sync
// round reconstructs the server from this client. Distinct from
// captureOfflineChanges, which skips unchanged files. Driven through the REAL
// device stack (TestDevice) so the ops, blobs and merge are genuine.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5]);

const onDisk = async (d: TestDevice, path: string): Promise<string | null> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : null;
};

describe('captureAllAsBaseline — force-push this device to the server (S4)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('re-asserts every live file as an op even when nothing drifted', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedFile('a.md', 'aaa\n', 1000);
    await A.seedFile('b.md', 'bbb\n', 1001);

    // Push both, clearing the pending log — the registry now matches disk exactly,
    // so captureOfflineChanges would emit NOTHING here.
    const server = new FakeSyncServer();
    await client(server, A).runSync();
    expect(A.pendingOps).toHaveLength(0);

    // A baseline must still emit an op per live file despite zero drift.
    await A.opLogger.captureAllAsBaseline();
    const paths = A.pendingOps.map(op => op.path).sort();
    expect(paths).toEqual(['a.md', 'b.md']);
  });

  test('a re-baselined device reconstructs the full file set on a peer', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', 'v1\n', 1000);
    await A.seedFile('deep/nested.md', 'nested\n', 1001);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(await onDisk(B, 'note.md')).toBe('v1\n');
    expect(await onDisk(B, 'deep/nested.md')).toBe('nested\n');

    // A re-baselines (source of truth) and pushes; B pulls and still holds every
    // file with A's content — a re-assert of already-synced files is a clean no-op
    // on B, never a deletion or corruption.
    A.setWall(2000);
    await A.opLogger.captureAllAsBaseline();
    await client(server, A).runSync();
    await client(server, B).runSync();

    expect(await onDisk(B, 'note.md')).toBe('v1\n');
    expect(await onDisk(B, 'deep/nested.md')).toBe('nested\n');
    expect(B.activeEntries()).toHaveLength(2);
  });

  test('is idempotent — running it twice does not duplicate registry entries or corrupt content', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('x.md', 'hello\n', 1000);
    const id = A.entryByPath('x.md')!.id;
    await client(server, A).runSync();

    // First baseline + sync.
    A.setWall(2000);
    await A.opLogger.captureAllAsBaseline();
    await client(server, A).runSync();

    // Second baseline + sync, back-to-back semantics (clearOps ran between).
    A.setWall(3000);
    await A.opLogger.captureAllAsBaseline();
    await client(server, A).runSync();

    // Registry still has exactly one entry for the path under the same id.
    expect(A.activeEntries()).toHaveLength(1);
    expect(A.entryByPath('x.md')!.id).toBe(id);

    // B converges to the single, uncorrupted file.
    await client(server, B).runSync();
    expect(await onDisk(B, 'x.md')).toBe('hello\n');
    expect(B.activeEntries()).toHaveLength(1);
    expect(B.entryByPath('x.md')!.id).toBe(id);
  });
});
