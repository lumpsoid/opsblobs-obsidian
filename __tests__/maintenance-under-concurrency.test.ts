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
//  Note on sync-state: TestDevice wires the SyncApplicator directly (its resolver
//  callbacks stand in for the modal), so it does NOT route through SyncCoordinator
//  and has no SyncStateStore. The "record an outstanding conflict" bookkeeping is
//  unit-tested at the coordinator level (sync-coordinator.test.ts); here we assert
//  the load-bearing *sync* behaviour that bookkeeping rides on — what content each
//  device ends up with, whether a conflict was raised, and whether the cursor was
//  held or advanced.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { DEFER_CONFLICT } from '../src/network/sync-applicator';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);
const enc = (s: string) => new TextEncoder().encode(s);

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
  test('a skipped conflict is consumed, and Re-check (cursor rewind) re-surfaces and resolves it', async () => {
    const api = new FakeSyncServer();
    const [A, B, id] = await sharedBase(api, 'note.md', 'shared\n');

    // Concurrent edits to the SAME line — a genuine three-way conflict.
    await A.editFile('note.md', 'AAA\n', 2000);
    await B.editFile('note.md', 'BBB\n', 2000);

    await client(api, A).runSync();          // A pushes its edit
    const bSeqBeforeSkip = await B.cursor();

    // B pulls A's edit, hits the conflict, and SKIPS it (the "Skip for now" path).
    B.resolveConflict = () => null;
    await client(api, B).runSync();

    // Skip keeps B's own version (nothing lost locally) but CONSUMES the conflict:
    // the cursor advances past A's op, so a normal sync would never re-present it.
    expect(await text(B, 'note.md')).toBe('BBB\n');
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);
    expect(await B.cursor()).toBeGreaterThan(bSeqBeforeSkip);

    // ── "Re-check for conflicts": main.ts rewinds the pull cursor to 0 so the
    //    whole server log is replayed and the skipped conflict is recomputed. ──
    await B.cursorStore.save(0);
    const R = 'AAA\nBBB\n';
    B.resolveConflict = () => enc(R);
    const conflictsBefore = B.applied.filter(a => a.type === 'conflict').length;
    await client(api, B).runSync();          // re-pull → conflict re-surfaces → resolve

    // The conflict came back and B resolved it into a queued resolution op.
    expect(B.applied.filter(a => a.type === 'conflict').length).toBeGreaterThan(conflictsBefore);
    expect(await text(B, 'note.md')).toBe(R);
    expect(B.pendingOps).toHaveLength(1);    // the resolution, awaiting next round

    // Settle: B pushes the resolution; A pulls it and adopts via `supersedes`.
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
    // conflict rather than letting the baseline overwrite B's work. B's edit is
    // never silently dropped.
    B.resolveConflict = a => enc(`${a.remoteContent.trim()}\n${a.localContent.trim()}\n`);
    await client(api, B).runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);

    // Resolve + settle; both devices converge and B's line survives in the result.
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
  test('multi-device auto-defer: both hold the conflict, then one manual resolution converges all', async () => {
    const api = new FakeSyncServer();
    const [A, B, id] = await sharedBase(api, 'note.md', 'shared\n');

    await A.editFile('note.md', 'A-edit\n', 2000);
    await B.editFile('note.md', 'B-edit\n', 2000);

    // BOTH devices are on unattended auto-sync — a conflict must never block on a
    // modal, so their resolver defers (holds the cursor) instead of deciding.
    A.resolveConflict = () => DEFER_CONFLICT;
    B.resolveConflict = () => DEFER_CONFLICT;

    await client(api, A).runSync();          // A pushes A-edit (no conflict yet)
    const bCursorBefore = await B.cursor();

    await client(api, B).runSync();          // B: push B-edit, pull A-edit → DEFER
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true);
    expect(await text(B, 'note.md')).toBe('B-edit\n');      // nothing applied
    expect(await B.cursor()).toBe(bCursorBefore);           // cursor HELD (not consumed)

    await client(api, A).runSync();          // A: pull B-edit → DEFER too
    expect(await text(A, 'note.md')).toBe('A-edit\n');

    // One device switches to a human resolution (manual sync); the other stays auto.
    const R = 'A-edit\nB-edit\n';
    A.resolveConflict = () => enc(R);
    await client(api, A).runSync();          // A resolves → queues resolution
    await client(api, A).runSync();          // push resolution

    // B is STILL on auto (would defer a fresh conflict) — but the incoming op is a
    // resolution that supersedes both sides, so it is adopted cleanly with no
    // conflict to defer. Auto devices converge without ever needing a modal.
    await client(api, B).runSync();
    await client(api, B).runSync();
    await client(api, A).runSync();

    expect(await text(A, 'note.md')).toBe(R);
    expect(await text(B, 'note.md')).toBe(R);
    expect(A.entry(id)!.contentHash).toBe(B.entry(id)!.contentHash);
  });
});
