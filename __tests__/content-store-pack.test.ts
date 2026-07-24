// ─────────────────────────────────────────────
//  Tests — ContentStore pack-writes (A3, docs/pack-writes-spec.md §5)
// ─────────────────────────────────────────────
//
//  Drives the real ContentStore over a FakeMetadataStore under the one-level `list()`
//  semantics the device adapter uses. Capture buffers blobs in `putNew` and appends
//  them to per-checkpoint packs via `flushPack`; these pin the pack format's round-trip,
//  torn-tail safety, loose/packed coexistence, whole-pack GC, and index rebuild on reload.

import { describe, test, expect } from 'vitest';
import { ContentStore, hashContent } from '../src/core/content-store';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const PACK0 = '.vault-sync/content/pack/0.pack';
const PACK_INDEX = '.vault-sync/content/pack/index';
const DAY = 86_400_000;
const NOW = 1_000_000_000_000;

/** A fresh, device-semantics store. */
async function freshStore(): Promise<{ meta: FakeMetadataStore; store: ContentStore }> {
  const meta = new FakeMetadataStore();
  meta.listMode = 'one-level';
  const store = new ContentStore(meta);
  await store.init();
  return { meta, store };
}

/** Buffer a blob and return its real content hash (the key production always uses). */
async function pack(store: ContentStore, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await hashContent(bytes);
  await store.putNew(hash, bytes);
  return hash;
}

describe('ContentStore pack-writes — round-trip', () => {
  test('buffered putNew → flushPack → get extracts + hash-verifies, from a cold memCache', async () => {
    const { store } = await freshStore();

    const hA = await pack(store, 'alpha\n');
    const hB = await pack(store, 'beta\n');
    const hDup = await pack(store, 'alpha\n'); // duplicate content — same hash, deduped
    expect(hDup).toBe(hA);

    await store.flushPack();
    // Drop the warm cache so the read-back is forced through the pack extract path.
    store.clearMemCache();

    expect(new TextDecoder().decode((await store.get(hA))!)).toBe('alpha\n');
    expect(new TextDecoder().decode((await store.get(hB))!)).toBe('beta\n');
    expect(await store.has(hA)).toBe(true);
    expect(await store.has(hB)).toBe(true);
    expect((await store.listHashes()).sort()).toEqual([hA, hB].sort());
  });

  test('one whole-pack read caches every blob it holds (amortised — spec §3.3)', async () => {
    const { meta, store } = await freshStore();
    const hashes = [] as string[];
    for (let i = 0; i < 5; i++) hashes.push(await pack(store, `note-${i}\n`));
    await store.flushPack();
    store.clearMemCache();

    const readsBefore = meta.io.reads;
    for (const h of hashes) expect(await store.get(h)).not.toBeNull();
    // The amortisation win: reads are CONSTANT in the blob count, not 5×. The first
    // get does one loose-`.bin` miss probe + one pack read (which caches all 5); the
    // other four are pure memCache hits. So 2 reads total, never 5 pack reads.
    expect(meta.io.reads - readsBefore).toBe(2);
  });
});

describe('ContentStore pack-writes — torn-tail safety (spec §4)', () => {
  test('a truncated trailing record reads as missing; earlier blobs still read', async () => {
    const { meta, store } = await freshStore();
    const h0 = await pack(store, 'first record\n');
    const h1 = await pack(store, 'second and last record\n');
    await store.flushPack();
    store.clearMemCache();

    // Simulate a crash mid-append: chop the last few chars off the pack body, torning
    // the final record's base64 payload.
    const body = meta.has(PACK0) ? (await meta.read(PACK0))! : '';
    meta.set(PACK0, body.slice(0, body.length - 4));

    expect(await store.get(h1)).toBeNull();               // torn tail → missing (F1)
    expect(new TextDecoder().decode((await store.get(h0))!)).toBe('first record\n'); // intact
  });

  test('a torn trailing INDEX line is dropped on reload; the blob re-reads as missing', async () => {
    const { meta, store } = await freshStore();
    const h0 = await pack(store, 'kept\n');
    const h1 = await pack(store, 'lost-from-index\n');
    await store.flushPack();

    // Tear the index's last line (h1's entry) as an append crash would.
    const idx = (await meta.read(PACK_INDEX))!;
    const lines = idx.split('\n').filter(l => l !== '');
    meta.set(PACK_INDEX, lines.slice(0, -1).join('\n') + '\n' + lines[lines.length - 1]!.slice(0, 5));

    const cold = new ContentStore(meta);
    await cold.init();
    expect(await cold.get(h0)).not.toBeNull(); // first line intact
    expect(await cold.has(h1)).toBe(false);    // torn line dropped → unknown → missing
  });
});

describe('ContentStore pack-writes — loose + packed coexistence (spec §3.4)', () => {
  test('get/has/listHashes see both; a steady-state put stays loose', async () => {
    const { meta, store } = await freshStore();
    const hPacked = await pack(store, 'packed-content\n');
    await store.flushPack();

    const looseBytes = new TextEncoder().encode('loose-content\n');
    const hLoose = await hashContent(looseBytes);
    await store.put(hLoose, looseBytes); // steady-state edit → loose .bin

    // The loose blob physically lives at the sharded .bin path, never in a pack.
    expect(meta.has(`.vault-sync/content/${hLoose.slice(0, 2)}/${hLoose}.bin`)).toBe(true);

    store.clearMemCache();
    expect(await store.get(hPacked)).not.toBeNull();
    expect(await store.get(hLoose)).not.toBeNull();
    expect(await store.has(hPacked)).toBe(true);
    expect(await store.has(hLoose)).toBe(true);
    expect((await store.listHashes()).sort()).toEqual([hPacked, hLoose].sort());
  });
});

describe('ContentStore pack-writes — whole-pack retention GC (spec §3.5)', () => {
  test('drops a fully-unreferenced aged pack; keeps a pack with any live blob', async () => {
    const { meta, store } = await freshStore();
    // Pack 0 — both blobs dead.
    const dead0 = await pack(store, 'dead-a\n');
    const dead1 = await pack(store, 'dead-b\n');
    await store.flushPack();
    // Pack 1 — one live blob, one dead.
    const live = await pack(store, 'still-live\n');
    const dead2 = await pack(store, 'dead-c\n');
    await store.flushPack();

    // Age both pack files past the retention window.
    meta.setMtime(PACK0, NOW - 100 * DAY);
    meta.setMtime('.vault-sync/content/pack/1.pack', NOW - 100 * DAY);

    await store.gc(new Set([live]), 30 * DAY, NOW);

    // Pack 0 (all-dead, aged) removed; its blobs now missing.
    expect(meta.has(PACK0)).toBe(false);
    expect(await store.has(dead0)).toBe(false);
    expect(await store.has(dead1)).toBe(false);
    // Pack 1 kept whole (a referenced blob keeps its pack); both still resolve.
    expect(meta.has('.vault-sync/content/pack/1.pack')).toBe(true);
    store.clearMemCache();
    expect(await store.get(live)).not.toBeNull();
    expect(await store.get(dead2)).not.toBeNull(); // dead but alive-by-association
  });

  test('a young unreferenced pack is kept (within the window)', async () => {
    const { meta, store } = await freshStore();
    const h = await pack(store, 'young\n');
    await store.flushPack();
    meta.setMtime(PACK0, NOW - 5 * DAY); // younger than 30d

    await store.gc(new Set(), 30 * DAY, NOW);
    expect(meta.has(PACK0)).toBe(true);
    expect(await store.has(h)).toBe(true);
  });
});

describe('ContentStore pack-writes — index rebuild on reload (spec §3.4)', () => {
  test('a cold store rebuilds the index from pack/index; all packed hashes resolve', async () => {
    const { meta, store } = await freshStore();
    const hashes = [] as string[];
    for (let i = 0; i < 4; i++) hashes.push(await pack(store, `reload-${i}\n`));
    await store.flushPack();

    // Fresh store over the same disk — no in-memory index, must reload from pack/index.
    const cold = new ContentStore(meta);
    await cold.init();
    for (const h of hashes) expect(await cold.get(h)).not.toBeNull();
    expect((await cold.listHashes()).sort()).toEqual([...hashes].sort());
  });

  test('a second capture session numbers its pack past existing ones (no clobber)', async () => {
    const { meta, store } = await freshStore();
    const h0 = await pack(store, 'session-one\n');
    await store.flushPack(); // → pack 0

    const cold = new ContentStore(meta);
    await cold.init();
    const h1 = await hashContent(new TextEncoder().encode('session-two\n'));
    await cold.putNew(h1, new TextEncoder().encode('session-two\n'));
    await cold.flushPack(); // must be pack 1, not overwrite pack 0

    expect(meta.has(PACK0)).toBe(true);
    expect(meta.has('.vault-sync/content/pack/1.pack')).toBe(true);
    expect(await cold.get(h0)).not.toBeNull();
    expect(await cold.get(h1)).not.toBeNull();
  });
});
