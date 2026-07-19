// ---------------------------------------------
//  Content Store
//  Phase 1.3
// ---------------------------------------------
//
//  Content-addressed storage for ancestor versions and pending content.
//  Stored at .vault-sync/content/<hash>.bin
//  Uses Web Crypto SHA-256 (available on all platforms incl. iOS).

import { App, normalizePath } from 'obsidian';
import { uint8ToBase64, base64ToUint8 } from './encoding';

// Re-exported so existing importers of these names from content-store keep working.
export { uint8ToBase64, base64ToUint8 };

const CONTENT_DIR = '.vault-sync/content';

export async function hashContent(content: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', content);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashString(s: string): Promise<string> {
  return hashContent(new TextEncoder().encode(s));
}

export class ContentStore {
  // In-memory cache to avoid repeated disk reads during a single sync session
  private memCache: Map<string, Uint8Array> = new Map();

  constructor(private app: App) {}

  async init(): Promise<void> {
    const dir = normalizePath(CONTENT_DIR);
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  /** Store content by hash. No-op if already present. */
  async put(hash: string, content: Uint8Array): Promise<void> {
    this.memCache.set(hash, content);
    const path = this.contentPath(hash);
    if (!(await this.app.vault.adapter.exists(path))) {
      // Convert Uint8Array → base64 for text-based storage
      await this.app.vault.adapter.write(path, uint8ToBase64(content));
    }
  }

  /** Retrieve content by hash. Returns null if not found. */
  async get(hash: string): Promise<Uint8Array | null> {
    const cached = this.memCache.get(hash);
    if (cached) return cached;

    const path = this.contentPath(hash);
    try {
      const raw = await this.app.vault.adapter.read(path);
      const content = base64ToUint8(raw);
      this.memCache.set(hash, content);
      return content;
    } catch {
      return null;
    }
  }

  /** Check if content is available without loading it. */
  async has(hash: string): Promise<boolean> {
    if (this.memCache.has(hash)) return true;
    return this.app.vault.adapter.exists(this.contentPath(hash));
  }

  /** Remove content by hash. */
  async delete(hash: string): Promise<void> {
    this.memCache.delete(hash);
    const path = this.contentPath(hash);
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  /** List all stored hashes. */
  async listHashes(): Promise<string[]> {
    const dir = normalizePath(CONTENT_DIR);
    try {
      const result = await this.app.vault.adapter.list(dir);
      return result.files
        .map(p => p.split('/').pop()?.replace('.bin', '') ?? '')
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Garbage-collect stored content. A hash is retained when it is either:
   *   - still referenced (`keepHashes`) — always kept, regardless of age; or
   *   - younger than the retention window (`now - mtime < retentionMs`).
   * Everything else is deleted. `now` is injected (never `Date.now()` here) so
   * the retention window is deterministic under test. If a blob's mtime can't be
   * determined (stat null/throws) it is kept — we don't delete what we can't date.
   * Call after a successful sync when ancestor hashes are updated.
   */
  async gc(keepHashes: Set<string>, retentionMs: number, now: number): Promise<void> {
    const all = await this.listHashes();
    for (const hash of all) {
      if (keepHashes.has(hash)) continue;
      let mtime: number | null = null;
      try {
        const stat = await this.app.vault.adapter.stat(this.contentPath(hash));
        mtime = stat?.mtime ?? null;
      } catch {
        mtime = null;
      }
      // Conservative: keep anything we can't date, or that's within the window.
      if (mtime === null || now - mtime < retentionMs) continue;
      await this.delete(hash);
    }
  }

  clearMemCache(): void {
    this.memCache.clear();
  }

  private contentPath(hash: string): string {
    return normalizePath(`${CONTENT_DIR}/${hash}.bin`);
  }
}
