// Diagnostic: reconcileConcurrentHeads must not rebuild the whole-vault local identity
// once PER FOLD. A first sync that pulls interleaved multi-device history gets ≥2
// concurrent heads for MANY files at once; folding one file per buildLocalIdentity is
// O(files × vault) and dominated a real device round (reconcileConcurrentHeads ~9s).

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { VaultState } from '../src/types';
import { VersionDag } from '../src/core/version-dag';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([7, 7, 7, 7, 2, 2, 2, 2, 7, 7, 7, 7, 2, 2, 2, 2]);
const dec = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);
const onDisk = async (d: TestDevice, p: string): Promise<string | null> => dec(await d.files.read(p));

/** Count how many times a device's `host.buildLocalIdentity` is invoked. */
function spyBuildIdentity(d: TestDevice): { count: () => number } {
  let n = 0;
  const orig = d.host.buildLocalIdentity.bind(d.host);
  d.host.buildLocalIdentity = async (dag: VersionDag): Promise<VaultState> => {
    n++;
    return orig(dag);
  };
  return { count: () => n };
}

describe('reconcileConcurrentHeads rebuild cost', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('reconcile-perf', SALT);
  });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('N files each with 2 concurrent heads fold with O(passes) rebuilds, not O(N)', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const C = await TestDevice.create('dev-c');
    const D = await TestDevice.create('dev-d');

    // A seeds N files; B, C, D all sync to a shared base (same create op-ids).
    const N = 20;
    for (let i = 0; i < N; i++) await A.seedFile(`f${i}.md`, `base\nx${i}\n`, 1000 + i);
    await client(api, A).runSync();
    await client(api, B).runSync();
    await client(api, C).runSync();
    await client(api, D).runSync();

    // B and C edit DIFFERENT lines of EVERY file (clean 3-way) concurrently, each pushing
    // its raw edit WITHOUT merging — so the server holds two concurrent heads per file.
    for (let i = 0; i < N; i++) await B.editFile(`f${i}.md`, `B-edit\nx${i}\n`, 2000 + i);
    await client(api, B).runSync();
    for (let i = 0; i < N; i++) await C.editFile(`f${i}.md`, `base\nC-edit${i}\n`, 3000 + i);
    await client(api, C).runSync();

    // D pulls BOTH heads for all N files in one round → N stranded leaves to fold.
    const spy = spyBuildIdentity(D);
    await client(api, D).runSync();
    await client(api, D).runSync(); // a settling round for any residual

    const builds = spy.count();
    // Convergence: every file reflects BOTH edits.
    for (let i = 0; i < N; i++) {
      expect(await onDisk(D, `f${i}.md`)).toBe(`B-edit\nC-edit${i}\n`);
    }
    // The point of the test: whole-vault rebuilds are bounded by the number of PASSES
    // (a couple of runSync rounds × one reconcile pass each, since every file has exactly
    // one extra leaf), NOT by N folds. Pre-fix this was ≈ N per reconciling round (one
    // buildLocalIdentity per fold, the ~9s first-sync lap); post-fix it is a small
    // constant independent of N.
    expect(builds).toBeLessThanOrEqual(6);
  });

  // The precheck cliff: a first sync that pulls a peer op for each of thousands of files,
  // NONE of them multi-head, must not call the per-file `leaves()` (which rebuilds the
  // whole child-set every call → O(files × nodes) ≈ O(vault²), a measured ~30s at ~16.8k
  // touched files). The single-pass `leavesByFile()` replaced it, so `leaves()` is not
  // invoked at all on this path.
  test('a whole-vault pull of single-leaf files does NOT scan leaves() per file', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const D = await TestDevice.create('dev-d');

    // A seeds N files (each its own single-leaf create) and pushes. D holds none of them.
    const N = 30;
    for (let i = 0; i < N; i++) await A.seedFile(`p${i}.md`, `body ${i}\n`, 1000 + i);
    await client(api, A).runSync();

    // D pulls all N as peer ops → `touched` = N, every file has exactly ONE leaf, so the
    // reconcile precheck must find zero multi-head files WITHOUT a per-file leaves() scan.
    const perFileLeaves = { n: 0 };
    const origLeaves = VersionDag.prototype.leaves;
    VersionDag.prototype.leaves = function (this: VersionDag, fileId: string): string[] {
      perFileLeaves.n++;
      return origLeaves.call(this, fileId);
    };
    try {
      await client(api, D).runSync();
    } finally {
      VersionDag.prototype.leaves = origLeaves;
    }

    // The files landed (data correctness) …
    for (let i = 0; i < N; i++) expect(await onDisk(D, `p${i}.md`)).toBe(`body ${i}\n`);
    // … and the O(N²) per-file leaves() scan is gone: it is not called on this path.
    expect(perFileLeaves.n).toBe(0);
  });
});
