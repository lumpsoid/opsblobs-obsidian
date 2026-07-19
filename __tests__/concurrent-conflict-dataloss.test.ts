// ─────────────────────────────────────────────
//  Regression: concurrent conflicting edits must not silently lose data
// ─────────────────────────────────────────────
//
//  Reproduces a reported bug and locks in its fix. Two devices (A, B) edit the
//  same lines of one file concurrently. The bug was that A's edit got *silently*
//  replaced by B's — no conflict prompt, data lost — and the devices diverged.
//
//  Reported sequence (verbatim):
//    · A creates `test-conflict.md`:      1 / 2 / 3         and syncs
//    · B syncs, gets it exactly, edits:   1 / 2 / 999       and syncs
//    · concurrently A edits:              1 / 2 / 4 / 5      and syncs
//        → A ended up showing             1 / 2 / 999        (A's edit lost!)
//
//  Root cause (client-side, server-agnostic): the edit hadn't been recorded as
//  an op yet when sync ran — `triggerSync` didn't flush the OperationLogger's
//  debounce, so an edit-then-immediately-sync raced it — and
//  `PluginVaultSyncHost.buildLocalState` then read the *current* file bytes but
//  keyed them under the registry's now-*stale* `contentHash`. That aliased the
//  new bytes over the ancestor, so the three-way merge saw A's side as unchanged
//  and cleanly adopted the remote → silent clobber.
//
//  The merge itself was always correct:
//  `threeWayMerge('1\n2\n3', '1\n2\n4\n5', '1\n2\n999')` reports a conflict. The
//  defect was the inconsistent state fed into it.
//
//  Fix (both landed): `triggerSync` flushes the debounce before building state,
//  and `buildLocalState` keys content under the *actual* hash of the bytes on
//  disk (correcting the entry if the registry hash is stale) so current bytes can
//  never masquerade as the ancestor. `MemoryHost` mirrors the corrected
//  buildLocalState (see its `disk` map), so this drives the real ServerSyncClient
//  round against the fake and asserts the fixed behaviour: a conflict is surfaced
//  and A keeps its edit rather than silently taking B's.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerApi, ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { HybridLogicalClock } from '../src/core/hlc';
import { FakeSyncServer } from '../src/network/fake-server';
import { MemoryHost, seedFile, editFile } from './helpers/memory-host';

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

/**
 * Model the debounce race: the file on "disk" now reads `newText`, but the modify
 * op hasn't been logged — so the registry entry's `contentHash` (and ancestor)
 * are still the old ones and there is no pending op. This is exactly the state a
 * sync sees when it runs inside the op-logger's debounce window.
 */
function editWithoutLogging(host: MemoryHost, fileId: string, newText: string): void {
  host.disk.set(fileId, new TextEncoder().encode(newText));
  // deliberately: no registry hash update, no pending op.
}

describe('concurrent conflicting edits (reported data-loss bug)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  /** A device's current file content = its on-disk bytes. */
  const onDisk = (h: MemoryHost, fileId = 'f1'): string => {
    const bytes = h.disk.get(fileId);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('A must not silently lose its edit when B changed the same lines', async () => {
    const api: ServerApi = new FakeSyncServer();
    const client = (host: MemoryHost, deviceId: string) =>
      new ServerSyncClient({ api, crypto: vc, host, hlc: new HybridLogicalClock(deviceId) });

    const A = new MemoryHost('dev-a');
    const B = new MemoryHost('dev-b');

    // ── A creates `test-conflict.md` = "1\n2\n3" and syncs. ──────────────────
    const base = await seedFile(A, 'dev-a', 'f1', 'test-conflict.md', '1\n2\n3\n', 1000);
    await client(A, 'dev-a').runSync();
    // Mirror the applicator's send_remote ancestor update (MemoryHost doesn't):
    // A's just-synced content becomes its shared ancestor.
    A.fileEntries.get('f1')!.ancestorContentHash = base.hash;

    // ── B syncs, receiving A's file exactly. ────────────────────────────────
    await client(B, 'dev-b').runSync();
    expect(onDisk(B)).toBe('1\n2\n3\n');

    // ── B edits line 3 → "1\n2\n999" and syncs (a normal, logged edit). ─────
    await editFile(B, 'dev-b', 'f1', 'test-conflict.md', '1\n2\n999\n', 2000);
    await client(B, 'dev-b').runSync();

    // ── Concurrently, A edits line 3 and appends → "1\n2\n4\n5". The edit
    //    reaches the file but hasn't been logged as an op when A's sync fires
    //    (the debounce race). ─────────────────────────────────────────────────
    editWithoutLogging(A, 'f1', '1\n2\n4\n5\n');
    await client(A, 'dev-a').runSync();

    // ── With the fix: A's edit and B's edit touch the same line, so this is a
    //    genuine conflict — it must be surfaced, and A must keep its own edit
    //    rather than silently adopting B's "1\n2\n999". ───────────────────────
    expect(A.applied.some(a => a.type === 'conflict')).toBe(true);   // conflict surfaced
    expect(A.applied.some(a => a.type === 'write_local')).toBe(false); // NOT a silent overwrite
    expect(onDisk(A)).toBe('1\n2\n4\n5\n');                           // A's edit preserved
    expect(onDisk(A)).not.toBe('1\n2\n999\n');                       // and not clobbered
  });

  // A second, distinct data-loss path reported after the debounce fix landed:
  // here both edits ARE logged, but the *first* device to sync its edit re-pulled
  // its own ops and merged its fresh edit against that stale self-projection,
  // producing a clean `write_local` of its own content that advanced its ancestor
  // to its un-acknowledged edit. Its later merge against the peer's concurrent
  // edit then used the wrong base and silently clobbered its own change.
  // Fix: exclude own ops from the remote projection (reconstructRemoteState) and
  // never advance the ancestor on `send_remote` (updateAncestorHashes) — both
  // mirrored by MemoryHost here (own-op exclusion is shared production code; the
  // ancestor rule matches MemoryHost never advancing on send_remote).
  test('the device that syncs its edit first must not clobber its own change', async () => {
    const api: ServerApi = new FakeSyncServer();
    const client = (host: MemoryHost, deviceId: string) =>
      new ServerSyncClient({ api, crypto: vc, host, hlc: new HybridLogicalClock(deviceId) });

    const A = new MemoryHost('dev-a');
    const B = new MemoryHost('dev-b');

    // ── A creates `my-first` = "1\n2\n3", syncs; B syncs and receives it. ────
    const base = await seedFile(A, 'dev-a', 'f1', 'my-first', '1\n2\n3\n', 1000);
    await client(A, 'dev-a').runSync();
    A.fileEntries.get('f1')!.ancestorContentHash = base.hash; // first-sync base (mirrors applicator)
    await client(B, 'dev-b').runSync();

    // ── A edits → "1\n2\n4\n5" and syncs FIRST (a normal logged edit). ───────
    await editFile(A, 'dev-a', 'f1', 'my-first', '1\n2\n4\n5\n', 2000);
    await client(A, 'dev-a').runSync();
    // Syncing its own edit must not corrupt A's ancestor to that edit…
    expect(A.fileEntries.get('f1')!.ancestorContentHash).toBe(base.hash);
    expect(A.applied.some(a => a.type === 'write_local')).toBe(false);

    // ── B concurrently edits the same line → "1\n2\n999" and syncs. ──────────
    await editFile(B, 'dev-b', 'f1', 'my-first', '1\n2\n999\n', 3000);
    await client(B, 'dev-b').runSync();
    expect(B.applied.some(a => a.type === 'conflict')).toBe(true); // B sees the conflict

    // ── A syncs again, pulling B's concurrent edit. ──────────────────────────
    const before = A.applied.length;
    await client(A, 'dev-a').runSync();
    const aActions = A.applied.slice(before).map(a => a.type);

    // A must surface a conflict against the TRUE base "1\n2\n3" and keep its own
    // edit — never silently adopt B's "1\n2\n999".
    expect(aActions).toContain('conflict');
    expect(aActions).not.toContain('write_local');
    expect(onDisk(A)).toBe('1\n2\n4\n5\n');
    expect(onDisk(A)).not.toBe('1\n2\n999\n');
  });
});
