// ─────────────────────────────────────────────
//  Bounded version-DAG ancestor walk (over-time degradation, perf)
// ─────────────────────────────────────────────
//
//  `VersionDag.reachableContentHashes` used to walk a head's COMPLETE ancestor chain —
//  one node per version that file has ever had. Two hot callers walk it: `stageForFiles`
//  (every sync round, for every file the round touches, each reachable hash then costing
//  a content-store probe in `stageContent`) and `FileRegistry.referencedHashes` (once per
//  live entry, to build the GC keep-set). So both grew linearly with per-file edit
//  history, forever — though a merge can use at most ONE of those versions (the LCA) and
//  everything past the retention horizon has had its bytes collected and can never be
//  staged at all.
//
//  The walk now takes `bounds`: `has` cuts a branch at the first ancestor whose bytes are
//  gone, `maxDepth` caps generations. These tests pin both halves:
//    · the pure walk — O(retained) nodes, not O(history), with the boundary hash still
//      returned and the start version always expanded;
//    · the real device stack — a puller (which holds only the head's blob, never the
//      1000 bases behind it) stages a small constant regardless of history depth, and
//      still three-way merges a concurrent edit exactly as before.

import { describe, test, expect, beforeAll } from 'vitest';
import { VersionDag } from '../src/core/version-dag';
import { FileRegistry } from '../src/core/file-registry';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';
import { FileEntry, HLC, SyncSettings, VaultState } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';

/** A linear chain v0 → v1 → … → v(n-1), version `vI` carrying content hash `hI`. */
function chain(n: number): VersionDag {
  const dag = new VersionDag();
  for (let i = 0; i < n; i++) {
    dag.addVersion(`v${i}`, i === 0 ? [] : [`v${i - 1}`], `h${i}`, 'f1');
  }
  return dag;
}

/** A `bounds.has` over `stored` that counts how many nodes the walk probed — the
 *  proxy for "how many nodes did it visit past the head". */
function countingHas(stored: Set<string>): { has: (h: string) => boolean; calls: () => number } {
  let calls = 0;
  return { has: (h: string) => { calls++; return stored.has(h); }, calls: () => calls };
}

describe('VersionDag.reachableContentHashes — bounded walk', () => {
  const N = 1000;   // a note edited a thousand times
  const K = 5;      // …of which only the newest few still have bytes

  test('unbounded (no bounds) is unchanged: the complete chain', () => {
    const dag = chain(N);
    const all = dag.reachableContentHashes(`v${N - 1}`);
    expect(all.size).toBe(N);
    expect(all.has('h0')).toBe(true);
    expect(all.has(`h${N - 1}`)).toBe(true);
  });

  test('a chain of N with only the newest K stored visits O(K) nodes, not O(N)', () => {
    const dag = chain(N);
    const stored = new Set<string>();
    for (let i = N - K; i < N; i++) stored.add(`h${i}`);
    const probe = countingHas(stored);

    const reached = dag.reachableContentHashes(`v${N - 1}`, { has: probe.has });

    // The K stored versions PLUS the first unstored one (the boundary is returned; only
    // the walk *past* it is cut) — and nothing deeper.
    const expected = new Set<string>([`h${N - K - 1}`]);
    for (let i = N - K; i < N; i++) expected.add(`h${i}`);
    expect(reached).toEqual(expected);
    expect(reached.size).toBe(K + 1);
    expect(reached.has(`h${N - K - 2}`)).toBe(false);   // one deeper: never touched
    expect(reached.has('h0')).toBe(false);              // the far tail: never touched

    // The whole point: node visits scale with what is RETAINED, not with history.
    expect(probe.calls()).toBeLessThanOrEqual(K + 1);
    expect(probe.calls()).toBeLessThan(N / 10);
  });

  test('the boundary hash is still returned, so a caller\'s own fallback still sees it', () => {
    // `stageContent` can serve a hash from a live entry's PATH when the store misses it.
    // Cutting the walk must not hide that hash from it — only strictly-older ones.
    const dag = chain(4);                                  // v0..v3
    const reached = dag.reachableContentHashes('v3', { has: h => h === 'h3' });
    expect(reached).toEqual(new Set(['h3', 'h2']));         // h2 = boundary, h1/h0 cut
  });

  test('a head whose own bytes are missing does NOT collapse its ancestor set', () => {
    // A live head's bytes may not be in the store yet (an un-opped in-window edit).
    // Pruning at the START version would hand GC an empty keep-set for that file and
    // let it delete every base — so the start version is always expanded.
    const dag = chain(10);
    const reached = dag.reachableContentHashes('v9', { has: h => h !== 'h9' });
    expect(reached.size).toBe(10);                          // h9 (start) + h8..h0
    expect(reached.has('h0')).toBe(true);
  });

  test('maxDepth caps generations above the start version', () => {
    const dag = chain(50);
    expect(dag.reachableContentHashes('v49', { maxDepth: 0 })).toEqual(new Set(['h49']));
    expect(dag.reachableContentHashes('v49', { maxDepth: 2 })).toEqual(new Set(['h49', 'h48', 'h47']));
    // A cap deeper than the chain is simply the whole chain.
    expect(dag.reachableContentHashes('v49', { maxDepth: 999 }).size).toBe(50);
  });

  test('branches are cut independently — a stored branch survives an unstored sibling', () => {
    // M is a merge node: parent P still has bytes (and its base O behind it), parent Q
    // does not. Cutting Q must not cut P.
    const dag = new VersionDag();
    dag.addVersion('O', [], 'hO', 'f1');
    dag.addVersion('P', ['O'], 'hP', 'f1');
    dag.addVersion('Q', ['O'], 'hQ', 'f1');
    dag.addVersion('Qold', [], 'hQold', 'f1');
    dag.addVersion('Q2', ['Q', 'Qold'], 'hQ2', 'f1');
    dag.addVersion('M', ['P', 'Q2'], 'hM', 'f1');
    const stored = new Set(['hM', 'hP', 'hO']);

    const reached = dag.reachableContentHashes('M', { has: h => stored.has(h) });

    expect(reached.has('hP')).toBe(true);
    expect(reached.has('hO')).toBe(true);      // reached via the stored P branch
    expect(reached.has('hQ2')).toBe(true);     // the cut branch's boundary
    expect(reached.has('hQ')).toBe(false);     // …but nothing past it
    expect(reached.has('hQold')).toBe(false);
  });

  test('a cycle-shaped graph still terminates under bounds', () => {
    // Op-ids are HLC-monotonic so this cannot arise, but the walk stays cycle-safe.
    const dag = new VersionDag();
    dag.addVersion('A', ['B'], 'hA', 'f1');
    dag.addVersion('B', ['A'], 'hB', 'f1');
    expect(dag.reachableContentHashes('A', { has: () => true })).toEqual(new Set(['hA', 'hB']));
  });
});

// ─── The GC keep-set ─────────────────────────────────────────────────────────

const REGISTRY_PATH = '.opsblobs/file-registry.json';
const hlc: HLC = { wallTime: 1, counter: 0, deviceId: 'dev' };

async function registryWith(entries: FileEntry[]): Promise<FileRegistry> {
  const meta = new FakeMetadataStore();
  meta.set(REGISTRY_PATH, JSON.stringify({ version: 1, entries: entries.map(e => [e.id, e]) }));
  const reg = new FileRegistry(meta, new FakeVaultFiles(), 'dev', () => ({}) as SyncSettings);
  await reg.load();
  return reg;
}

describe('FileRegistry.referencedHashes — bounded keep-set', () => {
  test('loses no hash the store actually holds (GC can only delete what it holds)', async () => {
    const N = 300, K = 4;
    const dag = chain(N);
    const reg = await registryWith([{
      id: 'a', path: 'n.md', contentHash: `h${N - 1}`, headVersionId: `v${N - 1}`,
      hlcTimestamp: hlc, deleted: false,
    }]);
    const stored = new Set<string>();
    for (let i = N - K; i < N; i++) stored.add(`h${i}`);

    const bounded = reg.referencedHashes(dag, { has: h => stored.has(h) });
    const unbounded = reg.referencedHashes(dag);

    // The safety property: every STORED hash the unbounded keep-set retained is still
    // retained. What the bounded walk drops is hashes GC could never have deleted.
    for (const h of unbounded) if (stored.has(h)) expect(bounded.has(h)).toBe(true);
    expect([...stored].every(h => bounded.has(h))).toBe(true);
    // …and it is dramatically smaller than the full history.
    expect(unbounded.size).toBe(N);
    expect(bounded.size).toBe(K + 1);
  });

  test('a live entry\'s current content is kept even when the store does not hold it', async () => {
    // The un-opped in-window edit again: its bytes aren't packed yet, but the entry
    // references them, so they must never be collectable.
    const dag = chain(20);
    const reg = await registryWith([{
      id: 'a', path: 'n.md', contentHash: 'h19', headVersionId: 'v19',
      hlcTimestamp: hlc, deleted: false,
    }]);
    const keep = reg.referencedHashes(dag, { has: () => false });
    expect(keep.has('h19')).toBe(true);
    expect(keep.has('h18')).toBe(true);   // start version always expanded → boundary kept
    expect(keep.has('h17')).toBe(false);
  });

  test('with no bounds the keep-set is unchanged (whole reachable ancestry)', async () => {
    const dag = chain(20);
    const reg = await registryWith([{
      id: 'a', path: 'n.md', contentHash: 'h19', headVersionId: 'v19',
      hlcTimestamp: hlc, deleted: false,
    }]);
    expect(reg.referencedHashes(dag).size).toBe(20);
  });
});

// ─── The real round (TestDevice over the production stack) ───────────────────

const SALT = new Uint8Array([4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1]);
const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

/** Sum the sizes of the hash-sets `host.stageContent` is asked to stage. */
function spyStageContent(d: TestDevice): { total: () => number } {
  const calls: number[] = [];
  const orig = d.host.stageContent.bind(d.host);
  d.host.stageContent = async (state: VaultState, hashes: Iterable<string>): Promise<void> => {
    const arr = [...hashes];
    calls.push(arr.length);
    return orig(state, arr);
  };
  return { total: () => calls.reduce((a, b) => a + b, 0) };
}

describe('stageForFiles — round cost does not grow with edit history', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('bounded-walk-test', SALT);
  });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  /**
   * A has edited one note `depth` times; B pulls that whole history (so B's DAG holds
   * `depth` ancestor nodes) but only ever downloads the head's blob — the bases behind
   * it have no bytes on B. Then A and B edit different lines concurrently and B
   * reconciles. Returns how many hashes B's round asked to stage, plus B's merged file.
   */
  const pullDeepHistoryAndMerge = async (depth: number): Promise<{ staged: number; merged: string }> => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create(`bw-a-${depth}`);
    const B = await TestDevice.create(`bw-b-${depth}`);

    await A.seedFile('n.md', 'L1\nL2\nL3\n', 1000);
    for (let i = 0; i < depth; i++) {
      await A.editFile('n.md', `L1\nL2\nL3\nrev ${i}\n`, 1100 + i);
    }
    await client(api, A).runSync();     // A pushes the whole chain
    await client(api, B).runSync();     // B pulls it — head blob only

    // Concurrent edits to different lines of the deeply-versioned note.
    await A.editFile('n.md', `A-EDIT\nL2\nL3\nrev ${depth - 1}\n`, 8000);
    await B.editFile('n.md', `L1\nL2\nB-EDIT\nrev ${depth - 1}\n`, 8500);
    await client(api, A).runSync();     // A pushes its head first

    const spy = spyStageContent(B);
    await client(api, B).runSync();     // B reconciles against A's head

    return { staged: spy.total(), merged: await onDisk(B, 'n.md') };
  };

  test('an 80-deep history stages the same number of hashes as a 5-deep one', async () => {
    const shallow = await pullDeepHistoryAndMerge(5);
    const deep = await pullDeepHistoryAndMerge(80);

    // ← the fix: 16× the history, identical staging. Unbounded, `deep` would have
    // asked for ~80 more hashes (one content-store probe each) than `shallow`.
    expect(deep.staged).toBe(shallow.staged);
    expect(deep.staged).toBeLessThan(10);

    // …and the merge outcome is unchanged: both sides' edits land, no conflict, because
    // the base the merge actually needs (the shared head, whose bytes B holds) is still
    // staged. A "stages nothing" that also merged nothing would fail here.
    for (const merged of [shallow.merged, deep.merged]) {
      expect(merged).toContain('A-EDIT');
      expect(merged).toContain('B-EDIT');
      expect(merged).not.toContain('<<<<<<<');
    }
  });
});
