// ─────────────────────────────────────────────
//  Tests — Version DAG (sync v2, Step 2a)
// ─────────────────────────────────────────────
//
//  The pure content DAG (isAncestor / mergeBase / persistence), plus a round-level
//  check that edges accumulate into the persisted store and survive a reload. The
//  DAG is not yet read for merging (Step 2b), so these assert structure, not merge
//  behaviour.

import { describe, test, expect, beforeAll } from 'vitest';
import { VersionDag, MULTIPLE_BASES } from '../src/core/version-dag';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

describe('VersionDag (pure structure)', () => {
  test('linear chain: isAncestor and mergeBase', () => {
    const dag = new VersionDag();
    dag.addVersion('A', [], 'f1');
    dag.addVersion('B', ['A'], 'f1');
    dag.addVersion('C', ['B'], 'f1');

    expect(dag.isAncestor('A', 'C')).toBe(true);
    expect(dag.isAncestor('C', 'A')).toBe(false);
    expect(dag.isAncestor('C', 'C')).toBe(true);     // reflexive
    // A head that IS an ancestor of the other → the ancestor is the base (FF).
    expect(dag.mergeBase('A', 'C')).toBe('A');
    expect(dag.mergeBase('C', 'A')).toBe('A');        // order-independent
  });

  test('fork: two children of one base → mergeBase is the base', () => {
    const dag = new VersionDag();
    dag.addVersion('O', [], 'f1');
    dag.addVersion('X', ['O'], 'f1');   // device A edited O → X
    dag.addVersion('Y', ['O'], 'f1');   // device B edited O → Y (concurrent)
    expect(dag.mergeBase('X', 'Y')).toBe('O');
    expect(dag.isAncestor('X', 'Y')).toBe(false);
    expect(dag.isAncestor('Y', 'X')).toBe(false);
  });

  test('unrelated versions share no ancestor → null', () => {
    const dag = new VersionDag();
    dag.addVersion('A', [], 'f1');
    dag.addVersion('B', [], 'f2');
    expect(dag.mergeBase('A', 'B')).toBeNull();
  });

  test('diamond (merge node with two parents): reachability and base', () => {
    const dag = new VersionDag();
    dag.addVersion('O', [], 'f1');
    dag.addVersion('X', ['O'], 'f1');
    dag.addVersion('Y', ['O'], 'f1');
    dag.addVersion('M', ['X', 'Y'], 'f1');   // reconciled both heads
    expect(dag.isAncestor('X', 'M')).toBe(true);
    expect(dag.isAncestor('Y', 'M')).toBe(true);
    expect(dag.isAncestor('O', 'M')).toBe(true);
    // Merged head vs. one of its parents → the parent is the base (FF to M).
    expect(dag.mergeBase('M', 'X')).toBe('X');
  });

  test('criss-cross: two incomparable common ancestors → MULTIPLE', () => {
    const dag = new VersionDag();
    dag.addVersion('P', [], 'f1');
    dag.addVersion('Q', [], 'f1');
    // Two heads that each descend from BOTH P and Q, with no single LCA.
    dag.addVersion('L', ['P', 'Q'], 'f1');
    dag.addVersion('R', ['P', 'Q'], 'f1');
    expect(dag.mergeBase('L', 'R')).toBe(MULTIPLE_BASES);
  });

  test('cycle-safety: a back-edge does not hang', () => {
    const dag = new VersionDag();
    dag.addVersion('A', ['B'], 'f1');
    dag.addVersion('B', ['A'], 'f1');   // pathological cycle
    expect(dag.isAncestor('A', 'B')).toBe(true);
    expect(() => dag.mergeBase('A', 'B')).not.toThrow();
  });

  test('addVersion is idempotent and unions parents; ignores self-parent', () => {
    const dag = new VersionDag();
    dag.addVersion('M', ['X'], 'f1');
    dag.addVersion('M', ['Y'], 'f1');   // second parent learned later
    dag.addVersion('M', ['M'], 'f1');   // self-parent ignored
    expect(dag.isAncestor('X', 'M')).toBe(true);
    expect(dag.isAncestor('Y', 'M')).toBe(true);
    expect(dag.isAncestor('M', 'M')).toBe(true);
  });

  test('JSON round-trip preserves the graph', () => {
    const dag = new VersionDag();
    dag.addVersion('O', [], 'f1');
    dag.addVersion('X', ['O'], 'f1');
    dag.addVersion('M', ['X', 'O'], 'f1');
    const restored = VersionDag.fromJSON(JSON.parse(JSON.stringify(dag.toJSON())));
    expect(restored.isAncestor('O', 'M')).toBe(true);
    expect(restored.isAncestor('X', 'M')).toBe(true);
    expect(restored.mergeBase('X', 'O')).toBe('O');
  });

  test('fromJSON tolerates a malformed blob', () => {
    expect(() => VersionDag.fromJSON(null)).not.toThrow();
    expect(() => VersionDag.fromJSON('garbage')).not.toThrow();
    expect(VersionDag.fromJSON({ H: { parents: 'nope' } }).has('H')).toBe(true);
  });
});

describe('version-DAG accumulation across a round (Step 2a wiring)', () => {
  const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('a round records authored edges into the persisted DAG, surviving reload', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');

    const id = await A.seedFile('n.md', 'hello\n', 1000);
    const created = A.entry(id)!.contentHash;
    await client(api, A).runSync();                  // pushes create; records its edge

    // Edit → a real parent edge (newHash's parent is the created hash).
    await A.editFile('n.md', 'world\n', 2000);
    const edited = A.entry(id)!.contentHash;
    await client(api, A).runSync();

    const dag = await A.versionDagStore.load();
    expect(dag.has(created)).toBe(true);
    expect(dag.has(edited)).toBe(true);
    expect(dag.isAncestor(created, edited)).toBe(true);   // the update recorded its base

    // The graph is durable across a plugin restart.
    const A2 = await A.reload();
    const dag2 = await A2.versionDagStore.load();
    expect(dag2.isAncestor(created, edited)).toBe(true);
  });
});
