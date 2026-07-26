// ─────────────────────────────────────────────
//  Sync v2 — one version-DAG load per round (round-residual spec R3)
// ─────────────────────────────────────────────
//
//  R3 threads a SINGLE loaded VersionDag through the round instead of having
//  `dagNeedsRebuild`, `buildLocalState`, and `recordVersionEdges` each re-read
//  `version-dag.json` + replay the journal (3 deserializations → 1). The win is
//  pure redundant I/O + parse removal; the risk is the §3.1 trap — if the three
//  consumers *share* one instance, `buildLocalState` folds this round's pending
//  ops into it, so `recordVersionEdges`'s `addVersion` returns `false` for them
//  and they NEVER reach the journal (the persisted DAG silently drifts from the
//  oplog). The fix: `buildLocalState` folds into a private `clone()`, leaving the
//  shared instance pristine for `recordVersionEdges` to journal from.
//
//  These drive the genuine ServerSyncClient round over the real device stack
//  (TestDevice) against the fake server — the journal-integrity test (#2) is the
//  regression guard: it FAILS against a naïve shared-instance implementation.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
const DAG_SNAPSHOT = '.opsblobs/version-dag.json';
const DAG_JOURNAL = '.opsblobs/version-dag.log';

const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

/** Wrap `versionDagStore.load` with a call counter, returning a reset fn. */
function countDagLoads(d: TestDevice): { count: () => number; reset: () => void } {
  let n = 0;
  const orig = d.versionDagStore.load.bind(d.versionDagStore);
  d.versionDagStore.load = async () => { n++; return orig(); };
  return { count: () => n, reset: () => { n = 0; } };
}

/** Non-empty lines of the persisted DAG journal (one JSONL record per new edge). */
async function journalLines(d: TestDevice): Promise<string[]> {
  const raw = await d.metadata.read(DAG_JOURNAL);
  return raw ? raw.split('\n').filter(Boolean) : [];
}

describe('R3 — one version-DAG deserialization per round', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  const client = (api: FakeSyncServer, d: TestDevice, labels?: string[]) =>
    new ServerSyncClient({
      api, crypto: vc, host: d.host, hlc: d.hlc,
      onProgress: labels ? (l => labels.push(l)) : undefined,
    });

  test('the win — a steady-state round loads the DAG exactly once, not three times', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    // Round 1 establishes cursor > 0 (so round 2 exercises the FULL 3-load path:
    // dagNeedsRebuild loads only when cursor > 0). Instrument only round 2.
    await A.seedFile('n.md', 'hello\n', 1000);
    await client(api, A).runSync();

    const loads = countDagLoads(A);
    await A.editFile('n.md', 'world\n', 2000);   // a real local edit → a full round
    loads.reset();
    await client(api, A).runSync();

    // Pre-R3 this was 3 (dagNeedsRebuild + buildLocalState + recordVersionEdges).
    expect(loads.count()).toBe(1);
  });

  test('journal integrity (the §3.1 trap): a round\'s edit edge IS journaled and survives reload', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    const id = await A.seedFile('n.md', 'hello\n', 1000);
    const createVersion = A.entry(id)!.headVersionId!;
    await client(api, A).runSync();

    await A.editFile('n.md', 'world\n', 2000);
    const editVersion = A.entry(id)!.headVersionId!;   // the update op's id
    await client(api, A).runSync();

    // The regression guard: the edit's op-id edge must be in the PERSISTED journal.
    // A naïve shared-instance impl (buildLocalState pre-adds the pending op) makes
    // recordVersionEdges see it as already-present → it never journals → this fails.
    const lines = await journalLines(A);
    expect(lines.some(l => l.includes(editVersion))).toBe(true);

    // …and it survives a restart (the persisted graph, not just the in-memory one).
    const A2 = await A.reload();
    const dag = await A2.versionDagStore.load();
    expect(dag.has(editVersion)).toBe(true);
    expect(dag.isAncestor(createVersion, editVersion)).toBe(true);
  });

  test('no journal bloat: idle rounds (our own ops re-pull) append nothing', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    await A.seedFile('n.md', 'hello\n', 1000);
    await client(api, A).runSync();
    await A.editFile('n.md', 'world\n', 2000);
    await client(api, A).runSync();

    const before = (await journalLines(A)).length;
    expect(before).toBeGreaterThan(0);           // the create + edit edges are there

    // Two rounds with NO new edits: our own ops re-pull every round, but
    // addVersion returns false for edges already in the graph, so nothing appends.
    await client(api, A).runSync();
    const mid = (await journalLines(A)).length;
    await client(api, A).runSync();
    const after = (await journalLines(A)).length;

    expect(mid).toBe(before);
    expect(after).toBe(before);
  });

  test('convergence unbroken: a concurrent clean three-way merge still converges', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // Shared base '1\n2\n3\n'.
    await A.seedFile('m.md', '1\n2\n3\n', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();
    expect(await onDisk(B, 'm.md')).toBe('1\n2\n3\n');

    // Concurrent, non-overlapping edits off that base (A→line1, B→line3).
    await A.editFile('m.md', 'X\n2\n3\n', 2000);
    await B.editFile('m.md', '1\n2\nY\n', 2500);
    await client(api, A).runSync();              // A pushes its edit

    // B pushes its edit AND pulls A's — a three-way merge against the DAG base
    // (LCA = the create op, whose bytes buildLocalState staged from B's head).
    await client(api, B).runSync();
    expect(await onDisk(B, 'm.md')).toBe('X\n2\nY\n');   // clean merge
    expect(B.applied.some(a => a.type === 'conflict')).toBe(false);

    // A pulls B's edit + merge node → fast-forwards. Both converge identically.
    await client(api, A).runSync();
    expect(await onDisk(A, 'm.md')).toBe('X\n2\nY\n');
    expect(await onDisk(A, 'm.md')).toBe(await onDisk(B, 'm.md'));
  });

  test('self-heal still fires on a torn DAG with the single-load path', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    await A.seedFile('n.md', 'hello\n', 1000);
    await client(api, A).runSync();
    await client(api, A).runSync();   // re-pull our own op so the cursor advances past 0
    expect(await A.cursor()).toBeGreaterThan(0);

    // Lose the derived DAG (both persistence files) — it now loads empty while the
    // cursor is > 0: the exact "was populated, now empty ⇒ lost" signature.
    await A.metadata.remove(DAG_SNAPSHOT);
    await A.metadata.remove(DAG_JOURNAL);
    expect((await A.versionDagStore.load()).size()).toBe(0);

    const labels: string[] = [];
    await client(api, A, labels).runSync();

    expect(labels).toContain('Rebuilding sync history…');     // heal branch fired
    expect((await A.versionDagStore.load()).size()).toBeGreaterThan(0);   // rebuilt
    expect(await A.cursor()).toBeGreaterThan(0);              // cursor re-advanced

    // A stable device does not re-trigger the heal (no loop).
    const labels2: string[] = [];
    await client(api, A, labels2).runSync();
    expect(labels2).not.toContain('Rebuilding sync history…');
  });
});
