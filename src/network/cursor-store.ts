// ─────────────────────────────────────────────
//  Cursor persistence  (Phase 2 — moved out of server-http.ts)
// ─────────────────────────────────────────────
//
//  Persists the scalar sync cursor (spec §D3) at `.vault-sync/sync-cursor.json`.
//  A single integer: the highest server `seq` this device has consumed. `0` means
//  "seen nothing" — a fresh device replays the whole log. Backed by a
//  `MetadataStore` port so it's obsidian-free and directly testable.

import { MetadataStore } from '../ports/metadata-store';

const CURSOR_PATH = '.vault-sync/sync-cursor.json';

export class CursorStore {
  constructor(private metadata: MetadataStore) {}

  async load(): Promise<number> {
    const raw = await this.metadata.read(CURSOR_PATH);
    if (raw === null) return 0;
    try {
      const parsed = (JSON.parse(raw) as { cursor?: number }).cursor;
      return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  async save(cursor: number): Promise<void> {
    if (!(await this.metadata.exists('.vault-sync'))) {
      await this.metadata.mkdir('.vault-sync');
    }
    await this.metadata.write(CURSOR_PATH, JSON.stringify({ cursor }));
  }
}
