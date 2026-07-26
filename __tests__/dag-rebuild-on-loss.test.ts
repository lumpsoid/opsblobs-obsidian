// ─────────────────────────────────────────────
//  Sync v2 — a lost version-DAG self-heals from the server log
// ─────────────────────────────────────────────
//
//  The version-DAG (`.opsblobs/version-dag.json`) is a *derived* cache of the
//  server op log, not a source of truth: every edge is `op.id → parents`, and the
//  server holds every op. So if the file is lost — a torn write on an older build
//  (pre-atomic-write), or a hand-deleted metadata file — it must be rebuildable by
//  replaying the log, NOT left empty (an empty DAG strands every merge base, so the
//  next concurrent merge degrades to a spurious conflict).
//
//  `VersionDagStore.load()` maps any corruption to an empty graph, so the loss
//  signature is "cursor > 0 (we've synced before) but the DAG is empty". A round
//  that sees this rewinds the cursor to 0 and re-pulls, and `recordVersionEdges`
//  rebuilds the graph — the same self-healing `recheckConflicts` triggers by hand.
//
//  Drives the genuine ServerSyncClient round against the fake server.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
// The DAG persists as a snapshot + an append-only journal; a genuine loss drops both.
const DAG_SNAPSHOT = '.opsblobs/version-dag.json';
const DAG_JOURNAL = '.opsblobs/version-dag.log';

const onDisk = async (d: TestDevice, path = 'note.md'): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

describe('a lost version-DAG is rebuilt from the server log on the next sync', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('cursor>0 + empty DAG → rewind + replay rebuilds the graph, and a peer edit still fast-forwards', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice, labels?: string[]) =>
      new ServerSyncClient({
        api, crypto: vc, host: d.host, hlc: d.hlc,
        onProgress: labels ? (l => labels.push(l)) : undefined,
      });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // ── Shared base WITH history, so B's DAG has real depth to lose. ──────────
    await A.seedFile('note.md', 'L1\nL2\nL3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();               // B pulls the create → records its DAG node
    await A.editFile('note.md', 'L1x\nL2\nL3\n', 2000);
    await client(A).runSync();
    await client(B).runSync();               // B fast-forwards to the edited base
    expect(await onDisk(B)).toBe('L1x\nL2\nL3\n');

    const head = B.entryByPath('note.md')!.headVersionId!;
    expect((await B.versionDagStore.load()).has(head)).toBe(true);   // DAG is healthy…
    expect(await B.cursor()).toBeGreaterThan(0);                     // …and we've synced

    // ── Simulate a lost/corrupt version DAG (torn write / deleted files). ─────
    await B.metadata.remove(DAG_SNAPSHOT);
    await B.metadata.remove(DAG_JOURNAL);
    expect((await B.versionDagStore.load()).size()).toBe(0);         // loads empty
    expect((await B.versionDagStore.load()).has(head)).toBe(false);  // precondition: lost

    // ── A makes a concurrent edit off the shared base and pushes it. B must
    //    rebuild its DAG to recognise A's edit as a descendant (a fast-forward)
    //    rather than an unrelated head. ──
    await A.editFile('note.md', 'L1x\nL2\nA3\n', 3000);
    await client(A).runSync();

    // ── B syncs. It has no local edit, so the only work is healing + applying
    //    A's edit. The heal must fire and the DAG must come back. ──
    const labels: string[] = [];
    await client(B, labels).runSync();

    expect(labels).toContain('Rebuilding sync history…');            // the heal branch fired
    const healed = await B.versionDagStore.load();
    expect(healed.size()).toBeGreaterThan(0);                        // graph rebuilt
    expect(healed.has(head)).toBe(true);                             // the lost head is back
    expect(await onDisk(B)).toBe('L1x\nL2\nA3\n');                   // A's edit fast-forwarded
    expect(B.applied.some(a => a.type === 'conflict')).toBe(false);  // no spurious conflict
    expect(await B.cursor()).toBeGreaterThan(0);                     // cursor re-advanced

    // ── A stable device does NOT re-trigger the heal (no loop). ──────────────
    const labels2: string[] = [];
    await client(B, labels2).runSync();
    expect(labels2).not.toContain('Rebuilding sync history…');
  });

  test('a fresh device (cursor 0) with an empty DAG is NOT mistaken for a loss', async () => {
    // A brand-new device with a local-only file has an empty DAG and cursor 0 —
    // this must sync normally, never taking the rebuild path (which would be a
    // harmless no-op here, but the guard keeps the fresh-device path clean).
    const api = new FakeSyncServer();
    const A = await TestDevice.create('solo');
    await A.seedFile('note.md', 'hello\n', 1000);
    expect((await A.versionDagStore.load()).size()).toBe(0);
    expect(await A.cursor()).toBe(0);
    expect(await A.host.dagNeedsRebuild(await A.host.loadDag())).toBe(false);

    const labels: string[] = [];
    await new ServerSyncClient({ api, crypto: vc, host: A.host, hlc: A.hlc, onProgress: l => labels.push(l) }).runSync();
    expect(labels).not.toContain('Rebuilding sync history…');
    expect((await A.versionDagStore.load()).size()).toBeGreaterThan(0); // now populated
  });
});
