// ─────────────────────────────────────────────
//  Tests — ContentStore in-memory blob cache is BOUNDED (LRU byte budget)
// ─────────────────────────────────────────────
//
//  The cache used to be a plain unbounded Map on a store that lives for the whole
//  plugin load. Nothing dropped it in steady state: a round applies far fewer items
//  than a `PackCheckpoint` needs to fire, the terminal flush passes `keepWarm: true`,
//  and `getFromPack` pins a WHOLE pack per single-blob lookup — so every auto-sync
//  round staged more RAM and none was ever released until Obsidian restarted.
//
//  These pin the fix: a byte budget with LRU eviction. Unit-level tests cover the
//  eviction mechanics (budget honoured, blobs still readable from disk, LRU order,
//  pending-blob exemption, over-budget pack read still returns its blob); the last
//  test drives the REAL device stack (TestDevice + ServerSyncClient over the fake
//  server) through many small rounds and asserts the cache stops growing — the
//  scenario that regressed.

import { describe, test, expect, beforeAll } from 'vitest';
import { ContentStore, hashContent, MEM_CACHE_BUDGET_BYTES } from '../src/core/content-store';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);

/** A store with a deliberately tiny blob budget, so a handful of small blobs evict. */
async function store(budget: number): Promise<{ meta: FakeMetadataStore; cs: ContentStore }> {
  const meta = new FakeMetadataStore();
  meta.listMode = 'one-level';
  const cs = new ContentStore(meta, budget);
  await cs.init();
  return { meta, cs };
}

/** Buffer one blob and return its real hash. */
async function put(cs: ContentStore, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await hashContent(bytes);
  await cs.putBuffered(hash, bytes);
  return hash;
}

/** `n` bytes of distinct-per-`tag` text. */
const blob = (tag: string, n: number): string => `${tag}:`.padEnd(n, 'x');

describe('ContentStore mem-cache budget — eviction mechanics', () => {
  test('a write pass far past the budget leaves the cache at the ceiling, not the pass size', async () => {
    const BUDGET = 4096;
    const { cs } = await store(BUDGET);

    const hashes: string[] = [];
    for (let i = 0; i < 40; i++) {
      hashes.push(await put(cs, blob(`n${i}`, 512))); // 40 × 512 B = 20 KB written
      await cs.flushPack(); // durable → the blob loses its pending exemption
    }

    // Unbounded, this held all 20 KB. Bounded, it holds one budget's worth.
    expect(cs.memCacheBytes).toBeLessThanOrEqual(BUDGET);
    expect(cs.memCacheEntries).toBeLessThan(hashes.length);
    // Eviction costs a re-read, never data: every evicted blob still resolves from disk.
    for (const h of hashes) expect(await cs.get(h)).not.toBeNull();
  });

  test('eviction is LRU — a re-read blob outlives the blobs written before it', async () => {
    const BUDGET = 1536; // exactly 3 of these blobs
    const { cs, meta } = await store(BUDGET);

    const keep = await put(cs, blob('keep', 512));
    const cold = await put(cs, blob('cold', 512));
    await cs.flushPack();

    // Touch `keep` so it is the most-recently-used, then write two more blobs — that is
    // 4 blobs for 3 blobs of budget, so exactly one entry has to go.
    expect(await cs.get(keep)).not.toBeNull();
    for (let i = 0; i < 2; i++) {
      await put(cs, blob(`later${i}`, 512));
      await cs.flushPack();
    }

    expect(cs.memCacheBytes).toBeLessThanOrEqual(BUDGET);
    // `keep` is still cached (its read costs no disk I/O); `cold`, never touched since
    // its write, is the one that was evicted (its read hits the pack).
    const before = meta.io.reads;
    await cs.get(keep);
    expect(meta.io.reads).toBe(before);
    await cs.get(cold);
    expect(meta.io.reads).toBeGreaterThan(before);
  });

  test('buffered-not-yet-flushed blobs are exempt — the pack buffer is never undercut', async () => {
    const BUDGET = 1024;
    const { cs, meta } = await store(BUDGET);

    // Buffer well past the budget WITHOUT flushing: pending blobs cannot be evicted,
    // so no second `putBuffered` of the same hash re-appends bytes already buffered.
    const hashes: string[] = [];
    for (let i = 0; i < 8; i++) hashes.push(await put(cs, blob(`p${i}`, 512))); // 4 KB pending
    for (const h of hashes) expect(await cs.has(h)).toBe(true);
    for (const h of hashes) await cs.putBuffered(h, new TextEncoder().encode('ignored'));

    await cs.flushPack();
    // Exactly one copy of each blob was packed (no duplicate re-append), and the flush
    // drops the exemption, bringing the cache back under budget.
    const pack = (await meta.read('.opsblobs/content/pack/0.pack'))!;
    for (const h of hashes) expect(pack.split(h).length - 1).toBe(1);
    expect(cs.memCacheBytes).toBeLessThanOrEqual(BUDGET);
    for (const h of hashes) expect(await cs.get(h)).not.toBeNull();
  });

  test('a pack bigger than the whole budget still returns the blob that was asked for', async () => {
    const BUDGET = 1024;
    const { cs } = await store(BUDGET);

    // One pack of 8 KB — the whole-pack read caches every member and evicts as it goes,
    // including (potentially) the requested blob itself.
    const hashes: string[] = [];
    for (let i = 0; i < 16; i++) hashes.push(await put(cs, blob(`big${i}`, 512)));
    await cs.flushPack();
    cs.clearMemCache();
    expect(cs.memCacheBytes).toBe(0);

    const first = hashes[0]!; // the earliest member — evicted first by the read itself
    expect(new TextDecoder().decode((await cs.get(first))!)).toBe(blob('big0', 512));
    expect(cs.memCacheBytes).toBeLessThanOrEqual(BUDGET);
  });

  test('the byte counter tracks deletes and GC, so the budget cannot drift', async () => {
    const { cs, meta } = await store(MEM_CACHE_BUDGET_BYTES);
    const h = await put(cs, blob('gone', 512));
    await cs.flushPack();
    const withBlob = cs.memCacheBytes;
    expect(withBlob).toBeGreaterThan(0);

    await cs.delete(h);
    expect(cs.memCacheBytes).toBe(0);

    // And through the GC path (whole-pack retirement of an aged, unreferenced pack).
    const h2 = await put(cs, blob('gc', 512));
    await cs.flushPack();
    expect(cs.memCacheBytes).toBeGreaterThan(0);
    meta.setMtime('.opsblobs/content/pack/1.pack', 0);
    await cs.gc(new Set(), 30 * 86_400_000, 100 * 86_400_000);
    expect(cs.memCacheBytes).toBe(0);
    expect(await cs.has(h2)).toBe(false);
  });
});

describe('ContentStore mem-cache budget — across real sync rounds', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('many small rounds do not grow the cache monotonically (the regression)', async () => {
    const BUDGET = 8192;
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a', { memBudgetBytes: BUDGET });
    const B = await TestDevice.create('dev-b', { memBudgetBytes: BUDGET });
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    await A.seedFile('note.md', blob('v0', 2048), 1000);
    await client(A).runSync();
    await client(B).runSync();

    // 20 rounds × 2 KB of fresh content = ~40 KB staged — 5× the budget. Each round is
    // ONE action, far below PACK_CHECKPOINT_EVERY, so no checkpoint ever fires: exactly
    // the steady-state path that used to accumulate forever.
    const seen: number[] = [];
    for (let r = 1; r <= 20; r++) {
      await A.editFile('note.md', blob(`v${r}`, 2048), 1000 + r * 100);
      await client(A).runSync();
      await client(B).runSync();
      seen.push(A.contentStore.memCacheBytes, B.contentStore.memCacheBytes);
    }

    // Bounded on both the writing and the applying side.
    expect(Math.max(...seen)).toBeLessThanOrEqual(BUDGET);
    // …and it really is a cap, not a test that never filled: far more distinct content
    // was staged than the cache could ever have held at once.
    const stored = (await B.contentStore.listHashes()).length;
    expect(stored * 2048).toBeGreaterThan(BUDGET * 3);
    // Sanity: the content itself still converged.
    expect(new TextDecoder().decode((await B.files.read('note.md'))!)).toBe(blob('v20', 2048));
  });
});
