// ─────────────────────────────────────────────
// Sync scenarios — empty files, the truncation guard, and exclusions
// ─────────────────────────────────────────────
//
//  Spec Part 2 G12/G13/G17. The interesting tension: the applicator's
//  `wouldTruncateNonEmpty` guard (defense-in-depth for F1) refuses to overwrite a
//  non-empty file with empty bytes — which correctly stops a *fabricated* empty
//  write, but ALSO blocks a user *legitimately emptying* a file from reaching the
//  peer. These tests pin both faces of that guard, and flag the false-positive as
//  a known bug rather than asserting the divergence is desired.
//
//  Driven through the real device stack (TestDevice) + FakeSyncServer.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
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

  // ── G13 (a): non-empty → empty. The DESIRED behaviour — currently BLOCKED. ──
  // eslint-disable-next-line vitest/no-disabled-tests
  test.skip('KNOWN BUG (G13a): legitimately emptying a file should propagate, but the truncation guard blocks it', async () => {
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

    // DESIRED: B converges to the empty file. TODAY this FAILS — the applicator's
    // wouldTruncateNonEmpty guard refuses to overwrite B's non-empty copy with the
    // (legitimate) empty content, so B stays on the stale text and the two devices
    // diverge permanently on a normal sync. See the mechanism test below. Fixing it
    // needs the guard to distinguish a genuine empty EDIT (op-backed, content
    // present) from a fabricated/missing-content empty — e.g. only refuse when the
    // empty content is NOT a real, hash-verified op payload.
    expect(await text(B, 'n.md')).toBe('');
  });

  // The mechanism behind the bug above, asserted honestly: the merge DOES decide to
  // empty B's file (a clean write_local with zero-byte content), but the applicator
  // declines to perform the write. This is the guard firing — correct for a
  // fabricated empty, a false-positive for a legitimate one. It is the ONLY
  // real-world path that reaches the guard: state-merge already returns no_op when a
  // winner's bytes are genuinely missing (resolveContentConflict), so the guard
  // never actually fires for the missing-content hazard it was written for.
  test('the truncation guard blocks the empty write the merge produced (root cause of G13a)', async () => {
    const api = new FakeSyncServer();
    const [A, B] = await pair(api);

    await A.seedFile('n.md', 'content here\n', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();

    await A.editFile('n.md', '', 2000);
    await client(api, A).runSync();
    await client(api, B).runSync();

    // The merge asked to empty the file…
    expect(B.applied.some(a => a.type === 'write_local' && a.content.length === 0)).toBe(true);
    // …but the guard stopped the write, so B still holds the old content (divergence).
    expect(await text(B, 'n.md')).toBe('content here\n');
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
