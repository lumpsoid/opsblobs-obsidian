// ─────────────────────────────────────────────
//  Tests — ContentStore packs (A3 unify-on-packs, docs/unify-on-packs-spec.md §6)
// ─────────────────────────────────────────────
//
//  Drives the real ContentStore over a FakeMetadataStore under the one-level `list()`
//  semantics the device adapter uses. Packs are the SOLE format: capture/apply buffer
//  blobs in `putBuffered` and flush per checkpoint; a steady-state `put` buffers + flushes
//  one blob immediately. These pin the pack round-trip, torn-tail safety, "no loose
//  format", whole-pack retention, mark-and-compact, and index rebuild on reload.

import { describe, test, expect } from 'vitest';
import { ContentStore, hashContent } from '../src/core/content-store';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const PACK0 = '.vault-sync/content/pack/0.pack';
const PACK1 = '.vault-sync/content/pack/1.pack';
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
  await store.putBuffered(hash, bytes);
  return hash;
}

/** Record every path the store writes/appends, so a test can assert no `.bin` is
 *  ever written (the loose format is gone — spec §2.2). */
function trackWrites(meta: FakeMetadataStore): string[] {
  const paths: string[] = [];
  for (const m of ['write', 'writeDirect', 'append'] as const) {
    const orig = meta[m].bind(meta);
    (meta as unknown as Record<string, unknown>)[m] = async (p: string, d: string) => {
      paths.push(p);
      return orig(p, d);
    };
  }
  return paths;
}

describe('ContentStore packs — round-trip', () => {
  test('buffered putBuffered → flushPack → get extracts + hash-verifies, from a cold memCache', async () => {
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

  test('one whole-pack read caches every blob it holds (amortised — spec §2.3)', async () => {
    const { meta, store } = await freshStore();
    const hashes = [] as string[];
    for (let i = 0; i < 5; i++) hashes.push(await pack(store, `note-${i}\n`));
    await store.flushPack();
    store.clearMemCache();

    const readsBefore = meta.io.reads;
    for (const h of hashes) expect(await store.get(h)).not.toBeNull();
    // The amortisation win: reads are CONSTANT in the blob count, not 5×. With loose
    // gone there is no per-blob `.bin` miss probe — the first get does ONE pack read
    // (which caches all 5); the other four are pure memCache hits. So 1 read total.
    expect(meta.io.reads - readsBefore).toBe(1);
  });
});

describe('ContentStore packs — torn-tail safety (spec §3)', () => {
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

describe('ContentStore packs — the pack is the only format (spec §2.2)', () => {
  test('a steady-state put writes a 1-blob pack, never a loose .bin', async () => {
    const { meta, store } = await freshStore();
    const writes = trackWrites(meta);

    const bytes = new TextEncoder().encode('steady-edit\n');
    const h = await hashContent(bytes);
    await store.put(h, bytes); // durable single edit → buffer + immediate flush

    // No loose blob anywhere — not at the old sharded path, and no `.bin` written at all.
    expect(meta.has(`.vault-sync/content/${h.slice(0, 2)}/${h}.bin`)).toBe(false);
    expect(writes.some(p => p.endsWith('.bin'))).toBe(false);
    // The blob lives in a pack + the index, and resolves purely from packs cold.
    expect(meta.has(PACK0)).toBe(true);
    store.clearMemCache();
    expect(new TextDecoder().decode((await store.get(h))!)).toBe('steady-edit\n');
    expect(await store.has(h)).toBe(true);
    expect(await store.listHashes()).toEqual([h]);
  });

  test('capture + steady edits + delete all resolve purely from packs; no .bin ever written', async () => {
    const { meta, store } = await freshStore();
    const writes = trackWrites(meta);

    // A capture-style batch (buffered), then a steady-state edit (put).
    const hCap = await pack(store, 'captured\n');
    await store.flushPack();
    const editBytes = new TextEncoder().encode('edited\n');
    const hEdit = await hashContent(editBytes);
    await store.put(hEdit, editBytes);

    store.clearMemCache();
    expect(await store.get(hCap)).not.toBeNull();
    expect(await store.get(hEdit)).not.toBeNull();
    expect((await store.listHashes()).sort()).toEqual([hCap, hEdit].sort());

    // delete drops the index entry (read-missing) and persists via an index rewrite.
    await store.delete(hCap);
    expect(await store.has(hCap)).toBe(false);
    expect(writes.some(p => p.endsWith('.bin'))).toBe(false);
  });
});

describe('ContentStore packs — whole-pack retention GC (spec §4.1)', () => {
  test('drops a fully-unreferenced aged pack; keeps a pack with any live blob', async () => {
    const { meta, store } = await freshStore();
    // Pack 0 — both blobs dead.
    const dead0 = await pack(store, 'dead-a\n');
    const dead1 = await pack(store, 'dead-b\n');
    await store.flushPack();
    // Pack 1 — both blobs live (so it is kept whole, no compaction).
    const live0 = await pack(store, 'still-live-a\n');
    const live1 = await pack(store, 'still-live-b\n');
    await store.flushPack();

    // Age both pack files past the retention window.
    meta.setMtime(PACK0, NOW - 100 * DAY);
    meta.setMtime(PACK1, NOW - 100 * DAY);

    await store.gc(new Set([live0, live1]), 30 * DAY, NOW);

    // Pack 0 (all-dead, aged) removed; its blobs now missing.
    expect(meta.has(PACK0)).toBe(false);
    expect(await store.has(dead0)).toBe(false);
    expect(await store.has(dead1)).toBe(false);
    // Pack 1 kept whole (fully live); both still resolve.
    expect(meta.has(PACK1)).toBe(true);
    store.clearMemCache();
    expect(await store.get(live0)).not.toBeNull();
    expect(await store.get(live1)).not.toBeNull();
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

  test('an undatable pack is kept (conservative — we do not delete what we cannot date)', async () => {
    const { meta, store } = await freshStore();
    const h = await pack(store, 'dateless\n');
    await store.flushPack();
    meta.stat = async () => null; // stat cannot date the pack

    await store.gc(new Set(), 30 * DAY, NOW);
    expect(meta.has(PACK0)).toBe(true);
    expect(await store.has(h)).toBe(true);
  });
});

describe('ContentStore packs — mark-and-compact (spec §4.2)', () => {
  test('rewrites a mostly-dead aged pack to just its live blobs, reclaiming the rest', async () => {
    const { meta, store } = await freshStore();
    // One pack of 4 blobs, only 1 live → live fraction 0.25 < 0.5 → compact.
    const h: string[] = [];
    for (let i = 0; i < 4; i++) h.push(await pack(store, `blob-${i}\n`));
    await store.flushPack(); // → pack 0
    meta.setMtime(PACK0, NOW - 100 * DAY);
    const live = h[1]!;

    await store.gc(new Set([live]), 30 * DAY, NOW);

    // Old pack gone; a fresh pack holds the survivor; index lists only it.
    expect(meta.has(PACK0)).toBe(false);
    expect(meta.has(PACK1)).toBe(true);
    expect(await store.listHashes()).toEqual([live]);
    // The freed hashes read missing; the live hash still reads (cold).
    store.clearMemCache();
    expect(await store.get(live)).not.toBeNull();
    for (const dead of h.filter(x => x !== live)) expect(await store.has(dead)).toBe(false);

    // Survives a cold reload (the index was rewritten to the survivor).
    const cold = new ContentStore(meta);
    await cold.init();
    expect(await cold.get(live)).not.toBeNull();
    expect(await cold.listHashes()).toEqual([live]);
  });

  test('an aged but mostly-live pack is kept whole (live fraction ≥ threshold)', async () => {
    const { meta, store } = await freshStore();
    // 4 blobs, 3 live → fraction 0.75 ≥ 0.5 → keep whole, no repack.
    const h: string[] = [];
    for (let i = 0; i < 4; i++) h.push(await pack(store, `keep-${i}\n`));
    await store.flushPack();
    meta.setMtime(PACK0, NOW - 100 * DAY);

    await store.gc(new Set([h[0]!, h[1]!, h[2]!]), 30 * DAY, NOW);

    expect(meta.has(PACK0)).toBe(true);  // original pack untouched
    expect(meta.has(PACK1)).toBe(false); // no fresh pack created
    // The dead one is still alive-by-association (pinned by the kept pack).
    store.clearMemCache();
    expect(await store.get(h[3]!)).not.toBeNull();
  });
});

describe('ContentStore packs — compact crash-safety (spec §4.2 ordering)', () => {
  test('crash between new-pack-write and old-pack-remove keeps the live blob reachable', async () => {
    const { meta, store } = await freshStore();
    const h: string[] = [];
    for (let i = 0; i < 4; i++) h.push(await pack(store, `c-${i}\n`));
    await store.flushPack();
    meta.setMtime(PACK0, NOW - 100 * DAY);
    const live = h[0]!;

    // Crash: fail the old-pack removal AFTER the fresh pack + index delta are durable.
    const origRemove = meta.remove.bind(meta);
    meta.remove = async () => {
      throw new Error('simulated crash before old-pack removal');
    };
    await expect(store.gc(new Set([live]), 30 * DAY, NOW)).rejects.toThrow();
    meta.remove = origRemove;

    // Both packs are briefly present; a cold reload resolves the live blob via the new
    // pack (its index entry was appended last → wins), never neither.
    expect(meta.has(PACK1)).toBe(true);
    const cold = new ContentStore(meta);
    await cold.init();
    expect(await cold.get(live)).not.toBeNull();
  });

  test('crash between buffer and flush leaves the old pack intact and the live blob readable', async () => {
    const { meta, store } = await freshStore();
    const h: string[] = [];
    for (let i = 0; i < 4; i++) h.push(await pack(store, `b-${i}\n`));
    await store.flushPack();
    meta.setMtime(PACK0, NOW - 100 * DAY);
    const live = h[0]!;

    // Crash before the fresh pack is written (the compaction flush's first append).
    const origAppend = meta.append.bind(meta);
    meta.append = async () => {
      throw new Error('simulated crash before flush');
    };
    await expect(store.gc(new Set([live]), 30 * DAY, NOW)).rejects.toThrow();
    meta.append = origAppend;

    // Old pack untouched, index unchanged; the live blob still resolves from it (cold).
    expect(meta.has(PACK0)).toBe(true);
    const cold = new ContentStore(meta);
    await cold.init();
    expect(await cold.get(live)).not.toBeNull();
  });
});

describe('ContentStore packs — index rebuild on reload (spec §2.2)', () => {
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
    await cold.putBuffered(h1, new TextEncoder().encode('session-two\n'));
    await cold.flushPack(); // must be pack 1, not overwrite pack 0

    expect(meta.has(PACK0)).toBe(true);
    expect(meta.has(PACK1)).toBe(true);
    expect(await cold.get(h0)).not.toBeNull();
    expect(await cold.get(h1)).not.toBeNull();
  });
});
