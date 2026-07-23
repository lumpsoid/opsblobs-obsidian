// ---------------------------------------------
//  Content Store
//  Phase 1.3
// ---------------------------------------------
//
//  Content-addressed storage for ancestor versions and pending content.
//  Stored at .vault-sync/content/<hash[0:2]>/<hash>.bin — sharded by the first
//  byte of the (hex) hash into 256 buckets (git-style). A single flat directory
//  crossed a Capacitor/Android directory-scaling wall past a few thousand blobs
//  (the ~3,500-file first-enable step, capture-optimization-spec §4); sharding
//  keeps every content-dir fs op on a directory of ≤ F/256 entries.
//  Uses Web Crypto SHA-256 (available on all platforms incl. iOS).

import { MetadataStore } from '../ports/metadata-store';
import { uint8ToBase64, base64ToUint8 } from './encoding';

// Re-exported so existing importers of these names from content-store keep working.
export { uint8ToBase64, base64ToUint8 };

const CONTENT_DIR = '.vault-sync/content';

// The 256 possible shard directory names ("00".."ff"). Content hashes are hex,
// so `hash[0:2]` is always one of these. `listHashes` sweeps this fixed set
// rather than enumerating subdirectories, because the port's `list()` is only
// guaranteed to return files *directly* under a dir (ObsidianMetadataStore
// discards `.folders`) — see the note on `listHashes`.
const SHARD_PREFIXES: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

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
  // Shard directories we've already ensured this session, so a batch capture
  // pays at most one `mkdir` per shard (256 max) instead of one per file.
  private ensuredShards: Set<string> = new Set();

  constructor(private metadata: MetadataStore) {}

  async init(): Promise<void> {
    if (!(await this.metadata.exists(CONTENT_DIR))) {
      await this.metadata.mkdir(CONTENT_DIR);
    }
  }

  /** Store content by hash. No-op if already present. */
  async put(hash: string, content: Uint8Array): Promise<void> {
    this.memCache.set(hash, content);
    const path = this.contentPath(hash);
    if (!(await this.metadata.exists(path))) {
      // The shard dir must exist before the write — `MetadataStore.write` does
      // not auto-mkdir parents, and `init()` only created CONTENT_DIR itself.
      await this.ensureShard(hash);
      // Convert Uint8Array → base64 for text-based storage
      await this.metadata.write(path, uint8ToBase64(content));
    }
  }

  /** Retrieve content by hash. Returns null if not found. */
  async get(hash: string): Promise<Uint8Array | null> {
    const cached = this.memCache.get(hash);
    if (cached) return cached;

    const raw = await this.metadata.read(this.contentPath(hash));
    if (raw === null) return null;
    const content = base64ToUint8(raw);
    this.memCache.set(hash, content);
    return content;
  }

  /** Check if content is available without loading it. */
  async has(hash: string): Promise<boolean> {
    if (this.memCache.has(hash)) return true;
    return this.metadata.exists(this.contentPath(hash));
  }

  /** Remove content by hash. */
  async delete(hash: string): Promise<void> {
    this.memCache.delete(hash);
    const path = this.contentPath(hash);
    if (await this.metadata.exists(path)) {
      await this.metadata.remove(path);
    }
  }

  /**
   * List all stored hashes. Sweeps the 256 known shard dirs and concatenates,
   * rather than listing CONTENT_DIR itself: `MetadataStore.list()` is only
   * guaranteed to return files *directly* under the given dir (the Obsidian
   * adapter discards `.folders`), so a single `list(CONTENT_DIR)` would return
   * nothing on device now that blobs live one level deeper — silently GC'ing
   * nothing. The prefix sweep is correct under both the recursive fake and the
   * one-level device semantics.
   */
  async listHashes(): Promise<string[]> {
    const hashes: string[] = [];
    for (const prefix of SHARD_PREFIXES) {
      const files = await this.metadata.list(`${CONTENT_DIR}/${prefix}`);
      for (const p of files) {
        const name = p.split('/').pop()?.replace('.bin', '') ?? '';
        if (name) hashes.push(name);
      }
    }
    return hashes;
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
        const stat = await this.metadata.stat(this.contentPath(hash));
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

  /** Ensure the shard directory for `hash` exists (once per shard per session). */
  private async ensureShard(hash: string): Promise<void> {
    const dir = `${CONTENT_DIR}/${hash.slice(0, 2)}`;
    if (this.ensuredShards.has(dir)) return;
    if (!(await this.metadata.exists(dir))) {
      await this.metadata.mkdir(dir);
    }
    this.ensuredShards.add(dir);
  }

  private contentPath(hash: string): string {
    return `${CONTENT_DIR}/${hash.slice(0, 2)}/${hash}.bin`;
  }
}
