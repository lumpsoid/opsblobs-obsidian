// ─────────────────────────────────────────────
//  Tests — ContentStore.consolidatePacks (manual defragmentation)
// ─────────────────────────────────────────────
//
//  Steady-state single-file edits produce many 1-blob packs (each `put` writes a
//  fresh pack), and the automated `gc` above only rewrites *aged, mostly-dead* packs
//  — a vault whose packs are all fully live sees no consolidation. This is the
//  manual escape hatch: rewrite small packs into fresh chunked packs and compact
//  in-place any large pack that still holds dead blobs. Real ContentStore over
//  FakeMetadataStore, no obsidian stub. Real content hashes so `get`'s C4
//  hash-verify passes on read.

import { describe, test, expect } from 'vitest';
import { ContentStore, hashContent } from '../src/core/content-store';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const PACK_DIR = '.opsblobs/content/pack';

async function fresh(): Promise<{ meta: FakeMetadataStore; store: ContentStore }> {
  const meta = new FakeMetadataStore();
  meta.listMode = 'one-level';
  const store = new ContentStore(meta);
  await store.init();
  return { meta, store };
}

/** Write N single-blob packs by using `put` in a loop (each call → a fresh pack).
 *  Returns the ordered list of hashes so the caller can reference them in `keep`. */
async function seedManySmallPacks(store: ContentStore, n: number): Promise<string[]> {
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = new TextEncoder().encode(`blob-${i}`);
    const h = await hashContent(bytes);
    await store.put(h, bytes);
    hashes.push(h);
  }
  return hashes;
}

async function packFileCount(meta: FakeMetadataStore): Promise<number> {
  const entries = await meta.list(PACK_DIR);
  return entries.filter(p => p.endsWith('.pack')).length;
}

describe('ContentStore.consolidatePacks', () => {
  test('folds many 1-blob packs into a small number of larger packs when all are live', async () => {
    const { meta, store } = await fresh();
    const hashes = await seedManySmallPacks(store, 20);
    expect(await packFileCount(meta)).toBe(20);

    // Threshold above the source pack size → every pack qualifies as "small" and
    // gets stream-merged. flushEvery = 8 → expect ceil(20/8) = 3 chunked packs.
    const result = await store.consolidatePacks(new Set(hashes), /*smallPackThreshold*/ 8, /*flushEvery*/ 8);

    expect(result.packsBefore).toBe(20);
    expect(result.blobsKept).toBe(20);
    expect(result.blobsDropped).toBe(0);
    expect(result.packsAfter).toBe(3);
    expect(await packFileCount(meta)).toBe(3);

    // Every blob still readable — hash-verify on get passes, so the merge preserved
    // the exact bytes (base64 body was copied unchanged).
    for (const h of hashes) {
      const bytes = await store.get(h);
      expect(bytes).not.toBeNull();
      expect(new TextDecoder().decode(bytes!)).toBe(`blob-${hashes.indexOf(h)}`);
    }

    // A cold reload sees the same shape — the on-disk index was rewritten atomically
    // after the merge, not left with stale entries pointing at removed packs.
    const cold = new ContentStore(meta);
    await cold.init();
    expect((await cold.listHashes()).sort()).toEqual([...hashes].sort());
  });

  test('drops dead blobs and retires wholly-dead packs (age-blind, unlike gc)', async () => {
    const { meta, store } = await fresh();
    const hashes = await seedManySmallPacks(store, 6);
    // Keep the first three, treat the rest as dead. gc would need the packs to be
    // aged past the retention window; consolidatePacks does not.
    const keep = new Set(hashes.slice(0, 3));

    const result = await store.consolidatePacks(keep, /*smallPackThreshold*/ 8, /*flushEvery*/ 8);

    expect(result.blobsKept).toBe(3);
    expect(result.blobsDropped).toBe(3);
    expect(result.packsAfter).toBe(1); // 3 live blobs → single stream-merge pack

    for (const h of hashes.slice(0, 3)) expect(await store.has(h)).toBe(true);
    for (const h of hashes.slice(3)) expect(await store.has(h)).toBe(false);
  });

  test('leaves alone packs already at threshold with no dead blobs', async () => {
    const { meta, store } = await fresh();
    // Put a batch of 10 blobs into ONE pack via the buffered path + a single flush,
    // then a stream of individual small packs on top.
    const batchHashes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const bytes = new TextEncoder().encode(`batch-${i}`);
      const h = await hashContent(bytes);
      await store.putBuffered(h, bytes);
      batchHashes.push(h);
    }
    await store.flushPack();
    const smallHashes = await seedManySmallPacks(store, 3);
    expect(await packFileCount(meta)).toBe(1 + 3); // one big + three 1-blob

    const keep = new Set([...batchHashes, ...smallHashes]);
    // Threshold = 8 → the 10-blob pack is at/above and fully live → untouched.
    // The three 1-blob packs stream-merge into one fresh pack (flushEvery = 8).
    const result = await store.consolidatePacks(keep, 8, 8);

    expect(result.blobsKept).toBe(3); // only the merged ones are counted as "kept"
    expect(result.blobsDropped).toBe(0);
    // 4 packs → 2 packs (the untouched big one + one merged small one).
    expect(await packFileCount(meta)).toBe(2);

    // Every blob still readable.
    for (const h of [...batchHashes, ...smallHashes]) {
      expect(await store.get(h)).not.toBeNull();
    }
  });

  test('no-op when the store is empty', async () => {
    const { store } = await fresh();
    const result = await store.consolidatePacks(new Set(), 8, 8);
    expect(result).toEqual({ packsBefore: 0, packsAfter: 0, blobsKept: 0, blobsDropped: 0 });
  });
});
