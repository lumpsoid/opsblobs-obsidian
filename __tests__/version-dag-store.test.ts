// ─────────────────────────────────────────────
//  VersionDagStore — snapshot + append-only journal persistence
// ─────────────────────────────────────────────
//
//  The DAG persists as a compacted snapshot (`version-dag.json`) plus an
//  append-only JSONL journal (`version-dag.log`) of edges recorded since, so a
//  round writes only its new edges (O(delta)) instead of rewriting the whole graph
//  every round. These pin the persistence mechanics directly over the fake store:
//  load = snapshot ⊕ journal, compaction folds + clears, old single-file installs
//  still load, and a torn trailing append is tolerated.

import { describe, test, expect } from 'vitest';
import { VersionDagStore } from '../src/network/version-dag-store';
import { VersionDag } from '../src/core/version-dag';
import { Operation } from '../src/types';
import { TestDevice } from './helpers/test-device';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const SNAPSHOT = '.vault-sync/version-dag.json';
const JOURNAL = '.vault-sync/version-dag.log';

/** Record edges the way the host does: add to the in-memory DAG, journal only the
 *  ones that actually changed it. Returns the DAG so a test can assert topology. */
async function record(store: VersionDagStore, dag: VersionDag, edges: [string, string[], string, string][]): Promise<void> {
  const fresh = edges
    .filter(([v, p, c, f]) => dag.addVersion(v, p, c, f)) // mutates dag; keeps genuinely-new edges
    .map(([v, p, c, f]) => ({ v, p, c, f }));
  await store.appendEdges(fresh);
}

describe('VersionDagStore: snapshot + journal', () => {
  test('appended edges are journaled and replayed on load (no snapshot yet)', async () => {
    const md = new FakeMetadataStore();
    const store = new VersionDagStore(md);
    const dag = new VersionDag();

    await record(store, dag, [
      ['A', [], 'hA', 'f1'],
      ['B', ['A'], 'hB', 'f1'],
    ]);

    // Nothing compacted yet → the journal holds the edges, no snapshot exists.
    expect(md.has(JOURNAL)).toBe(true);
    expect(md.has(SNAPSHOT)).toBe(false);

    const loaded = await store.load();
    expect(loaded.has('A')).toBe(true);
    expect(loaded.has('B')).toBe(true);
    expect(loaded.contentHashOf('B')).toBe('hB');
    expect(loaded.isAncestor('A', 'B')).toBe(true);
    expect(loaded.size()).toBe(2);
  });

  test('re-recording a known edge journals nothing (no unbounded growth)', async () => {
    const md = new FakeMetadataStore();
    const store = new VersionDagStore(md);
    const dag = new VersionDag();

    await record(store, dag, [['A', [], 'hA', 'f1']]);
    const afterFirst = (await md.read(JOURNAL))!;

    // Re-record the same edge (as happens when our own op re-pulls every round).
    await record(store, dag, [['A', [], 'hA', 'f1']]);
    const afterSecond = (await md.read(JOURNAL))!;

    expect(afterSecond).toBe(afterFirst); // journal did not grow
  });

  test('compaction folds the journal into a fresh snapshot and clears it', async () => {
    const md = new FakeMetadataStore();
    const store = new VersionDagStore(md);
    const dag = new VersionDag();

    await record(store, dag, [
      ['A', [], 'hA', 'f1'],
      ['B', ['A'], 'hB', 'f1'],
    ]);
    await store.compact(dag);

    expect(md.has(SNAPSHOT)).toBe(true);
    expect(md.has(JOURNAL)).toBe(false); // journal cleared

    // Post-compaction, new edges append to a fresh journal on top of the snapshot.
    await record(store, dag, [['C', ['B'], 'hC', 'f1']]);
    expect(md.has(JOURNAL)).toBe(true);

    const loaded = await store.load();
    for (const id of ['A', 'B', 'C']) expect(loaded.has(id)).toBe(true);
    expect(loaded.isAncestor('A', 'C')).toBe(true);
    expect(loaded.size()).toBe(3);
  });

  test('an old single-file (snapshot-only) install loads unchanged', async () => {
    const md = new FakeMetadataStore();
    // Pre-journal format: the whole graph as one version-dag.json, no journal.
    const legacy = new VersionDag();
    legacy.addVersion('A', [], 'hA', 'f1');
    legacy.addVersion('B', ['A'], 'hB', 'f1');
    md.set(SNAPSHOT, JSON.stringify(legacy.toJSON()));

    const store = new VersionDagStore(md);
    const loaded = await store.load();
    expect(loaded.has('B')).toBe(true);
    expect(loaded.isAncestor('A', 'B')).toBe(true);
    expect(loaded.size()).toBe(2);
  });

  test('a torn trailing journal line is skipped; earlier edges survive', async () => {
    const md = new FakeMetadataStore();
    const store = new VersionDagStore(md);
    const dag = new VersionDag();

    await record(store, dag, [
      ['A', [], 'hA', 'f1'],
      ['B', ['A'], 'hB', 'f1'],
    ]);
    // Simulate a crash mid-append: a partial, unparseable final line with no newline.
    await md.append(JOURNAL, '{"v":"C","p":["B"],"c":"hC"'); // truncated JSON

    const loaded = await store.load();
    expect(loaded.has('A')).toBe(true);
    expect(loaded.has('B')).toBe(true);
    expect(loaded.has('C')).toBe(false); // torn line dropped, not fatal
    expect(loaded.size()).toBe(2);
  });

  test('missing snapshot and journal → empty DAG', async () => {
    const store = new VersionDagStore(new FakeMetadataStore());
    expect((await store.load()).size()).toBe(0);
  });
});

describe('VersionDagStore: auto-compaction (deferred coverage)', () => {
  // ── DEFERRED (test.skip): auto-compaction fired from inside the round path ──────
  //
  // COVERAGE GAP. `recordVersionEdges` (vault-sync-host.ts) appends the round's new
  // edges, then calls `shouldCompact()` and, once past the threshold, `compact()`.
  // The three store primitives are each unit-tested above (append→load, compact
  // folds+clears, load tolerates a torn line). What is NOT exercised end-to-end is
  // the *wiring* that triggers compaction automatically inside a real round — it
  // takes COMPACT_THRESHOLD (500) genuinely-new edges to cross, and that constant is
  // module-private, so a test asserting it would hardcode-couple to `500`.
  //
  // WHY DEFERRED, not written now. The clean, non-brittle way to prove this cheaply
  // is a `compactThreshold` injection on VersionDagStore (a constructor option), so
  // the test can set it to e.g. 3 rather than manufacturing 500 edges and pinning a
  // constant that may change. That hook does not exist yet. Priority is low:
  // `compact()` and its precondition are individually covered; only their
  // auto-invocation in `recordVersionEdges` is unproven, and that wiring is three
  // visible lines. When the hook lands: add it, un-skip below, and drop COUNT to a
  // handful with the injected threshold.
  //
  // WHAT IT ASSERTS. After recording more edges than the threshold through the real
  // host, the journal has been folded into the snapshot and cleared, and `load()`
  // still reconstructs every edge (compaction loses nothing).
  test.skip('recordVersionEdges auto-compacts once the journal crosses the threshold', async () => {
    const device = await TestDevice.create('dev-a');
    const COUNT = 501; // > COMPACT_THRESHOLD (500) — the coupling a compactThreshold hook removes

    // Synthetic disconnected edges (each its own DAG root) — this test cares about
    // persistence/compaction plumbing, not merge topology, so it drives
    // recordVersionEdges directly rather than through the user-action helpers.
    const ops: Operation[] = Array.from({ length: COUNT }, (_, i) => ({
      v: 1,
      id: `op-${i}`,
      hlcTimestamp: { wallTime: i + 1, counter: 0, deviceId: 'dev-a' },
      fileId: `file-${i}`,
      type: 'update',
      path: `note-${i}.md`,
      contentHash: `hash-${i}`,
      parents: [],
    }));

    await device.host.recordVersionEdges(ops);

    // Crossed the threshold → the journal was folded into the snapshot and cleared.
    expect(device.metadata.has('.vault-sync/version-dag.json')).toBe(true);
    expect(device.metadata.has('.vault-sync/version-dag.log')).toBe(false);

    // …and every recorded edge survives the compaction.
    const dag = await device.versionDagStore.load();
    expect(dag.size()).toBe(COUNT);
    expect(dag.has(`op-${COUNT - 1}`)).toBe(true);
  });
});
