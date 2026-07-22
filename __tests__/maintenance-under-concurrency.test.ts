// ─────────────────────────────────────────────
// Sync scenarios — maintenance operations under a concurrent peer
// ─────────────────────────────────────────────
//
//  Covers the recovery/maintenance paths (spec Part 2 G14–G16) when a SECOND
//  device is editing at the same time — the case where "did anything get lost?"
//  actually matters. Driven through the real device stack (TestDevice) against
//  the in-memory FakeSyncServer, so the genuine mergeVaultStates / applicator /
//  cursor logic runs, not a look-alike.
//
//  Sync v2 Step 5: a text conflict is surfaced as inline zdiff3 markers at the real
//  path (non-blocking, no modal). The file becomes "two-headed" until the user edits
//  the markers away and saves — that save re-emits a two-parent merge node peers
//  fast-forward onto. These tests assert the load-bearing behaviour that rides on
//  that: what content each device ends up with, that an unresolved conflict never
//  re-conflicts / nests markers, and that convergence is reported.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { hasConflictMarkers } from '../src/merge/diff3';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

const text = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<absent>';
};

describe('maintenance operations with a concurrent peer', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  /** A & B both hold `path` at `body`, ancestor established on both sides. */
  async function sharedBase(api: FakeSyncServer, path: string, body: string): Promise<[TestDevice, TestDevice, string]> {
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const id = await A.seedFile(path, body, 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();
    expect(await text(B, path)).toBe(body);
    return [A, B, id];
  }

  // ── G14 ───────────────────────────────────────────────────────────────────
  test('an unresolved conflict stays two-headed without nesting markers; a save resolves it', async () => {
    const api = new FakeSyncServer();
    const [A, B, id] = await sharedBase(api, 'note.md', 'shared\n');

    // Concurrent edits to the SAME line — a genuine three-way conflict.
    await A.editFile('note.md', 'AAA\n', 2000);
    await B.editFile('note.md', 'BBB\n', 2000);

    await client(api, A).runSync();          // A pushes its edit
    // B pulls A's edit, hits the conflict → inline markers, becomes two-headed.
    await client(api, B).runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);
    const marked = await text(B, 'note.md');
    expect(hasConflictMarkers(marked)).toBe(true);
    expect(B.entryByPath('note.md')!.conflictParents?.length).toBe(2);

    // ── Idempotency: while still two-headed, re-pulling A's edit (as a cursor
    //    rewind / "Re-check" would) must NOT re-conflict or nest the markers. ──
    await B.cursorStore.save(0);
    const conflictsBefore = B.applied.filter(a => a.type === 'conflict').length;
    await client(api, B).runSync();
    expect(B.applied.filter(a => a.type === 'conflict').length).toBe(conflictsBefore); // no new conflict
    expect(await text(B, 'note.md')).toBe(marked);                       // markers intact, not nested
    expect(B.entryByPath('note.md')!.conflictParents?.length).toBe(2);   // still two-headed

    // ── B's user resolves by editing the markers away; the save re-emits a merge
    //    node (parents = the two conflicting heads), queued for the next round. ──
    const R = 'AAA\nBBB\n';
    await B.editFile('note.md', R, 3000);
    expect(B.entryByPath('note.md')!.conflictParents == null).toBe(true);
    expect(B.pendingOps).toHaveLength(1);
    expect(await text(B, 'note.md')).toBe(R);

    // Settle: B pushes the resolution; A adopts it by fast-forward.
    await client(api, B).runSync();          // push resolution
    await client(api, A).runSync();          // A: pull → adopt R
    await client(api, B).runSync();          // no-op
    await client(api, A).runSync();          // no-op

    expect(await text(A, 'note.md')).toBe(R);
    expect(await text(B, 'note.md')).toBe(R);
    expect(A.entry(id)!.contentHash).toBe(B.entry(id)!.contentHash);
    expect(A.pendingOps).toHaveLength(0);
    expect(B.pendingOps).toHaveLength(0);
  });

  // ── G15 ───────────────────────────────────────────────────────────────────
  test('re-baseline (S4) does not silently clobber a peer\'s concurrent, un-synced edit', async () => {
    const api = new FakeSyncServer();
    const [A, B] = await sharedBase(api, 'note.md', 'base\n');

    // B edits locally but has NOT synced — a pending, un-pushed change.
    await B.editFile('note.md', 'B-line\n', 2000);
    expect(B.pendingOps.length).toBeGreaterThan(0);

    // A edits the SAME line, then re-baselines (declares itself authoritative) and
    // pushes: captureAllAsBaseline re-emits an op for every live file.
    await A.editFile('note.md', 'A-line\n', 2500);
    await A.opLogger.captureAllAsBaseline();
    await client(api, A).runSync();

    // B syncs: it pushes its own edit, pulls A's authoritative version, and — since
    // both changed the same line since the common ancestor — the merge SURFACES a
    // conflict (inline markers) rather than letting the baseline overwrite B's work.
    await client(api, B).runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);
    const marked = await text(B, 'note.md');
    expect(marked).toContain('A-line');      // both sides preserved in the markers
    expect(marked).toContain('B-line');

    // B's user resolves to the union; then settle — both converge, B's line survives.
    await B.editFile('note.md', 'A-line\nB-line\n', 3000);
    await client(api, B).runSync();          // push resolution
    await client(api, A).runSync();          // A adopts it
    await client(api, B).runSync();
    await client(api, A).runSync();

    const finalA = await text(A, 'note.md');
    const finalB = await text(B, 'note.md');
    expect(finalA).toBe(finalB);
    expect(finalB).toContain('B-line');      // the peer's concurrent edit was preserved
    expect(finalB).toContain('A-line');
  });

  // ── G16 ───────────────────────────────────────────────────────────────────
  test('multi-device: both surface the conflict non-blockingly, one resolution converges all', async () => {
    const api = new FakeSyncServer();
    const [A, B, id] = await sharedBase(api, 'note.md', 'shared\n');

    await A.editFile('note.md', 'A-edit\n', 2000);
    await B.editFile('note.md', 'B-edit\n', 2000);

    await client(api, A).runSync();          // A pushes A-edit (no conflict yet)

    // A conflict must never block on a modal: both devices surface inline markers
    // and stay two-headed, non-blocking, until a human resolves on either side.
    await client(api, B).runSync();          // B: push B-edit, pull A-edit → markers
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);
    expect(hasConflictMarkers(await text(B, 'note.md'))).toBe(true);
    expect(B.entryByPath('note.md')!.conflictParents?.length).toBe(2);

    await client(api, A).runSync();          // A: pull B-edit → markers too
    expect(A.applied.some(a => a.type === 'conflict')).toBe(true);
    expect(A.entryByPath('note.md')!.conflictParents?.length).toBe(2);

    // A's user resolves; B (still two-headed) adopts A's resolution automatically via
    // the two-headed fast-forward — converging without ever needing its own decision.
    const R = 'A-edit\nB-edit\n';
    await A.editFile('note.md', R, 3000);
    await client(api, A).runSync();          // push resolution
    await client(api, B).runSync();          // B adopts A's resolution
    await client(api, A).runSync();

    expect(await text(A, 'note.md')).toBe(R);
    expect(await text(B, 'note.md')).toBe(R);
    expect(B.entryByPath('note.md')!.conflictParents == null).toBe(true);
    expect(A.entry(id)!.contentHash).toBe(B.entry(id)!.contentHash);
  });

  // ── Auto-adopt reports convergence (the stuck-badge bug) ────────────────────
  // A conflict can resolve without the resolving device ever re-entering a handler:
  // a peer's resolution merge node is adopted by a clean write_local. TestDevice has
  // no SyncStateStore, so we assert the signal the coordinator needs: the round's
  // SyncRoundSummary.converged must include the file on the adopt round (so the plugin
  // clears the badge) and must NOT include it on the round that only wrote markers.
  test('a conflict that resolves automatically is reported in summary.converged', async () => {
    const api = new FakeSyncServer();
    const [A, B, id] = await sharedBase(api, 'note.md', 'shared\n');

    await A.editFile('note.md', 'AAA\n', 2000);
    await B.editFile('note.md', 'BBB\n', 2000);

    await client(api, A).runSync();            // A pushes AAA

    // B pulls A's edit → conflict surfaced as markers. This round settles nothing for
    // the file (it is open, awaiting resolution), so it must NOT report converged.
    const markersRound = await client(api, B).runSync();
    expect(hasConflictMarkers(await text(B, 'note.md'))).toBe(true);
    expect(markersRound.converged).not.toContain(id);
    expect(B.applied.filter(a => a.type === 'conflict')).toHaveLength(1);

    // B resolves and pushes; A adopts it automatically (a write_local, no conflict).
    // THIS round must report the file as converged — what lets the plugin clear the
    // stale outstanding badge for a file that later resolved on its own.
    await B.editFile('note.md', 'AAA\nBBB\n', 3000);
    await client(api, B).runSync();            // push resolution
    const adoptRound = await client(api, A).runSync();
    expect(await text(A, 'note.md')).toBe('AAA\nBBB\n');   // converged to the resolution
    expect(A.applied.filter(a => a.type === 'conflict')).toHaveLength(0); // A never conflicted
    expect(adoptRound.converged).toContain(id);
  });
});
