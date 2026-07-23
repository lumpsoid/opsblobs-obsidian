// ─────────────────────────────────────────────
//  Tests — ContentStore.gc (age-aware retention) + shard layout
// ─────────────────────────────────────────────
//
//  Drives the real ContentStore over a FakeMetadataStore (no obsidian stub):
//  content lives at `.vault-sync/content/<hash[0:2]>/<hash>.bin` (sharded), and
//  mtimes are set directly on the fake so the retention window is deterministic.
//  Hashes are hex-leading so they land in the 00..ff shard sweep, exactly like
//  the real SHA-256 content hashes.

import { describe, test, expect } from 'vitest';
import { ContentStore, uint8ToBase64 } from '../src/core/content-store';
import { FileRegistry } from '../src/core/file-registry';
import { VersionDag } from '../src/core/version-dag';
import { FileEntry, HLC, SyncSettings } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';

const CONTENT_DIR = '.vault-sync/content';
/** On-disk path for a blob under the shard layout (mirrors ContentStore.contentPath). */
const path = (hash: string) => `${CONTENT_DIR}/${hash.slice(0, 2)}/${hash}.bin`;
const DAY = 86_400_000;
const NOW = 1_000_000_000_000; // fixed injected clock

/** Seed a blob (via the port's own path/encoding) with a controllable mtime. */
function seed(meta: FakeMetadataStore, hash: string, data: string, mtime: number) {
  meta.set(path(hash), uint8ToBase64(new TextEncoder().encode(data)), mtime);
}

describe('ContentStore.gc — age-aware retention', () => {
  test('keeps referenced hashes always, keeps young unreferenced, deletes old unreferenced', async () => {
    const meta = new FakeMetadataStore();
    // referenced + ancient → kept (reference wins over age)
    seed(meta, 'a0refold', 'A', NOW - 100 * DAY);
    // unreferenced + within window (younger than 30d) → kept
    seed(meta, 'b1young', 'B', NOW - 5 * DAY);
    // unreferenced + older than window → deleted
    seed(meta, 'c2old', 'C', NOW - 40 * DAY);

    const store = new ContentStore(meta);
    const retentionMs = 30 * DAY;

    await store.gc(new Set(['a0refold']), retentionMs, NOW);

    expect(meta.has(path('a0refold'))).toBe(true);
    expect(meta.has(path('b1young'))).toBe(true);
    expect(meta.has(path('c2old'))).toBe(false);
  });

  // ── Sync v2, Step 8: a DAG-reachable merge base survives GC even when ancient ──
  test('retains an ancient three-way merge base reachable from a live head (DAG keep-set)', async () => {
    const meta = new FakeMetadataStore();
    // Blobs: the live head bytes (young) and its ANCIENT base — deeper than the
    // retention window. Without the DAG-aware keep-set the base would be GC'd,
    // degrading a future deep merge to a conflict.
    seed(meta, 'aahead', 'current', NOW - 1 * DAY);
    seed(meta, 'bbbase', 'original', NOW - 100 * DAY);
    // An unrelated, unreachable ancient blob still ages out.
    seed(meta, 'cforphan', 'dead', NOW - 100 * DAY);

    // A real registry with one live file whose head descends from bbbase.
    const REGISTRY_PATH = '.vault-sync/file-registry.json';
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

    const store = new ContentStore(meta);
    await store.gc(reg.referencedHashes(dag), 30 * DAY, NOW);

    expect(meta.has(path('aahead'))).toBe(true);  // live content
    expect(meta.has(path('bbbase'))).toBe(true);  // reachable base — kept despite age
    expect(meta.has(path('cforphan'))).toBe(false); // unreachable + old → dropped
  });

  test('keeps an unreferenced hash when its mtime is undatable (stat returns null)', async () => {
    const meta = new FakeMetadataStore();
    seed(meta, 'dedateless', 'X', NOW);
    // Force stat to report no mtime for this blob.
    meta.stat = async () => null;

    const store = new ContentStore(meta);
    await store.gc(new Set(), 30 * DAY, NOW);

    expect(meta.has(path('dedateless'))).toBe(true); // conservative keep
  });

  // ── Shard layout: listHashes/gc must work under the one-level list() semantics
  //    the real Obsidian adapter uses (it returns only files directly under a
  //    dir, discarding subfolders). A naive `list(CONTENT_DIR)` would see nothing
  //    now that blobs live in `content/<xx>/` — this pins the prefix sweep. ──
  test('gc collects a sharded unreferenced blob under one-level list() semantics', async () => {
    const meta = new FakeMetadataStore();
    meta.listMode = 'one-level'; // model the device adapter
    seed(meta, 'a0keep', 'live', NOW);
    seed(meta, 'ffgone', 'dead', NOW - 100 * DAY);

    const store = new ContentStore(meta);
    await store.gc(new Set(['a0keep']), 30 * DAY, NOW);

    expect(meta.has(path('a0keep'))).toBe(true);
    expect(meta.has(path('ffgone'))).toBe(false); // found + deleted despite the deeper path
  });
});

describe('ContentStore — sharded put/get/has/delete round-trip', () => {
  test('put stores under content/<hash[0:2]>/, and get/has/delete route through it', async () => {
    const meta = new FakeMetadataStore();
    meta.listMode = 'one-level';
    const store = new ContentStore(meta);
    await store.init();

    const bytes = new TextEncoder().encode('hello');
    const hash = 'deadbeefcafe';
    await store.put(hash, bytes);

    // Physically sharded on disk.
    expect(meta.has(`${CONTENT_DIR}/de/${hash}.bin`)).toBe(true);

    // A fresh store (empty memCache) must find it purely from disk.
    const cold = new ContentStore(meta);
    expect(await cold.has(hash)).toBe(true);
    expect(await cold.get(hash)).toEqual(bytes);
    expect(await cold.listHashes()).toEqual([hash]);

    await cold.delete(hash);
    expect(await cold.has(hash)).toBe(false);
    expect(meta.has(`${CONTENT_DIR}/de/${hash}.bin`)).toBe(false);
  });

  test('put is a no-op when the blob already exists on disk', async () => {
    const meta = new FakeMetadataStore();
    const store = new ContentStore(meta);
    const hash = 'abc123';
    await store.put(hash, new TextEncoder().encode('one'));

    const before = meta.io.writes;
    // A cold store (no memCache) re-putting the same hash must not rewrite.
    const cold = new ContentStore(meta);
    await cold.put(hash, new TextEncoder().encode('one'));
    expect(meta.io.writes).toBe(before);
  });
});
