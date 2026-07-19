// ─────────────────────────────────────────────
//  Tests — FileRegistry.referencedHashes (GC keep-set, plain values)
// ─────────────────────────────────────────────

import { describe, test, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { FileRegistry } from '../src/core/file-registry';
import { FileEntry, HLC, SyncSettings } from '../src/types';

// The `obsidian` module isn't resolvable under the test runner (only its types
// are, for tsc). FileRegistry needs `normalizePath` at runtime (in save(), which
// these tests don't hit) and App/TFile as types — a tiny stub lets us import and
// exercise the real class. The `import type` above is erased at runtime.
vi.mock('obsidian', () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
}));

const hlc: HLC = { wallTime: 1, counter: 0, deviceId: 'dev' };

function entry(over: Partial<FileEntry>): FileEntry {
  return {
    id: over.id ?? 'id',
    path: over.path ?? 'note.md',
    contentHash: over.contentHash ?? '',
    hlcTimestamp: hlc,
    deleted: over.deleted ?? false,
    ancestorContentHash: over.ancestorContentHash ?? null,
    ...over,
  };
}

/** Build a FileRegistry seeded with the given entries by feeding a serialized
 *  registry through its real `load()` path — no vault I/O beyond a stub read. */
async function registryWith(entries: FileEntry[]): Promise<FileRegistry> {
  const serialized = JSON.stringify({
    version: 1,
    entries: entries.map(e => [e.id, e]),
  });
  const app = {
    vault: { adapter: { read: async () => serialized } },
  } as unknown as App;
  const settings = (() => ({}) as SyncSettings);
  const reg = new FileRegistry(app, 'dev', settings);
  await reg.load();
  return reg;
}

describe('FileRegistry.referencedHashes', () => {
  test('keeps live content hashes, drops deleted ones, and keeps every ancestor', async () => {
    const reg = await registryWith([
      // live with content + ancestor → both kept
      entry({ id: 'a', contentHash: 'live-a', ancestorContentHash: 'anc-a' }),
      // live, no ancestor → content kept
      entry({ id: 'b', contentHash: 'live-b', ancestorContentHash: null }),
      // deleted but with an ancestor → content dropped, ancestor kept
      entry({ id: 'c', deleted: true, contentHash: 'live-c', ancestorContentHash: 'anc-c' }),
      // deleted, no ancestor → nothing kept
      entry({ id: 'd', deleted: true, contentHash: 'live-d', ancestorContentHash: null }),
      // live but empty content hash → not added (falsy)
      entry({ id: 'e', contentHash: '', ancestorContentHash: 'anc-e' }),
    ]);

    const keep = reg.referencedHashes();

    expect(keep).toEqual(new Set(['live-a', 'anc-a', 'live-b', 'anc-c', 'anc-e']));
    expect(keep.has('live-c')).toBe(false); // deleted entry's live content
    expect(keep.has('live-d')).toBe(false);
    expect(keep.has('')).toBe(false);       // falsy content hash never added
  });

  test('empty registry yields an empty keep-set', async () => {
    const reg = await registryWith([]);
    expect(reg.referencedHashes()).toEqual(new Set());
  });
});
