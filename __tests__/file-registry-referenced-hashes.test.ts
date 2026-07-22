// ─────────────────────────────────────────────
//  Tests — FileRegistry.referencedHashes (GC keep-set, plain values)
// ─────────────────────────────────────────────
//
//  Drives the real FileRegistry over a FakeMetadataStore (persistence) and a
//  FakeVaultFiles (reconcile) — no obsidian stub. Entries are seeded by writing
//  a serialized registry into the metadata fake and running the real `load()`.

import { describe, test, expect } from 'vitest';
import { FileRegistry } from '../src/core/file-registry';
import { FileEntry, HLC, SyncSettings } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';

const REGISTRY_PATH = '.vault-sync/file-registry.json';
const hlc: HLC = { wallTime: 1, counter: 0, deviceId: 'dev' };

function entry(over: Partial<FileEntry>): FileEntry {
  return {
    id: over.id ?? 'id',
    path: over.path ?? 'note.md',
    contentHash: over.contentHash ?? '',
    hlcTimestamp: hlc,
    deleted: over.deleted ?? false,
    ...over,
  };
}

/** Build a FileRegistry seeded with the given entries by feeding a serialized
 *  registry through its real `load()` path — persistence via FakeMetadataStore. */
async function registryWith(entries: FileEntry[]): Promise<FileRegistry> {
  const meta = new FakeMetadataStore();
  meta.set(REGISTRY_PATH, JSON.stringify({
    version: 1,
    entries: entries.map(e => [e.id, e]),
  }));
  const settings = (() => ({}) as SyncSettings);
  const reg = new FileRegistry(meta, new FakeVaultFiles(), 'dev', settings);
  await reg.load();
  return reg;
}

describe('FileRegistry.referencedHashes', () => {
  test('keeps live content hashes and drops deleted ones (base bytes are the GC/DAG job)', async () => {
    // Sync v2: the scalar content ancestor is retired, so the keep-set is just live
    // content. Retaining three-way merge *base* bytes is the GC's DAG-reachable job
    // (Step 8) — a GC'd base degrades a deep merge to a conflict (safe), not loss.
    const reg = await registryWith([
      // live with content → kept
      entry({ id: 'a', contentHash: 'live-a' }),
      // live → content kept
      entry({ id: 'b', contentHash: 'live-b' }),
      // deleted → content dropped
      entry({ id: 'c', deleted: true, contentHash: 'live-c' }),
      // deleted → nothing kept
      entry({ id: 'd', deleted: true, contentHash: 'live-d' }),
      // live but empty content hash → not added (falsy)
      entry({ id: 'e', contentHash: '' }),
    ]);

    const keep = reg.referencedHashes();

    expect(keep).toEqual(new Set(['live-a', 'live-b']));
    expect(keep.has('live-c')).toBe(false); // deleted entry's live content
    expect(keep.has('live-d')).toBe(false);
    expect(keep.has('')).toBe(false);       // falsy content hash never added
  });

  test('empty registry yields an empty keep-set', async () => {
    const reg = await registryWith([]);
    expect(reg.referencedHashes()).toEqual(new Set());
  });
});
