// ─────────────────────────────────────────────
//  Tests — ContentStore.gc (age-aware retention, pack-only)
// ─────────────────────────────────────────────
//
//  Drives the real ContentStore over a FakeMetadataStore (no obsidian stub). Packs
//  are the sole format: each seeded blob is written by `put` into its own 1-blob pack,
//  and age is taken at PACK granularity (`stat(pack).mtime`) — set directly on the fake
//  so the retention window is deterministic. Retention keeps referenced blobs always and
//  young unreferenced ones; whole-pack retirement drops an aged, fully-dead pack. (Mixed
//  aged packs and mark-and-compact are exercised in content-store-pack.test.ts.)

import { describe, test, expect } from 'vitest';
import { ContentStore, hashContent } from '../src/core/content-store';
import { FileRegistry } from '../src/core/file-registry';
import { VersionDag } from '../src/core/version-dag';
import { FileEntry, HLC, SyncSettings } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';

const PACK0 = '.opsblobs/content/pack/0.pack';
const DAY = 86_400_000;
const NOW = 1_000_000_000_000; // fixed injected clock

/** A fresh, device-semantics store. */
async function fresh(): Promise<{ meta: FakeMetadataStore; store: ContentStore }> {
  const meta = new FakeMetadataStore();
  meta.listMode = 'one-level';
  const store = new ContentStore(meta);
  await store.init();
  return { meta, store };
}

/** Seed one blob into its own fresh 1-blob pack (via the real `put`), then age that
 *  pack. Packs are numbered 0,1,2… in call order, so the returned seeder tracks the id
 *  and sets the pack's mtime — letting a test control retention deterministically. The
 *  `hash` may be an arbitrary label: `put` stores bytes under whatever key it is given,
 *  and retention keys off `keepHashes`/index membership, never a content re-hash. */
function packSeeder(store: ContentStore, meta: FakeMetadataStore) {
  let seq = 0;
  return async (hash: string, data: string, mtime: number): Promise<void> => {
    await store.put(hash, new TextEncoder().encode(data));
    meta.setMtime(`.opsblobs/content/pack/${seq++}.pack`, mtime);
  };
}

describe('ContentStore.gc — age-aware retention (pack granularity)', () => {
  test('keeps referenced hashes always, keeps young unreferenced, deletes old unreferenced', async () => {
    const { meta, store } = await fresh();
    const seed = packSeeder(store, meta);
    await seed('a0refold', 'A', NOW - 100 * DAY); // referenced + ancient → kept (reference wins)
    await seed('b1young', 'B', NOW - 5 * DAY);    // unreferenced + within window → kept
    await seed('c2old', 'C', NOW - 40 * DAY);     // unreferenced + older than window → dropped

    await store.gc(new Set(['a0refold']), 30 * DAY, NOW);

    expect(await store.has('a0refold')).toBe(true);
    expect(await store.has('b1young')).toBe(true);
    expect(await store.has('c2old')).toBe(false);
  });

  // ── Sync v2, Step 8: a DAG-reachable merge base survives GC even when ancient ──
  test('retains an ancient three-way merge base reachable from a live head (DAG keep-set)', async () => {
    const { meta, store } = await fresh();
    const seed = packSeeder(store, meta);
    // The live head bytes (young) and its ANCIENT base — deeper than the retention
    // window. Without the DAG-aware keep-set the base would be GC'd, degrading a future
    // deep merge to a conflict. An unrelated, unreachable ancient blob still ages out.
    await seed('aahead', 'current', NOW - 1 * DAY);
    await seed('bbbase', 'original', NOW - 100 * DAY);
    await seed('cforphan', 'dead', NOW - 100 * DAY);

    // A real registry with one live file whose head descends from bbbase.
    const REGISTRY_PATH = '.opsblobs/file-registry.json';
    const hlc: HLC = { wallTime: 1, counter: 0, deviceId: 'dev' };
    const live: FileEntry = {
      id: 'a', path: 'note.md', contentHash: 'aahead', hlcTimestamp: hlc,
      deleted: false, headVersionId: 'v-head',
    };
    meta.set(REGISTRY_PATH, JSON.stringify({ version: 1, entries: [['a', live]] }));
    const reg = new FileRegistry(meta, new FakeVaultFiles(), 'dev', (() => ({}) as SyncSettings));
    await reg.load();

    const dag = new VersionDag();
    dag.addVersion('v-base', [], 'bbbase', 'a');
    dag.addVersion('v-head', ['v-base'], 'aahead', 'a');

    await store.gc(reg.referencedHashes(dag), 30 * DAY, NOW);

    expect(await store.has('aahead')).toBe(true);   // live content
    expect(await store.has('bbbase')).toBe(true);   // reachable base — kept despite age
    expect(await store.has('cforphan')).toBe(false); // unreachable + old → dropped
  });

  test('keeps an unreferenced blob when its pack mtime is undatable (stat returns null)', async () => {
    const { meta, store } = await fresh();
    const seed = packSeeder(store, meta);
    await seed('dedateless', 'X', NOW - 100 * DAY);
    meta.stat = async () => null; // stat cannot date the pack

    await store.gc(new Set(), 30 * DAY, NOW);

    expect(await store.has('dedateless')).toBe(true); // conservative keep
  });
});

describe('ContentStore — put/get/has/delete round-trip (pack-only)', () => {
  test('put stores in a pack, and get/has/delete route through the index', async () => {
    const { meta, store } = await fresh();

    const bytes = new TextEncoder().encode('hello');
    // A real content hash — `get` hash-verifies on read (C4), so the key must be the
    // true SHA-256 of the bytes, exactly as production `put`/`putBuffered` always supply.
    const hash = await hashContent(bytes);
    await store.put(hash, bytes);

    // Stored in a pack, never a loose `.bin`.
    expect(meta.has(PACK0)).toBe(true);
    expect(meta.has(`.opsblobs/content/${hash.slice(0, 2)}/${hash}.bin`)).toBe(false);

    // A fresh store (empty memCache) must find it purely from the reloaded index.
    const cold = new ContentStore(meta);
    await cold.init();
    expect(await cold.has(hash)).toBe(true);
    expect(await cold.get(hash)).toEqual(bytes);
    expect(await cold.listHashes()).toEqual([hash]);

    await cold.delete(hash);
    expect(await cold.has(hash)).toBe(false);
  });

  test('re-put of a present hash: in-session no-op; cross-session byte-identical re-append', async () => {
    const { meta, store } = await fresh();
    const bytes = new TextEncoder().encode('one');
    const hash = await hashContent(bytes);
    await store.put(hash, bytes);

    // Same session: memCache dedups → no new pack/index append.
    const appendsAfterFirst = meta.io.appends;
    await store.put(hash, bytes);
    expect(meta.io.appends).toBe(appendsAfterFirst);

    // Cross-session (cold, empty memCache): no disk dedup probe — a byte-identical
    // duplicate is re-appended (last index entry wins), and the blob still resolves.
    // The store is disposable, so it owes no cross-session reconciliation (spec §3).
    const cold = new ContentStore(meta);
    await cold.init();
    await cold.put(hash, bytes);
    expect(await cold.get(hash)).toEqual(bytes);
  });
});
