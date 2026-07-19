// ─────────────────────────────────────────────
//  Tests — ContentStore.gc (age-aware retention)
// ─────────────────────────────────────────────

import { describe, test, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { ContentStore } from '../src/core/content-store';

// `obsidian` isn't resolvable under the runner; ContentStore only needs
// `normalizePath` at runtime and `App` as a type (erased). Stub it.
vi.mock('obsidian', () => ({
  App: class {},
  normalizePath: (p: string) => p,
}));

const CONTENT_DIR = '.vault-sync/content';

/** Minimal in-memory vault adapter with a controllable per-file mtime, covering
 *  the surface ContentStore uses: exists/list/read/write/remove/mkdir/stat. */
function makeApp(files: Record<string, { data: string; mtime: number }>) {
  return {
    vault: {
      adapter: {
        async exists(p: string) { return p === CONTENT_DIR || p in files; },
        async mkdir() { /* no-op */ },
        async list(dir: string) {
          const prefix = dir.endsWith('/') ? dir : dir + '/';
          return { files: Object.keys(files).filter(p => p.startsWith(prefix)), folders: [] };
        },
        async read(p: string) {
          if (!(p in files)) throw new Error('ENOENT');
          return files[p]!.data;
        },
        async write(p: string, data: string) { files[p] = { data, mtime: files[p]?.mtime ?? 0 }; },
        async remove(p: string) { delete files[p]; },
        async stat(p: string) {
          const f = files[p];
          return f ? { type: 'file' as const, ctime: 0, mtime: f.mtime, size: f.data.length } : null;
        },
      },
    },
  } as unknown as App;
}

const path = (hash: string) => `${CONTENT_DIR}/${hash}.bin`;
const DAY = 86_400_000;
const NOW = 1_000_000_000_000; // fixed injected clock

describe('ContentStore.gc — age-aware retention', () => {
  test('keeps referenced hashes always, keeps young unreferenced, deletes old unreferenced', async () => {
    const files: Record<string, { data: string; mtime: number }> = {
      // referenced + ancient → kept (reference wins over age)
      [path('ref-old')]: { data: 'A', mtime: NOW - 100 * DAY },
      // unreferenced + within window (younger than 30d) → kept
      [path('young')]: { data: 'B', mtime: NOW - 5 * DAY },
      // unreferenced + older than window → deleted
      [path('old')]: { data: 'C', mtime: NOW - 40 * DAY },
    };
    const store = new ContentStore(makeApp(files));
    const retentionMs = 30 * DAY;

    await store.gc(new Set(['ref-old']), retentionMs, NOW);

    expect(path('ref-old') in files).toBe(true);
    expect(path('young') in files).toBe(true);
    expect(path('old') in files).toBe(false);
  });

  test('keeps an unreferenced hash when its mtime is undatable (stat returns null)', async () => {
    const files: Record<string, { data: string; mtime: number }> = {
      [path('dateless')]: { data: 'X', mtime: NaN },
    };
    const app = makeApp(files);
    // Force stat to report no mtime for this blob.
    (app.vault.adapter as unknown as { stat: (p: string) => Promise<null> }).stat =
      async () => null;
    const store = new ContentStore(app);

    await store.gc(new Set(), 30 * DAY, NOW);

    expect(path('dateless') in files).toBe(true); // conservative keep
  });
});
