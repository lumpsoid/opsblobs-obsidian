// ─────────────────────────────────────────────
//  Tests — ContentStore.gc (age-aware retention)
// ─────────────────────────────────────────────
//
//  Drives the real ContentStore over a FakeMetadataStore (no obsidian stub):
//  content lives at `.vault-sync/content/<hash>.bin`, and mtimes are set
//  directly on the fake so the retention window is deterministic.

import { describe, test, expect } from 'vitest';
import { ContentStore, uint8ToBase64 } from '../src/core/content-store';
import { FileRegistry } from '../src/core/file-registry';
import { VersionDag } from '../src/core/version-dag';
import { FileEntry, HLC, SyncSettings } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';

const CONTENT_DIR = '.vault-sync/content';
const path = (hash: string) => `${CONTENT_DIR}/${hash}.bin`;
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
    seed(meta, 'ref-old', 'A', NOW - 100 * DAY);
    // unreferenced + within window (younger than 30d) → kept
    seed(meta, 'young', 'B', NOW - 5 * DAY);
    // unreferenced + older than window → deleted
    seed(meta, 'old', 'C', NOW - 40 * DAY);

    const store = new ContentStore(meta);
    const retentionMs = 30 * DAY;

    await store.gc(new Set(['ref-old']), retentionMs, NOW);

    expect(meta.has(path('ref-old'))).toBe(true);
    expect(meta.has(path('young'))).toBe(true);
    expect(meta.has(path('old'))).toBe(false);
  });

  // ── Sync v2, Step 8: a DAG-reachable merge base survives GC even when ancient ──
  test('retains an ancient three-way merge base reachable from a live head (DAG keep-set)', async () => {
    const meta = new FakeMetadataStore();
    // Blobs: the live head bytes (young) and its ANCIENT base — deeper than the
    // retention window. Without the DAG-aware keep-set the base would be GC'd,
    // degrading a future deep merge to a conflict.
    seed(meta, 'head-hash', 'current', NOW - 1 * DAY);
    seed(meta, 'base-hash', 'original', NOW - 100 * DAY);
    // An unrelated, unreachable ancient blob still ages out.
    seed(meta, 'orphan', 'dead', NOW - 100 * DAY);

    // A real registry with one live file whose head descends from base-hash.
    const REGISTRY_PATH = '.vault-sync/file-registry.json';
    const hlc: HLC = { wallTime: 1, counter: 0, deviceId: 'dev' };
    const live: FileEntry = {
      id: 'a', path: 'note.md', contentHash: 'head-hash', hlcTimestamp: hlc,
      deleted: false, headVersionId: 'v-head',
    };
    meta.set(REGISTRY_PATH, JSON.stringify({ version: 1, entries: [['a', live]] }));
    const reg = new FileRegistry(meta, new FakeVaultFiles(), 'dev', (() => ({}) as SyncSettings));
    await reg.load();

    const dag = new VersionDag();
    dag.addVersion('v-base', [], 'base-hash', 'a');
    dag.addVersion('v-head', ['v-base'], 'head-hash', 'a');

    const store = new ContentStore(meta);
    await store.gc(reg.referencedHashes(dag), 30 * DAY, NOW);

    expect(meta.has(path('head-hash'))).toBe(true);  // live content
    expect(meta.has(path('base-hash'))).toBe(true);  // reachable base — kept despite age
    expect(meta.has(path('orphan'))).toBe(false);    // unreachable + old → dropped
  });

  test('keeps an unreferenced hash when its mtime is undatable (stat returns null)', async () => {
    const meta = new FakeMetadataStore();
    seed(meta, 'dateless', 'X', NOW);
    // Force stat to report no mtime for this blob.
    meta.stat = async () => null;

    const store = new ContentStore(meta);
    await store.gc(new Set(), 30 * DAY, NOW);

    expect(meta.has(path('dateless'))).toBe(true); // conservative keep
  });
});
