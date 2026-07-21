// ─────────────────────────────────────────────
// Sync scenarios — empty files, the truncation guard, and exclusions
// ─────────────────────────────────────────────
//
//  Spec Part 2 G12/G13/G17. Empty-file handling and the truncation guarantee:
//  a user *legitimately emptying* a file must propagate to the peer (G13), while a
//  *fabricated/missing-content* empty must never truncate a non-empty file (G12).
//  The protection against the latter lives in state-merge (no_op when a winner's
//  bytes are missing), NOT a blanket applicator refusal — the former applicator
//  guard was a false-positive that blocked legitimate empties, and is now gone.
//
//  Driven through the real device stack (TestDevice) + FakeSyncServer; G12 asserts
//  the merge guarantee directly.

import { describe, test, expect, beforeAll } from 'vitest';
import { VaultState } from '../src/types';
import { HybridLogicalClock } from '../src/core/hlc';
import { ServerSyncClient } from '../src/network/server-sync';
import { mergeVaultStates } from '../src/merge/state-merge';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

const text = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes === null ? '<absent>' : new TextDecoder().decode(bytes);
};
const len = async (d: TestDevice, path: string): Promise<number> => {
  const bytes = await d.files.read(path);
  return bytes === null ? -1 : bytes.length;
};

describe('empty files, truncation guard, and exclusions', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  async function pair(api: FakeSyncServer): Promise<[TestDevice, TestDevice]> {
    return [await TestDevice.create('dev-a'), await TestDevice.create('dev-b')];
  }

  // ── G13 (b): empty → non-empty is a normal, unguarded transition. ───────────
  test('an empty file that later gains content propagates to the peer', async () => {
    const api = new FakeSyncServer();
    const [A, B] = await pair(api);

    await A.seedFile('e.md', '', 1000);          // born empty
    await client(api, A).runSync();
    await client(api, B).runSync();
    expect(await len(B, 'e.md')).toBe(0);        // B has the empty file

    await A.editFile('e.md', 'now it has content\n', 2000);
    await client(api, A).runSync();
    await client(api, B).runSync();

    // Writing content over an empty file is never a truncation, so it applies cleanly.
    expect(await text(B, 'e.md')).toBe('now it has content\n');
  });

  // ── G13 (a): non-empty → empty is a legitimate edit that must propagate. ────
  test('legitimately emptying a file propagates to the peer (G13a)', async () => {
    const api = new FakeSyncServer();
    const [A, B] = await pair(api);

    await A.seedFile('n.md', 'content here\n', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();
    expect(await text(B, 'n.md')).toBe('content here\n');

    // A deliberately clears the note (a real, intentional edit) and syncs.
    await A.editFile('n.md', '', 2000);
    await client(api, A).runSync();
    await client(api, B).runSync();

    // The merge produces a clean write_local with zero-byte content, and the
    // applicator now performs it (the false-positive truncation guard is gone), so
    // B converges to the empty file instead of diverging on the stale text. The F1
    // protection against a *fabricated/missing-content* empty lives where it belongs
    // — state-merge, which no_ops when a winner's bytes are absent (see G12 below).
    expect(B.applied.some(a => a.type === 'write_local' && a.content.length === 0)).toBe(true);
    expect(await text(B, 'n.md')).toBe('');
  });

  // ── Sequential edit fast-forward: empty ↔ content across two devices. ───────
  //  Reported: A creates an empty file, both sync; A adds text, both sync; then a
  //  device empties it, both sync — and the other device spuriously conflicted /
  //  kept the stale text / duplicated the file. Root cause: the editing device's
  //  own `ancestorContentHash` never advances when it pushes its edit (pushing
  //  isn't a peer acknowledgement — ancestor-policy), so a later pull three-way-
  //  merged against a STALE empty ancestor. Fix: ops carry `baseContentHash` (the
  //  content the edit derived from); the merge fast-forwards when the peer's base
  //  equals our current content, adopting the descendant cleanly. These are
  //  SEQUENTIAL edits (each device sees the other's before editing) — there is no
  //  real divergence, so no conflict may ever surface.
  test('empty → content → empty converges with NO conflict (sequential, FF)', async () => {
    const api = new FakeSyncServer();
    const [A, B] = await pair(api);

    await A.seedFile('123.md', '', 1000);          // 1. A: empty
    await client(api, A).runSync();
    await client(api, B).runSync();                // 2. B: empty
    expect(await len(B, '123.md')).toBe(0);

    await A.editFile('123.md', '3\n', 2000);       // 3. A: add text
    await client(api, A).runSync();
    await client(api, B).runSync();                // 4. B: gets text
    expect(await text(B, '123.md')).toBe('3\n');

    await B.editFile('123.md', '', 3000);          // 5. B: empty it again
    await client(api, B).runSync();

    A.applied.length = 0;
    await client(api, A).runSync();                // 6. A: pulls the empty

    // A must fast-forward to the empty (B derived it straight from A's "3\n"), not
    // three-way-merge against A's stale empty ancestor and keep "3\n".
    expect(A.applied.some(a => a.type === 'conflict' || a.type === 'delete_conflict')).toBe(false);
    expect(await text(A, '123.md')).toBe('');
    expect(await text(B, '123.md')).toBe('');
  });

  test('sequential content edits never union/duplicate (FF, the 3→4 lineage)', async () => {
    const api = new FakeSyncServer();
    const [A, B] = await pair(api);

    await A.seedFile('123.md', '', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();

    await A.editFile('123.md', '3\n', 2000);
    await client(api, A).runSync();
    await client(api, B).runSync();
    expect(await text(B, '123.md')).toBe('3\n');

    await B.editFile('123.md', '4\n', 3000);       // B edits 3 → 4 (having seen "3")
    await client(api, B).runSync();

    A.applied.length = 0;
    await client(api, A).runSync();                // A (holding "3") pulls "4"

    // The bug produced "3\n4\n" (empty-ancestor diff3 union). With the FF, A adopts
    // "4" cleanly — B's edit descends directly from A's current content.
    expect(await text(A, '123.md')).toBe('4\n');
    expect(A.applied.some(a => a.type === 'conflict')).toBe(false);
  });

  // ── G12: the REAL truncation protection lives in state-merge, not a blanket
  //    applicator refusal. When the HLC-winning side's bytes are genuinely missing,
  //    the merge returns no_op — it NEVER emits a truncating empty write_local — so
  //    a non-empty local file is left untouched (F1). This is the guarantee the
  //    removed applicator guard was standing in for; here it's pinned at its source.
  test('a missing-content winner no_ops at the merge — a non-empty file is never truncated (G12)', () => {
    const clockLocal = new HybridLogicalClock('dev-a');
    const clockRemote = new HybridLogicalClock('dev-b');

    // Local holds a non-empty file; remote has a higher-HLC edit whose content is
    // NOT in either store (a transient/absent blob — the real truncation hazard).
    const local: VaultState = {
      deviceId: 'dev-a',
      hlc: clockLocal.now(),
      pendingOps: [],
      fileEntries: new Map([['f1', {
        id: 'f1', path: 'n.md', contentHash: 'local-nonempty',
        hlcTimestamp: clockLocal.now(), deleted: false,
        ancestorContentHash: 'base', ancestorPath: 'n.md',
      }]]),
      contentStore: new Map([['local-nonempty', new TextEncoder().encode('content here\n')]]),
    };
    const remote: VaultState = {
      deviceId: 'dev-b',
      hlc: clockRemote.now(),
      pendingOps: [],
      fileEntries: new Map([['f1', {
        id: 'f1', path: 'n.md', contentHash: 'remote-missing',
        hlcTimestamp: clockRemote.now(), deleted: false,
        ancestorContentHash: 'base', ancestorPath: 'n.md',
      }]]),
      contentStore: new Map(), // winner's bytes absent
    };

    const { actions } = mergeVaultStates(local, remote);
    // No truncating/empty write is ever produced — the file is deferred, not clobbered.
    expect(actions).toContainEqual(expect.objectContaining({ type: 'no_op', fileId: 'f1' }));
    expect(actions.some(a => a.type === 'write_local')).toBe(false);
  });

  // ── G17: excluded paths are never captured as ops. ──────────────────────────
  test('a file at an excluded path is never captured (exclusion gate)', async () => {
    const A = await TestDevice.create('dev-a');

    // '.obsidian/workspace.json' is excluded by default (always, regardless of the
    // syncObsidianConfig toggle). A create event for it must produce no op and no
    // registry entry.
    await A.files.write('.obsidian/workspace.json', new TextEncoder().encode('{"x":1}'));
    await A.watcher.emitCreate('.obsidian/workspace.json');
    expect(A.entryByPath('.obsidian/workspace.json')).toBeUndefined();
    expect(A.pendingOps.some(op => op.path === '.obsidian/workspace.json')).toBe(false);

    // Control: a normal note at a non-excluded path IS captured, so the gate is
    // selective, not off.
    await A.seedFile('kept.md', 'hello\n', 1000);
    expect(A.entryByPath('kept.md')).toBeDefined();
    expect(A.pendingOps.some(op => op.path === 'kept.md')).toBe(true);
  });
});
