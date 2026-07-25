// ─────────────────────────────────────────────
//  Pull-side blob dedup (fetchRemoteBlobs tiers 0/1/2)
// ─────────────────────────────────────────────
//
//  Regression guard for the "download EVERY blob again" pattern: after the A2 cut
//  emptied `local.contentStore` on the pre-pull identity build, the download dedup
//  check (`!local.contentStore.has(hash)`) became a near-constant TRUE, so a pull
//  re-fetched every live remote file's blob even when the device already physically
//  held it in its packs. `fetchRemoteBlobs` now resolves each wanted hash locally
//  first — Tier 0 (registry match, same fileId+hash → converged, no bytes needed) and
//  Tier 1 (pack store holds it → serve locally, hash-verified) — and only Tier 2
//  (genuine gaps) touches the network.
//
//  Drives the REAL device stack (TestDevice → ServerSyncClient → the genuine
//  PluginVaultSyncHost/ContentStore) and counts blobs the server actually served, so
//  a regression that silently reintroduces the redundant download fails here.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);
const dec = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);
const onDisk = async (d: TestDevice, path: string): Promise<string | null> => dec(await d.files.read(path));

/**
 * Wrap a FakeSyncServer so we can count blobs it *actually served* over
 * `getBlobBatch` (the content-download path). The key-check record rides on `getBlob`,
 * so counting only the batch path excludes it and measures exactly the content
 * downloads a pull performs. Delegation is bound to the real server so its private
 * content-addressed store still works.
 */
function countingApi(inner: FakeSyncServer): { api: FakeSyncServer; blobsFetched: () => number } {
  let fetched = 0;
  const api = new Proxy(inner, {
    get(target, prop, _receiver) {
      if (prop === 'getBlobBatch') {
        return async (hashes: string[]) => {
          const res = await target.getBlobBatch(hashes);
          fetched += res.blobs.size;
          return res;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as FakeSyncServer;
  return { api, blobsFetched: () => fetched };
}

describe('pull-side blob dedup', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('a re-pull of already-held content downloads zero blobs; a fresh device still downloads all', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // A seeds several files and pushes; B pulls them once (this first pull legitimately
    // downloads — B's packs start empty).
    await A.seedFile('a.md', 'alpha\n', 1000);
    await A.seedFile('b.md', 'bravo\n', 1000);
    await A.seedFile('c.md', 'charlie\n', 1000);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(server.blobCount).toBe(4); // 3 content blobs + 1 key-check record
    expect(await onDisk(B, 'a.md')).toBe('alpha\n');

    // Force B to re-pull every op from seq 0 — models a version-DAG rebuild / cursor
    // rewind. B's packs and DAG are intact, so every remote file is Tier-0 converged
    // (same fileId + same contentHash). The re-pull must fetch NO blobs.
    await B.cursorStore.save(0);
    const bRepull = countingApi(server);
    await new ServerSyncClient({ api: bRepull.api, crypto: vc, host: B.host, hlc: B.hlc }).runSync();
    expect(bRepull.blobsFetched()).toBe(0);
    // Still converged after the re-pull — no data lost by skipping the download.
    expect(await onDisk(B, 'a.md')).toBe('alpha\n');
    expect(await onDisk(B, 'b.md')).toBe('bravo\n');
    expect(await onDisk(B, 'c.md')).toBe('charlie\n');

    // Control: a genuinely fresh device (empty packs) MUST download all three, proving
    // the zero above is dedup working — not a broken counter or an empty server.
    const C = await TestDevice.create('dev-c');
    const cFresh = countingApi(server);
    await new ServerSyncClient({ api: cFresh.api, crypto: vc, host: C.host, hlc: C.hlc }).runSync();
    expect(cFresh.blobsFetched()).toBe(3);
    expect(await onDisk(C, 'a.md')).toBe('alpha\n');
  });

  test('Tier 1: a remote-only file whose content the device already holds is served from packs, not downloaded', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // Both devices independently create the SAME bytes, but under different ids/paths —
    // B holds the content in its packs (via local-copy.md), yet NOT under A's file id.
    // (Same plaintext ⇒ same content hash ⇒ same blinded server key.)
    await A.seedFile('shared.md', 'identical body\n', 1000);
    await B.seedFile('local-copy.md', 'identical body\n', 1000);
    await client(server, A).runSync(); // server holds the blob (from A)

    // B's FIRST pull sees A's shared.md: a remote-ONLY file (id B has never seen, so
    // Tier 0 misses) whose CONTENT B already holds in its packs. Tier 1 must serve it
    // locally — zero server blob fetches — and the file must still be written (proving
    // the bytes reached `remote.contentStore`, not a silent no_op).
    const bFirst = countingApi(server);
    await new ServerSyncClient({ api: bFirst.api, crypto: vc, host: B.host, hlc: B.hlc }).runSync();
    expect(bFirst.blobsFetched()).toBe(0);
    expect(await onDisk(B, 'shared.md')).toBe('identical body\n');
    expect(await onDisk(B, 'local-copy.md')).toBe('identical body\n');
  });
});
