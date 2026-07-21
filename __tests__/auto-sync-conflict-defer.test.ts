// ─────────────────────────────────────────────
//  S5: an unattended auto-sync must DEFER conflicts, not consume them
// ─────────────────────────────────────────────
//
//  A background auto-sync used to run the full round including the conflict modal:
//  it could pop a blocking dialog the user never initiated, and dismissing it
//  (Escape → skip) silently advanced the cursor PAST the conflict, so a normal
//  sync would never present it again — the two devices stayed divergent forever.
//
//  The fix routes an auto round's conflict decision to a DEFER: the applicator
//  applies nothing and adds the fileId to its `deferred` set, so `runSync`'s
//  existing F5 cursor-hold caps the cursor at the round's start and the conflict
//  re-presents next round. main.ts's auto closure returns `DEFER_CONFLICT` (and
//  records the conflict as outstanding); a MANUAL skip still returns `null` and
//  behaves exactly as before (cursor advances — a deliberate choice). This drives
//  the real applicator/round; the resolver stands in for that closure's decision.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { DEFER_CONFLICT } from '../src/network/sync-applicator';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 4, 4, 4, 4, 4, 4, 4, 4]);

describe('auto-sync defers conflicts instead of consuming them (S5)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const onDisk = async (d: TestDevice, path = 'note.md'): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  /** Drive A and B to the point where A has a pending, un-pushed conflicting edit
   *  and B's conflicting edit is already on the server — so A's next sync conflicts. */
  async function setupConflict(api: FakeSyncServer) {
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', '1\n2\n3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    // Concurrent edits to the same line. B pushes first, so its edit sits on the
    // server; A's edit stays local and will conflict on A's next pull.
    await A.editFile('note.md', '1\nAAA\n3\n', 2000);
    await B.editFile('note.md', '1\nBBB\n3\n', 3000);
    await client(B).runSync();

    return { A, B, client };
  }

  test('an auto round defers the conflict: nothing applied, cursor held, re-presents next round', async () => {
    const api = new FakeSyncServer();
    const { A, B, client } = await setupConflict(api);

    // ── AUTO round: the closure defers (DEFER_CONFLICT) rather than prompting. ──
    let deferCalls = 0;
    A.resolveConflict = () => { deferCalls++; return DEFER_CONFLICT; };

    const cursorBefore = await A.cursor();
    await client(A).runSync();

    // The conflict was surfaced by the real merge, and the applicator deferred it.
    expect(A.applied.some(a => a.type === 'conflict')).toBe(true);
    expect(deferCalls).toBe(1);
    // Nothing was applied — A keeps its own edit untouched.
    expect(await onDisk(A)).toBe('1\nAAA\n3\n');
    // Cursor HELD at the round's start (F5 semantics) — B's remote edit was NOT
    // consumed, so a later round re-pulls and re-merges it.
    expect(await A.cursor()).toBe(cursorBefore);

    // ── A subsequent MANUAL round DOES present the same conflict and resolves it. ──
    const RESOLVED = '1\nRESOLVED\n3\n';
    let interactiveCalls = 0;
    A.resolveConflict = () => { interactiveCalls++; return new TextEncoder().encode(RESOLVED); };

    await client(A).runSync();
    expect(interactiveCalls).toBe(1);              // the deferred conflict came back
    expect(await onDisk(A)).toBe(RESOLVED);

    // A pushes the resolution; B pulls it and converges (no re-prompt).
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B)).toBe(RESOLVED);
    expect(await onDisk(A)).toBe(await onDisk(B));
  });

  test('MANUAL skip is unchanged: cursor advances and the conflict is consumed', async () => {
    const api = new FakeSyncServer();
    const { A, client } = await setupConflict(api);

    // A manual "Skip for now" returns null (NOT DEFER_CONFLICT).
    A.resolveConflict = () => null;

    const cursorBefore = await A.cursor();
    await client(A).runSync();

    expect(A.applied.some(a => a.type === 'conflict')).toBe(true);
    // Skipping keeps A's local version…
    expect(await onDisk(A)).toBe('1\nAAA\n3\n');
    // …but the cursor ADVANCES past B's edit — the deliberate manual-skip
    // behaviour S5 must not change (the skip is instead surfaced as outstanding
    // via the sync-state, and re-openable with "Re-check for conflicts").
    expect(await A.cursor()).toBeGreaterThan(cursorBefore);

    // A normal follow-up round does NOT re-present it (it was consumed).
    let calls = 0;
    A.resolveConflict = () => { calls++; return null; };
    await client(A).runSync();
    expect(calls).toBe(0);
  });
});
