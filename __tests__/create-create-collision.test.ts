// ─────────────────────────────────────────────
//  Regression (F2): create/create path collision must not silently clobber
// ─────────────────────────────────────────────
//
//  Two devices independently create a file at the SAME path → they mint
//  *different* UUIDs for it. The state merge is id-keyed, so each device sees the
//  other's file as "remote-only" and (pre-fix) unconditionally `write_local`s it
//  over the local file and `adoptRemote`s the remote id — dropping the colliding
//  local entry with NO conflict. Whichever device syncs last wins; the other
//  side's working content is silently replaced.
//
//  With the fix: a create/create collision between *different* content surfaces a
//  `conflict` (three-way with no common ancestor), the surviving identity is
//  chosen deterministically (higher HLC, tie-break by fileId) so both devices
//  converge to ONE id, and neither original is discarded before the user chose.
//  Identical content at the same path converges to one id with NO conflict.
//
//  Drives the REAL device stack (registry, content store, op logger, applicator,
//  host) over the in-memory fakes via TestDevice + FakeSyncServer.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

describe('create/create path collision (F2)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const onDisk = async (d: TestDevice, path: string): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('different content at the same path surfaces a conflict and converges to one id', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'note.md';

    // ── A and B independently create `note.md` with different content. Each
    //    device mints its own UUID for the path. ─────────────────────────────
    const idA = await A.seedFile(path, 'AAA\n', 1000);
    const idB = await B.seedFile(path, 'BBB\n', 2000); // B's HLC is higher → wins id
    expect(idA).not.toBe(idB);

    // B does the human merge (unions both sides); A adopts whatever resolution
    // reaches it (via the resolution's `supersedes`, without re-prompting).
    const R = 'AAA\nBBB\n';
    B.resolveConflict = () => new TextEncoder().encode(R);
    A.resolveConflict = a => new TextEncoder().encode(a.remoteContent);

    // ── A syncs (pushes its create); B syncs (pulls A's create, pushes its own,
    //    and hits the create/create collision). ─────────────────────────────
    await client(A).runSync();
    await client(B).runSync();

    // A conflict is surfaced on B — NOT a silent write_local clobber of B's bytes.
    expect(B.applied.some(x => x.type === 'conflict')).toBe(true);
    // B kept both contents through the conflict: it never silently became 'AAA'.
    expect(await onDisk(B, path)).toBe(R);

    // ── B pushes its resolution; A pulls it and adopts the winning identity. ──
    await client(B).runSync();
    await client(A).runSync();

    // Both devices converge to the SAME content and the SAME id.
    expect(await onDisk(A, path)).toBe(R);
    expect(await onDisk(B, path)).toBe(R);

    const aEntry = A.entryByPath(path)!;
    const bEntry = B.entryByPath(path)!;
    expect(aEntry.id).toBe(bEntry.id);
    expect(aEntry.id).toBe(idB); // higher-HLC identity is the deterministic winner
    expect(aEntry.contentHash).toBe(bEntry.contentHash);

    // The losing identity is gone (A dropped idA when it adopted idB).
    const stale = A.entry(idA);
    expect(stale === undefined || stale.deleted).toBe(true);

    // Neither original content was fabricated away: both AAA and BBB are present
    // in the resolution, which is the union both devices now hold.
    expect(await onDisk(A, path)).toContain('AAA');
    expect(await onDisk(A, path)).toContain('BBB');
  });

  test('identical content at the same path converges to one id with NO conflict', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const path = 'same.md';

    const idA = await A.seedFile(path, 'identical\n', 1000);
    const idB = await B.seedFile(path, 'identical\n', 2000);
    expect(idA).not.toBe(idB);

    await client(A).runSync();
    await client(B).runSync();
    await client(A).runSync();

    // No conflict is ever surfaced — same bytes are the same file.
    expect(A.applied.some(x => x.type === 'conflict')).toBe(false);
    expect(B.applied.some(x => x.type === 'conflict')).toBe(false);

    // Both converge to one id (the higher-HLC winner) with the shared content.
    expect(await onDisk(A, path)).toBe('identical\n');
    expect(await onDisk(B, path)).toBe('identical\n');
    const aEntry = A.entryByPath(path)!;
    const bEntry = B.entryByPath(path)!;
    expect(aEntry.id).toBe(bEntry.id);
    expect(aEntry.id).toBe(idB);
    const stale = A.entry(idA);
    expect(stale === undefined || stale.deleted).toBe(true);
  });
});
