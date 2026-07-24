// ─────────────────────────────────────────────
//  Regression: first-sync apply must batch registry writes (O(N), not O(N²))
// ─────────────────────────────────────────────
//
//  On a single self-syncing device, `reconstructRemoteState` excludes the device's
//  own re-pulled ops, so the remote projection is empty and the merge emits one
//  `send_remote`/`no_op` action PER FILE. On the first sync `updateSyncedPaths` then
//  calls `registry.setSyncedPath()` for each — and every registry mutation rewrites the
//  WHOLE registry file (`flush()` serializes all entries). That made the first-sync
//  apply do N full-registry writes: O(N²). On a large mobile vault it ran for minutes,
//  so the user force-closed mid-apply; the cursor (saved only at round end) never
//  advanced, and the whole vault re-pulled + re-applied on every restart — the
//  "applying 8390 changes forever" report.
//
//  The fix batches registry persistence across the whole apply (suspendSaves → one
//  flush at the end). This test pins that the number of registry writes during a
//  first sync is a small constant, independent of the file count.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('first-sync apply batches registry persistence', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('a self-sync of N files does O(1) registry writes during the round, not O(N)', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-solo');

    const N = 40;
    for (let i = 0; i < N; i++) await A.seedFile(`n${i}.md`, `body ${i}`, 1000 + i);

    // Count registry writes to disk (flush) that happen DURING the sync round — install
    // the spy after seeding so the setup's writes aren't counted.
    let flushes = 0;
    const origFlush = A.registry.flush.bind(A.registry);
    A.registry.flush = async () => { flushes++; return origFlush(); };

    await new ServerSyncClient({ api, crypto: vc, host: A.host, hlc: A.hlc }).runSync();

    // Every file's send_remote drives a setSyncedPath; batched, they persist in a single
    // flush. Without the fix this was ≈ N (40). Allow a small constant for the round's
    // other checkpoints, but it must NOT scale with N.
    expect(flushes).toBeLessThanOrEqual(3);

    // And the sync still did its job: every file is recorded as synced at its path, so
    // the next round is a genuine no-op rather than re-marking them.
    for (let i = 0; i < N; i++) {
      const entry = [...A.registry.getAllEntries().values()].find(e => e.path === `n${i}.md`);
      expect(entry?.lastSyncedPath).toBe(`n${i}.md`);
    }
  });
});
