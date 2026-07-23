// ─────────────────────────────────────────────
//  Tests — Version DAG (sync v2)
// ─────────────────────────────────────────────
//
//  The pure content DAG (isAncestor / mergeBase / contentHashOf / persistence),
//  plus a round-level check that edges accumulate into the persisted store keyed
//  by op-id and survive a reload. Nodes are keyed by VERSION-ID (op-id), not the
//  content hash — content recurs, so a content-hash graph would cycle and break
//  LCA. Each node carries its `contentHash` as the blob address for the merge.

import { describe, test, expect, beforeAll } from 'vitest';
import { VersionDag, MULTIPLE_BASES } from '../src/core/version-dag';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

describe('VersionDag (pure structure)', () => {
  test('linear chain: isAncestor and mergeBase', () => {
    const dag = new VersionDag();
    dag.addVersion('A', [], 'hA', 'f1');
    dag.addVersion('B', ['A'], 'hB', 'f1');
    dag.addVersion('C', ['B'], 'hC', 'f1');

    expect(dag.isAncestor('A', 'C')).toBe(true);
    expect(dag.isAncestor('C', 'A')).toBe(false);
    expect(dag.isAncestor('C', 'C')).toBe(true);     // reflexive
    // A head that IS an ancestor of the other → the ancestor is the base (FF).
    expect(dag.mergeBase('A', 'C')).toBe('A');
    expect(dag.mergeBase('C', 'A')).toBe('A');        // order-independent
    // The node carries its content hash (the blob address the merge reads).
    expect(dag.contentHashOf('B')).toBe('hB');
    expect(dag.contentHashOf('nope')).toBeUndefined();
  });

  test('reachableContentHashes: every base along a head\'s history (for staging)', () => {
    const dag = new VersionDag();
    dag.addVersion('A', [], 'hA', 'f1');
    dag.addVersion('B', ['A'], 'hB', 'f1');
    dag.addVersion('C', ['B'], 'hC', 'f1');
    // The head C reaches its own bytes and every ancestor's — so buildLocalState can
    // stage a base (e.g. hA) that is deeper than the last-synced version.
    expect(dag.reachableContentHashes('C')).toEqual(new Set(['hA', 'hB', 'hC']));
    expect(dag.reachableContentHashes('B')).toEqual(new Set(['hA', 'hB'])); // not hC (a descendant)
    expect(dag.reachableContentHashes('nope')).toEqual(new Set());
  });

  test('fork: two children of one base → mergeBase is the base', () => {
    const dag = new VersionDag();
    dag.addVersion('O', [], 'hO', 'f1');
    dag.addVersion('X', ['O'], 'hX', 'f1');   // device A edited O → X
    dag.addVersion('Y', ['O'], 'hY', 'f1');   // device B edited O → Y (concurrent)
    expect(dag.mergeBase('X', 'Y')).toBe('O');
    expect(dag.isAncestor('X', 'Y')).toBe(false);
    expect(dag.isAncestor('Y', 'X')).toBe(false);
  });

  test('recurring content does NOT cycle (op-id identity): empty → 3 → empty', () => {
    // The reported case. Content recurs (hEmpty appears twice) but the op-ids are
    // distinct, so id_e2 is a clean DESCENDANT of id_3 — a fast-forward, not a
    // cycle. A content-hash-keyed DAG would instead make hEmpty its own ancestor.
    const dag = new VersionDag();
    dag.addVersion('id_e1', [], 'hEmpty', 'f1');
    dag.addVersion('id_3', ['id_e1'], 'h3', 'f1');
    dag.addVersion('id_e2', ['id_3'], 'hEmpty', 'f1');   // same bytes as id_e1
    expect(dag.isAncestor('id_3', 'id_e2')).toBe(true);  // clean FF, no cycle
    expect(dag.isAncestor('id_e2', 'id_3')).toBe(false);
    expect(dag.mergeBase('id_3', 'id_e2')).toBe('id_3'); // FF base is id_3
    expect(dag.contentHashOf('id_e2')).toBe('hEmpty');
  });

  test('unrelated versions share no ancestor → null', () => {
    const dag = new VersionDag();
    dag.addVersion('A', [], 'hA', 'f1');
    dag.addVersion('B', [], 'hB', 'f2');
    expect(dag.mergeBase('A', 'B')).toBeNull();
  });

  test('diamond (merge node with two parents): reachability and base', () => {
    const dag = new VersionDag();
    dag.addVersion('O', [], 'hO', 'f1');
    dag.addVersion('X', ['O'], 'hX', 'f1');
    dag.addVersion('Y', ['O'], 'hY', 'f1');
    dag.addVersion('M', ['X', 'Y'], 'hM', 'f1');   // reconciled both heads
    expect(dag.isAncestor('X', 'M')).toBe(true);
    expect(dag.isAncestor('Y', 'M')).toBe(true);
    expect(dag.isAncestor('O', 'M')).toBe(true);
    // Merged head vs. one of its parents → the parent is the base (FF to M).
    expect(dag.mergeBase('M', 'X')).toBe('X');
  });

  test('deep shared backbone, tip divergence → base is the tip, no O(common²) scan', () => {
    // The B2b topology (docs/mobile-perf-baseline-spec.md): both heads fast-forward
    // onto a deep SHARED chain, then diverge by one edit each — so `common` is the
    // whole backbone (large), the case the old pairwise-isAncestor filter blew up on.
    // The multi-source maximal-scan must still return the single deepest common node.
    const dag = new VersionDag();
    dag.addVersion('v0', [], 'h0', 'f1');
    let prev = 'v0';
    for (let i = 1; i <= 12; i++) {
      dag.addVersion(`v${i}`, [prev], `h${i}`, 'f1');   // linear backbone v0..v12
      prev = `v${i}`;
    }
    dag.addVersion('X', ['v12'], 'hX', 'f1');   // device A's tip edit off the backbone
    dag.addVersion('Y', ['v12'], 'hY', 'f1');   // device B's tip edit (concurrent)
    // common(X, Y) = {v0..v12}, but the LCA is the single deepest one: v12.
    expect(dag.mergeBase('X', 'Y')).toBe('v12');
    expect(dag.mergeBase('Y', 'X')).toBe('v12');   // order-independent
    expect(dag.isAncestor('X', 'Y')).toBe(false);
  });

  test('criss-cross: two incomparable common ancestors → MULTIPLE', () => {
    const dag = new VersionDag();
    dag.addVersion('P', [], 'hP', 'f1');
    dag.addVersion('Q', [], 'hQ', 'f1');
    // Two heads that each descend from BOTH P and Q, with no single LCA.
    dag.addVersion('L', ['P', 'Q'], 'hL', 'f1');
    dag.addVersion('R', ['P', 'Q'], 'hR', 'f1');
    expect(dag.mergeBase('L', 'R')).toBe(MULTIPLE_BASES);
  });

  test('cycle-safety: a back-edge does not hang', () => {
    const dag = new VersionDag();
    dag.addVersion('A', ['B'], 'hA', 'f1');
    dag.addVersion('B', ['A'], 'hB', 'f1');   // pathological cycle
    expect(dag.isAncestor('A', 'B')).toBe(true);
    expect(() => dag.mergeBase('A', 'B')).not.toThrow();
  });

  test('addVersion is idempotent and unions parents; ignores self-parent', () => {
    const dag = new VersionDag();
    dag.addVersion('M', ['X'], 'hM', 'f1');
    dag.addVersion('M', ['Y'], 'hM', 'f1');   // second parent learned later
    dag.addVersion('M', ['M'], 'hM', 'f1');   // self-parent ignored
    expect(dag.isAncestor('X', 'M')).toBe(true);
    expect(dag.isAncestor('Y', 'M')).toBe(true);
    expect(dag.isAncestor('M', 'M')).toBe(true);
  });

  test('a parent-only stub backfills its content hash when its own edge arrives', () => {
    const dag = new VersionDag();
    dag.addVersion('child', ['parent'], 'hChild', 'f1'); // 'parent' referenced, no hash yet
    expect(dag.contentHashOf('parent')).toBeUndefined();
    dag.addVersion('parent', [], 'hParent', 'f1');       // its real edge arrives
    expect(dag.contentHashOf('parent')).toBe('hParent');
    expect(dag.isAncestor('parent', 'child')).toBe(true);
  });

  test('clone equals the original by toJSON, and mutating the clone does not touch it', () => {
    const dag = new VersionDag();
    dag.addVersion('O', [], 'hO', 'f1');
    dag.addVersion('X', ['O'], 'hX', 'f1');
    dag.addVersion('M', ['X', 'O'], 'hM', 'f1');   // a two-parent merge node

    const copy = dag.clone();
    // A faithful copy: identical serialized graph.
    expect(copy.toJSON()).toEqual(dag.toJSON());
    expect(copy.mergeBase('X', 'O')).toBe('O');
    expect(copy.contentHashOf('M')).toBe('hM');

    // Mutating the clone — adding a new node AND a new parent to an *existing*
    // node (the parent-Set aliasing check) — must not leak into the original.
    copy.addVersion('N', ['M'], 'hN', 'f1');        // new node reachable only in the clone
    copy.addVersion('M', ['Z'], 'hM', 'f1');        // new parent on a shared node
    expect(dag.has('N')).toBe(false);               // node isolation
    expect(dag.isAncestor('Z', 'M')).toBe(false);   // parent-Set isolation (no aliasing)
    // The clone did take the mutations.
    expect(copy.has('N')).toBe(true);
    expect(copy.isAncestor('Z', 'M')).toBe(true);

    // And the reverse: mutating the original leaves the clone alone.
    dag.addVersion('W', ['O'], 'hW', 'f1');
    expect(copy.has('W')).toBe(false);
  });

  test('JSON round-trip preserves the graph and content hashes', () => {
    const dag = new VersionDag();
    dag.addVersion('O', [], 'hO', 'f1');
    dag.addVersion('X', ['O'], 'hX', 'f1');
    dag.addVersion('M', ['X', 'O'], 'hM', 'f1');
    const restored = VersionDag.fromJSON(JSON.parse(JSON.stringify(dag.toJSON())));
    expect(restored.isAncestor('O', 'M')).toBe(true);
    expect(restored.isAncestor('X', 'M')).toBe(true);
    expect(restored.mergeBase('X', 'O')).toBe('O');
    expect(restored.contentHashOf('X')).toBe('hX');
  });

  test('fromJSON tolerates a malformed blob', () => {
    expect(() => VersionDag.fromJSON(null)).not.toThrow();
    expect(() => VersionDag.fromJSON('garbage')).not.toThrow();
    expect(VersionDag.fromJSON({ H: { parents: 'nope' } }).has('H')).toBe(true);
  });
});

describe('version-DAG accumulation across a round (keyed by op-id)', () => {
  const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('a round records authored edges keyed by op-id, surviving reload', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    const id = await A.seedFile('n.md', 'hello\n', 1000);
    const createVersion = A.entry(id)!.headVersionId!;   // the create op's id
    const createdHash = A.entry(id)!.contentHash;
    await client(api, A).runSync();                       // pushes create; records its edge

    // Edit → a real parent edge (the update op's parent is the create op-id).
    await A.editFile('n.md', 'world\n', 2000);
    const editVersion = A.entry(id)!.headVersionId!;      // the update op's id
    const editedHash = A.entry(id)!.contentHash;
    await client(api, A).runSync();

    const dag = await A.versionDagStore.load();
    expect(dag.has(createVersion)).toBe(true);
    expect(dag.has(editVersion)).toBe(true);
    expect(dag.isAncestor(createVersion, editVersion)).toBe(true);   // the update recorded its base
    // Each node carries its content hash (the blob address the merge reads).
    expect(dag.contentHashOf(createVersion)).toBe(createdHash);
    expect(dag.contentHashOf(editVersion)).toBe(editedHash);

    // The graph is durable across a plugin restart.
    const A2 = await A.reload();
    const dag2 = await A2.versionDagStore.load();
    expect(dag2.isAncestor(createVersion, editVersion)).toBe(true);
    expect(dag2.contentHashOf(editVersion)).toBe(editedHash);
  });
});
