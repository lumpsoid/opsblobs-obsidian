// ─────────────────────────────────────────────
//  Sync v2 — concurrent edits to IDENTICAL content still converge the heads
// ─────────────────────────────────────────────
//
//  Regression for a real two-vault bug: identical content does not imply causal
//  convergence. When two devices independently edit a file to the SAME bytes (the
//  canonical case: both empty it), the old "same content → no_op" shortcut left
//  BOTH heads open in the DAG. A later edit off one head then diverged from the
//  orphaned other, and the LCA rolled back *past* the shared value — resurrecting it
//  as a spurious three-way conflict base.
//
//  Repro (exactly the reported story):
//    · shared "1"
//    · A empties, syncs   · B empties, syncs   → converge to empty, NO conflict
//    · A edits empty → "341", syncs
//    · B syncs            → must get "341" cleanly, NO conflict
//
//  Drives the genuine ServerSyncClient round against the fake server.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([1, 1, 2, 3, 5, 8, 13, 21, 1, 1, 2, 3, 5, 8, 13, 21]);

const onDisk = async (d: TestDevice, path = 'my.md'): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

describe('concurrent identical edits converge the DAG heads (no resurrected base)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('both empty a file concurrently, then one edits → peer gets the edit, no conflict', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // ── Shared base "1". ──────────────────────────────────────────────────────
    await A.seedFile('my.md', '1', 1000);
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B)).toBe('1');

    // ── Both devices empty the file CONCURRENTLY (identical resulting bytes). ──
    await A.editFile('my.md', '', 2000);
    await client(A).runSync();               // A pushes its empty

    await B.editFile('my.md', '', 3000);     // B empties before pulling A's empty
    await client(B).runSync();               // B pulls A's empty → converge

    // Convergence, NOT a conflict: identical content, but two divergent heads →
    // the merge must UNITE them into a merge node (else the divergence stays open).
    expect(B.applied.some(a => a.type === 'conflict')).toBe(false);
    expect(await onDisk(B)).toBe('');
    const bHead = B.entryByPath('my.md')!.headVersionId!;
    expect(bHead.startsWith('m-')).toBe(true);          // heads were united by a merge node
    expect(B.applied.some(a => a.type === 'write_merge')).toBe(true);

    // A pulls B's merge node and fast-forwards onto it (same content-addressed id).
    await client(A).runSync();
    expect(A.entryByPath('my.md')!.headVersionId).toBe(bHead);
    expect(A.applied.some(a => a.type === 'conflict')).toBe(false);

    // ── A now edits the (converged) empty file to "341" and syncs. ────────────
    await A.editFile('my.md', '341', 4000);
    await client(A).runSync();

    // ── B syncs: must adopt "341" cleanly. The pre-fix bug surfaced a conflict
    //    here because the LCA rolled back to the old "1" base. ─────────────────
    await client(B).runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(false);
    expect(B.entryByPath('my.md')!.conflictParents ?? []).toEqual([]);
    expect(await onDisk(B)).toBe('341');

    // And they stay converged.
    await client(A).runSync();
    expect(await onDisk(A)).toBe('341');
  });
});
