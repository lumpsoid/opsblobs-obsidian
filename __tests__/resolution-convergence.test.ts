// ─────────────────────────────────────────────
//  Regression: a user-resolved conflict must not re-prompt the other device
// ─────────────────────────────────────────────
//
//  Reported behaviour: two devices edit the same lines concurrently. One device
//  syncs, gets the conflict, and the user resolves it. When the OTHER device
//  syncs it was prompted to resolve the *same* conflict again — even though a
//  human already settled it. Worse, a different second choice re-diverges them.
//
//  Root cause: the resolution replicated as a plain `update` op, indistinguishable
//  from a fresh concurrent edit. The second device's merge base was still the
//  pre-conflict ancestor, so `threeWayMerge(oldBase, itsEdit, resolvedContent)`
//  re-detected the conflict.
//
//  Fix: the resolution op carries `supersedes` — the content hashes of the two
//  sides the human chose between. A device still holding either side adopts the
//  resolution wholesale (write_local) instead of re-merging. This drives the real
//  ServerSyncClient round against the fake server and asserts the second device
//  converges silently.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerApi, ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { HybridLogicalClock } from '../src/core/hlc';
import { FakeSyncServer } from '../src/network/fake-server';
import { MemoryHost, seedFile, editFile } from './helpers/memory-host';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('resolved conflict converges without re-prompting the peer', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const onDisk = (h: MemoryHost, fileId = 'f1'): string => {
    const bytes = h.disk.get(fileId);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('B resolves; A adopts the resolution silently and both converge', async () => {
    const api: ServerApi = new FakeSyncServer();
    const client = (host: MemoryHost, deviceId: string) =>
      new ServerSyncClient({ api, crypto: vc, host, hlc: new HybridLogicalClock(deviceId) });

    const A = new MemoryHost('dev-a');
    const B = new MemoryHost('dev-b');

    const RESOLVED = 'RESOLVED\n';
    // B is the device whose user resolves the conflict.
    B.resolveConflict = () => new TextEncoder().encode(RESOLVED);

    // ── A creates the file and syncs; B receives it exactly. ─────────────────
    const base = await seedFile(A, 'dev-a', 'f1', 'note.md', '1\n2\n3\n', 1000);
    await client(A, 'dev-a').runSync();
    A.fileEntries.get('f1')!.ancestorContentHash = base.hash; // mirror first-sync ancestor
    await client(B, 'dev-b').runSync();
    expect(onDisk(B)).toBe('1\n2\n3\n');

    // ── A edits line 2 and syncs FIRST (no conflict — B hasn't pushed yet). ──
    await editFile(A, 'dev-a', 'f1', 'note.md', '1\nAAA\n3\n', 2000);
    await client(A, 'dev-a').runSync();
    expect(A.applied.some(a => a.type === 'conflict')).toBe(false);

    // ── B edits the SAME line, syncs, hits the conflict, resolves it. ────────
    await editFile(B, 'dev-b', 'f1', 'note.md', '1\nBBB\n3\n', 3000);
    await client(B, 'dev-b').runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true); // B was prompted (correct)
    expect(onDisk(B)).toBe(RESOLVED);                              // and resolved

    // The resolution is recorded as a pending op for the *next* round, so B must
    // sync once more to push it to the server before any peer can see it.
    await client(B, 'dev-b').runSync();

    // ── A syncs again, pulling B's resolution. It must NOT re-prompt: A still
    //    holds "1\nAAA\n3\n", one of the two sides the resolution superseded, so
    //    A adopts the resolution cleanly. ─────────────────────────────────────
    const before = A.applied.length;
    await client(A, 'dev-a').runSync();
    const aNew = A.applied.slice(before).map(a => a.type);

    expect(aNew).not.toContain('conflict');   // ← the bug: A used to be re-prompted here
    expect(aNew).toContain('write_local');    // A adopts the resolution
    expect(onDisk(A)).toBe(RESOLVED);         // both devices now hold the resolved content
    expect(onDisk(A)).toBe(onDisk(B));        // converged
  });

  test('a third device that only ever saw the base also adopts the resolution', async () => {
    const api: ServerApi = new FakeSyncServer();
    const client = (host: MemoryHost, deviceId: string) =>
      new ServerSyncClient({ api, crypto: vc, host, hlc: new HybridLogicalClock(deviceId) });

    const A = new MemoryHost('dev-a');
    const B = new MemoryHost('dev-b');
    const C = new MemoryHost('dev-c');
    B.resolveConflict = () => new TextEncoder().encode('RESOLVED\n');

    const base = await seedFile(A, 'dev-a', 'f1', 'note.md', '1\n2\n3\n', 1000);
    await client(A, 'dev-a').runSync();
    A.fileEntries.get('f1')!.ancestorContentHash = base.hash;
    await client(B, 'dev-b').runSync();
    await client(C, 'dev-c').runSync();      // C also holds the base, unchanged
    expect(onDisk(C)).toBe('1\n2\n3\n');

    await editFile(A, 'dev-a', 'f1', 'note.md', '1\nAAA\n3\n', 2000);
    await client(A, 'dev-a').runSync();
    await editFile(B, 'dev-b', 'f1', 'note.md', '1\nBBB\n3\n', 3000);
    await client(B, 'dev-b').runSync();      // B resolves
    await client(B, 'dev-b').runSync();      // and pushes the resolution op

    // C never edited — a clean write_local of the winning content, no prompt.
    await client(C, 'dev-c').runSync();
    expect(C.applied.some(a => a.type === 'conflict')).toBe(false);
    expect(onDisk(C)).toBe('RESOLVED\n');
  });
});
