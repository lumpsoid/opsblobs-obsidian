// ─────────────────────────────────────────────
//  S5: an unattended auto-sync must DEFER choice-based conflicts, not consume them
// ─────────────────────────────────────────────
//
//  A background auto-sync used to run the full round including a blocking conflict
//  modal: it could pop a dialog the user never initiated, and dismissing it silently
//  advanced the cursor PAST the conflict, so a normal sync would never present it
//  again — the two devices stayed divergent forever.
//
//  The fix routes an auto round's *choice-based* conflict decision (delete/modify,
//  binary) to a DEFER: the applicator applies nothing and adds the fileId to its
//  `deferred` set, so `runSync`'s existing F5 cursor-hold caps the cursor at the
//  round's start and the conflict re-presents next round. main.ts's auto closure
//  returns `DEFER_CONFLICT`; a MANUAL round makes the real decision. This drives the
//  real applicator/round; the resolver stands in for that closure's decision.
//
//  NB (sync v2 Step 5): a *text* conflict no longer defers or blocks at all — it is
//  surfaced non-blockingly as inline markers, resolved by the next ordinary save.
//  Only the inherently choice-based delete/binary conflicts still defer, so this
//  test exercises S5 through a delete/modify conflict.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { DEFER_CONFLICT } from '../src/network/sync-applicator';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 4, 4, 4, 4, 4, 4, 4, 4]);

describe('auto-sync defers choice-based conflicts instead of consuming them (S5)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const onDisk = async (d: TestDevice, path = 'note.md'): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  /** Drive A and B to a delete/modify conflict on A's next pull: A has a pending,
   *  un-pushed EDIT while B's DELETE of the same file is already on the server. */
  async function setupConflict(api: FakeSyncServer) {
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', '1\n2\n3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    // A edits (stays local), B deletes and pushes → A's next pull is a delete/modify
    // conflict (A's edit vs B's tombstone).
    await A.editFile('note.md', '1\nAAA\n3\n', 2000);
    await B.deleteFile('note.md', 3000);
    await client(B).runSync();

    return { A, B, client };
  }

  test('an auto round defers the conflict: nothing applied, cursor held, re-presents next round', async () => {
    const api = new FakeSyncServer();
    const { A, B, client } = await setupConflict(api);

    // ── AUTO round: the closure defers (DEFER_CONFLICT) rather than prompting. ──
    let deferCalls = 0;
    A.resolveDeleteConflict = () => { deferCalls++; return DEFER_CONFLICT; };

    const cursorBefore = await A.cursor();
    await client(A).runSync();

    // The conflict was surfaced by the real merge, and the applicator deferred it.
    expect(A.applied.some(a => a.type === 'delete_conflict')).toBe(true);
    expect(deferCalls).toBe(1);
    // Nothing was applied — A keeps its own edit untouched.
    expect(await onDisk(A)).toBe('1\nAAA\n3\n');
    // Cursor HELD at the round's start (F5 semantics) — B's remote delete was NOT
    // consumed, so a later round re-pulls and re-merges it.
    expect(await A.cursor()).toBe(cursorBefore);

    // ── A subsequent MANUAL round DOES present the same conflict and resolves it. ──
    let interactiveCalls = 0;
    A.resolveDeleteConflict = () => { interactiveCalls++; return 'keep_modified'; };

    await client(A).runSync();
    expect(interactiveCalls).toBe(1);              // the deferred conflict came back
    expect(await onDisk(A)).toBe('1\nAAA\n3\n');    // restored: A's edit kept

    // A pushes the resolution; B pulls it and converges (the file is restored on B).
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B)).toBe('1\nAAA\n3\n');
    expect(await onDisk(A)).toBe(await onDisk(B));
  });
});
