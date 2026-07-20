// ─────────────────────────────────────────────
//  Regression: concurrent BINARY edits must not silently lose data (audit E)
// ─────────────────────────────────────────────
//
//  Binary files (images, PDFs, attachments) can't be three-way merged. The bug:
//  when two devices edited the same binary file concurrently, the merge fell back
//  to "higher HLC wins" and silently overwrote the losing side — no prompt, one
//  version gone from disk (recoverable only from the oplog). That violates the
//  data-safety invariant "no silent overwrite of divergent content", which the
//  text path already honours.
//
//  Fix: surface a `binary_conflict` action (the user picks which whole version to
//  keep), reusing the same `supersedes` machinery as text/delete conflicts so a
//  peer holding either side adopts the decision without re-prompting. Crucially,
//  when only ONE side changed since the common ancestor there is no real conflict
//  — that side is adopted cleanly, so we don't spuriously prompt.
//
//  Driven through the REAL device stack (registry, content store, op logger,
//  applicator, host) over in-memory fakes via `TestDevice` + `FakeSyncServer`.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 6]);

// PNG-ish blobs, each with a null byte so the merge's binary sniff trips.
const v0 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
const v1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]); // A's edit
const v2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08]); // B's edit

describe('concurrent binary edits (audit E)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const bytesOnDisk = async (d: TestDevice, path: string): Promise<number[] | null> => {
    const b = await d.files.read(path);
    return b ? Array.from(b) : null;
  };

  test('a concurrent binary edit surfaces a conflict, is not silently overwritten, and converges', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'assets/diagram.png';

    // A creates the binary, syncs; B syncs and receives it → both share ancestor v0.
    await A.seedBinary(path, v0, 1000);
    await client(A).runSync();
    await client(B).runSync();
    expect(await bytesOnDisk(B, path)).toEqual(Array.from(v0));

    // Concurrent binary edits: A → v1, B → v2.
    await A.editBinary(path, v1, 2000);
    await B.editBinary(path, v2, 3000);

    // A syncs first (pushes v1; no remote changes yet, so nothing to merge).
    await client(A).runSync();

    // B syncs: it now sees A's v1 vs its own v2 — a genuine binary conflict. B's
    // user keeps its own version (v2). Scope the assertion to this round (B's
    // round-1 receipt of the file was a legitimate write_local).
    B.resolveBinaryConflict = () => 'keep_local';
    const beforeB = B.applied.length;
    await client(B).runSync();
    const bActions = B.applied.slice(beforeB).map(a => a.type);

    expect(bActions).toContain('binary_conflict');            // surfaced…
    expect(bActions).not.toContain('write_local');            // …not a silent overwrite
    expect(await bytesOnDisk(B, path)).toEqual(Array.from(v2)); // B kept its choice

    // The resolution is re-emitted as a pending op; B syncs again to push it
    // (supersedes both sides), the same way text/delete resolutions propagate.
    await client(B).runSync();

    // A syncs, pulling B's resolution. It supersedes A's own side, so A adopts it
    // via the `supersedes` shortcut WITHOUT re-prompting (no binary_conflict), and
    // both devices converge on the chosen version.
    const beforeA = A.applied.length;
    await client(A).runSync();
    const aActions = A.applied.slice(beforeA).map(a => a.type);
    expect(aActions).not.toContain('binary_conflict');        // A never re-prompted
    expect(await bytesOnDisk(A, path)).toEqual(Array.from(v2));
    expect(await bytesOnDisk(A, path)).toEqual(await bytesOnDisk(B, path)); // converged
  });

  test('a one-sided binary edit is adopted cleanly (no spurious conflict prompt)', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'assets/photo.png';

    await A.seedBinary(path, v0, 1000);
    await client(A).runSync();
    await client(B).runSync();

    // Only A edits the binary; B leaves it untouched since the common ancestor.
    await A.editBinary(path, v1, 2000);
    await client(A).runSync();
    await client(B).runSync();

    // B adopts A's version cleanly — no conflict, nothing for the user to resolve.
    expect(B.applied.some(a => a.type === 'binary_conflict')).toBe(false);
    expect(await bytesOnDisk(B, path)).toEqual(Array.from(v1));
  });
});
