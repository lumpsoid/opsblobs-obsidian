// ─────────────────────────────────────────────
//  Tests — VersionDag.prune / sweepToRoots (reachability sweep)
// ─────────────────────────────────────────────
//
//  The graph had no removal API at all, so every op this device ever authored or pulled
//  stayed forever — including the subgraphs of whole FILES the registry has since
//  forgotten (a reclaimed tombstone, a dropped divergent duplicate, a rebuild that
//  re-minted fileIds), which on a real 8.4k-file vault was half the graph.
//
//  The sweep is deliberately NOT a retention horizon: it keeps every root and every
//  ancestor of one, so it cannot change an answer the class gives. These tests pin that
//  claim per consumer (mergeBase / isAncestor / leaves / reachableContentHashes), because
//  the failure mode of getting it wrong is not a crash — a lost merge base makes
//  `mergeBase` return null, which the merge reads as "no common ancestor" and resolves by
//  unioning both sides against an empty base, silently duplicating a file.
//
//  Roots come from the real FileRegistry over fakes (`versionRoots`), not a hand-built
//  set, so the tombstone/conflictParents cases are exercised through the real load path.

import { describe, test, expect } from 'vitest';
import { VersionDag, sweepToRoots } from '../src/core/version-dag';
import { FileRegistry } from '../src/core/file-registry';
import { FileEntry, HLC, SyncSettings } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';

const REGISTRY_PATH = '.opsblobs/file-registry.json';
const hlc: HLC = { wallTime: 1, counter: 0, deviceId: 'dev' };

function entry(over: Partial<FileEntry>): FileEntry {
  return {
    id: over.id ?? 'id',
    path: over.path ?? 'note.md',
    contentHash: over.contentHash ?? '',
    hlcTimestamp: hlc,
    deleted: over.deleted ?? false,
    ...over,
  };
}

async function registryWith(entries: FileEntry[]): Promise<FileRegistry> {
  const meta = new FakeMetadataStore();
  meta.set(REGISTRY_PATH, JSON.stringify({
    version: 1,
    entries: entries.map(e => [e.id, e]),
  }));
  const settings = (() => ({}) as SyncSettings);
  const reg = new FileRegistry(meta, new FakeVaultFiles(), 'dev', settings);
  await reg.load();
  return reg;
}

/** f1: A → B → C (C is the live head). f2: X → Y — a whole file the registry forgot. */
function twoFileDag(): VersionDag {
  const dag = new VersionDag();
  dag.addVersion('A', [], 'hA', 'f1');
  dag.addVersion('B', ['A'], 'hB', 'f1');
  dag.addVersion('C', ['B'], 'hC', 'f1');
  dag.addVersion('X', [], 'hX', 'f2');
  dag.addVersion('Y', ['X'], 'hY', 'f2');
  return dag;
}

describe('VersionDag.prune', () => {
  test('keeps a root and its ancestors, drops a forgotten file\'s whole subgraph', () => {
    const dag = twoFileDag();
    expect(dag.prune(['C'])).toBe(2);          // X and Y
    expect(dag.size()).toBe(3);
    for (const kept of ['A', 'B', 'C']) expect(dag.has(kept)).toBe(true);
    for (const gone of ['X', 'Y']) expect(dag.has(gone)).toBe(false);
  });

  test('a kept node never names a dropped parent (no dangling edges)', () => {
    const dag = twoFileDag();
    dag.prune(['C']);
    // Reachability is upward-closed, so every parent a survivor names survives too.
    for (const [, node] of Object.entries(dag.toJSON())) {
      for (const p of node.parents) expect(dag.has(p)).toBe(true);
    }
  });

  test('preserves every consumer\'s answer: mergeBase, isAncestor, leaves, staging', () => {
    const dag = twoFileDag();
    // Two heads of f1 that will need a base: C (ours) and D, a peer edit off B.
    dag.addVersion('D', ['B'], 'hD', 'f1');

    const before = {
      base: dag.mergeBase('C', 'D'),
      ancestor: dag.isAncestor('A', 'C'),
      leaves: dag.leaves('f1').sort(),
      staged: [...dag.reachableContentHashes('C')].sort(),
    };
    expect(before.base).toBe('B');

    expect(dag.prune(['C', 'D'])).toBe(2);     // f2 goes, f1 is untouched

    expect(dag.mergeBase('C', 'D')).toBe(before.base);
    expect(dag.isAncestor('A', 'C')).toBe(before.ancestor);
    expect(dag.leaves('f1').sort()).toEqual(before.leaves);
    expect([...dag.reachableContentHashes('C')].sort()).toEqual(before.staged);
  });

  test('a peer head that arrives AFTER the sweep still finds its base on our chain', () => {
    // The property that makes reachability pruning safe where a retention horizon is not:
    // LCA(ourHead, anyPeerHead) is by definition an ancestor of ourHead, so rooting on our
    // head retains every base we could ever need — even for a head we have not seen yet.
    // A horizon would have deleted `A` (the oldest node) and left the two disconnected,
    // which the merge resolves by unioning both sides against an empty base.
    const dag = twoFileDag();
    dag.prune(['C']);                          // only our own head is known at sweep time
    dag.addVersion('P', ['A'], 'hP', 'f1');    // a peer's stale-based edit, pulled later
    expect(dag.mergeBase('C', 'P')).toBe('A');
    expect(dag.contentHashOf('A')).toBe('hA'); // ...and its bytes are still addressable
  });

  test('does not resurrect a dropped node as a leaf', () => {
    const dag = twoFileDag();
    dag.prune(['C']);
    expect(dag.leaves('f2')).toEqual([]);      // the forgotten file has no heads at all
    expect(dag.leaves('f1')).toEqual(['C']);
  });

  test('a merge node keeps both parents\' lineages', () => {
    const dag = new VersionDag();
    dag.addVersion('A', [], 'hA', 'f1');
    dag.addVersion('L', ['A'], 'hL', 'f1');
    dag.addVersion('R', ['A'], 'hR', 'f1');
    dag.addVersion('M', ['L', 'R'], 'hM', 'f1');   // the resolution
    dag.addVersion('Z', [], 'hZ', 'f9');           // unrelated, forgotten

    expect(dag.prune(['M'])).toBe(1);
    for (const kept of ['A', 'L', 'R', 'M']) expect(dag.has(kept)).toBe(true);
    expect(dag.isMergeNode('M')).toBe(true);
  });

  test('survives the persistence round-trip', () => {
    const dag = twoFileDag();
    dag.prune(['C']);
    const reloaded = VersionDag.fromJSON(JSON.parse(JSON.stringify(dag.toJSON())));
    expect(reloaded.size()).toBe(3);
    expect(reloaded.has('Y')).toBe(false);
    expect(reloaded.mergeBase('C', 'A')).toBe('A');
  });
});

describe('sweepToRoots (the guards)', () => {
  test('sweeps when the roots anchor the graph', () => {
    const dag = twoFileDag();
    expect(sweepToRoots(dag, new Set(['C']))).toBe(2);
    expect(dag.size()).toBe(3);
  });

  test('declines on an empty root set rather than emptying the graph', () => {
    // A registry with no heads (fresh or just-rebuilt device) is not evidence that the
    // whole graph is garbage — and an emptied graph with a non-zero cursor is what
    // `dagNeedsRebuild` reads as corruption, answering with a full re-pull.
    const dag = twoFileDag();
    expect(sweepToRoots(dag, new Set())).toBe(0);
    expect(dag.size()).toBe(5);
  });

  test('declines when no root is present in the graph (stale snapshot / vault switch)', () => {
    const dag = twoFileDag();
    expect(sweepToRoots(dag, new Set(['someone-elses-head']))).toBe(0);
    expect(dag.size()).toBe(5);
  });

  test('declines on an already-empty graph', () => {
    expect(sweepToRoots(new VersionDag(), new Set(['C']))).toBe(0);
  });

  test('is idempotent — a second sweep finds nothing', () => {
    const dag = twoFileDag();
    expect(sweepToRoots(dag, new Set(['C']))).toBe(2);
    expect(sweepToRoots(dag, new Set(['C']))).toBe(0);
  });
});

describe('FileRegistry.versionRoots (what the vault still names)', () => {
  test('roots on live heads', async () => {
    const reg = await registryWith([
      entry({ id: 'f1', path: 'a.md', headVersionId: 'C' }),
      entry({ id: 'f2', path: 'b.md', headVersionId: 'Q' }),
    ]);
    expect(reg.versionRoots()).toEqual(new Set(['C', 'Q']));
  });

  test('roots on TOMBSTONED heads too — the base of a late delete/edit merge', async () => {
    // referencedHashes skips deleted entries (their bytes are collectable); the DAG must
    // not, or a peer's late edit to a file we deleted loses the base it merges against.
    const reg = await registryWith([
      entry({ id: 'f1', path: 'a.md', headVersionId: 'C' }),
      entry({ id: 'f2', path: 'gone.md', deleted: true, headVersionId: 'DEL' }),
    ]);
    expect(reg.versionRoots()).toEqual(new Set(['C', 'DEL']));
  });

  test('roots on BOTH open heads of a conflicted file', async () => {
    // While a file is two-headed the remote head is named nowhere else — the resolving
    // save re-emits it as the merge node's second parent, so it has to survive.
    const reg = await registryWith([
      entry({ id: 'f1', path: 'a.md', headVersionId: 'MINE', conflictParents: ['MINE', 'THEIRS'] }),
    ]);
    expect(reg.versionRoots()).toEqual(new Set(['MINE', 'THEIRS']));
  });

  test('an entry with no head contributes nothing', async () => {
    const reg = await registryWith([entry({ id: 'f1', path: 'a.md', headVersionId: null })]);
    expect(reg.versionRoots().size).toBe(0);
  });

  test('end to end: a reclaimed file\'s subgraph is swept, a tombstone\'s is not', async () => {
    const dag = twoFileDag();                    // f1: A→B→C, f2: X→Y
    dag.addVersion('DEL', ['Y'], 'hDel', 'f2');  // f2 was deleted but is still tombstoned
    const reg = await registryWith([
      entry({ id: 'f1', path: 'a.md', headVersionId: 'C' }),
      entry({ id: 'f2', path: 'gone.md', deleted: true, headVersionId: 'DEL' }),
      // f3 is absent from the registry entirely — reclaimed past the tombstone horizon.
    ]);
    dag.addVersion('G1', [], 'hG1', 'f3');
    dag.addVersion('G2', ['G1'], 'hG2', 'f3');

    expect(sweepToRoots(dag, reg.versionRoots())).toBe(2);   // G1, G2
    for (const kept of ['A', 'B', 'C', 'X', 'Y', 'DEL']) expect(dag.has(kept)).toBe(true);
    for (const gone of ['G1', 'G2']) expect(dag.has(gone)).toBe(false);
  });
});
