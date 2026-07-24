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
import { nowMs } from './perf-clock';

/** Optional per-`putNew` sub-phase accumulator (first-enable capture diagnostics,
 *  A3 §3.2). When set on a {@link ContentStore}, `putNew` adds the base64-encode time
 *  here so `main.ts` can attribute how much of `putMs` is CPU encode vs the native
 *  `MetadataStore.write` (whose own sub-split — write-tmp / exists / rename — the
 *  Obsidian adapter records separately). Null by default → zero overhead. */
export interface PutPerf {
  encodeMs: number; // Σ uint8ToBase64
}

// Re-exported so existing importers of these names from content-store keep working.
export { uint8ToBase64, base64ToUint8 };

const CONTENT_DIR = '.vault-sync/content';
// Packed-blob storage (A3 pack-writes). The first-enable capture buffers blobs and
// appends them in large per-checkpoint **packs** instead of one loose `.bin` per file,
// cutting ~8389 native writes to ~2 per 200-blob chunk. Confirmed on device: `append`
// is O(delta) (append-bench ratio 0.4), so 42 chunk-appends ≈ 1.1 s vs ~56 s of loose
// writes. See docs/pack-writes-spec.md. `pack` is NOT a 2-hex shard name, so the loose
// `listHashes` shard sweep never mistakes a pack/index file for a blob.
const PACK_DIR = `${CONTENT_DIR}/pack`;
const PACK_INDEX_PATH = `${PACK_DIR}/index`;

/** Where a packed blob's base64 body lives: which pack, the char offset of the body
 *  within it, and the body's char length. base64 is ASCII so char offset == byte
 *  offset; `pack.substr(offset, len)` slices the body with no delimiter scan. */
interface PackLoc {
  packId: string;
  offset: number;
  len: number;
}

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

  // ── Packed-blob state (A3 pack-writes) ──────────────────────────────────────
  // In-memory index of every packed blob's location, loaded from `pack/index` at
  // `init()` and extended by `flushPack`. Authoritative for the session; the on-disk
  // append-only `index` file is its durable mirror.
  private index: Map<string, PackLoc> = new Map();
  // Blobs `putNew` has buffered but not yet appended to a pack. Flushed (and cleared)
  // by `flushPack` at each capture checkpoint. Bounded to one chunk of base64 (~MB).
  private packBuffer: Array<{ hash: string; b64: string }> = [];
  // Monotonic per-chunk pack id, resumed past any pack already on disk at `init()` so
  // a new session never reuses an id and clobbers a pack.
  private nextPackId = 0;
  // `pack/` dir ensured once per session (mirrors `ensuredShards`).
  private packDirEnsured = false;

  /** When non-null, `putNew` accumulates its base64-encode time here (A3 capture
   *  diagnostics). Set by `main.ts` around the first-enable capture; null otherwise. */
  capturePutPerf: PutPerf | null = null;

  constructor(private metadata: MetadataStore) {}

  async init(): Promise<void> {
    if (!(await this.metadata.exists(CONTENT_DIR))) {
      await this.metadata.mkdir(CONTENT_DIR);
    }
    await this.loadPackIndex();
  }

  /**
   * Rebuild the in-memory pack index from the on-disk `pack/index` (append-only) and
   * resume the pack-id counter past any pack already on disk. Called once at `init()`.
   *
   * Torn-append tolerant, exactly like the version-DAG journal reader: a crash mid-
   * flush can leave a short/garbled *trailing* line, which fails the field/number
   * guards and is dropped — that blob then reads as missing (`get` returns null) and
   * is simply re-captured next enable (F1-safe, never corrupt). Interior lines can't
   * tear (append only ever cuts the end).
   */
  private async loadPackIndex(): Promise<void> {
    const raw = await this.metadata.read(PACK_INDEX_PATH);
    if (raw !== null) {
      for (const line of raw.split('\n')) {
        if (line === '') continue;
        const parts = line.split(' ');
        if (parts.length !== 4) continue; // torn/partial trailing line → drop
        const [hash, packId, off, len] = parts;
        const offset = Number(off);
        const length = Number(len);
        if (!hash || !packId || !Number.isFinite(offset) || !Number.isFinite(length)) continue;
        this.index.set(hash, { packId, offset, len: length });
      }
    }
    // Resume the counter past the highest existing pack (packs may exist that the
    // torn index doesn't fully cover, so scan the dir rather than trust the index).
    let maxId = -1;
    for (const p of await this.metadata.list(PACK_DIR)) {
      const m = (p.split('/').pop() ?? '').match(/^(\d+)\.pack$/);
      if (m) maxId = Math.max(maxId, Number(m[1]));
    }
    this.nextPackId = maxId + 1;
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

  /**
   * Bulk-write path for a KNOWN-EMPTY store (first-enable capture, C2). Skips the
   * per-write `exists` disk probe that {@link put} uses to dedup: on a fresh store
   * that probe is *always* a miss — one wasted native round-trip per file, and the
   * write phase is ~74% of the first-enable capture with the `exists` stat a rough
   * third of it (docs/startup-capture-optimization-spec.md §4.2, measured A3 split).
   *
   * Safe because a content-addressed write is idempotent: a hash names its exact
   * bytes, so overwriting an already-present blob rewrites byte-identical content —
   * it can never corrupt an existing blob. Still dedups *within the session* via
   * `memCache` (an in-memory check, no disk round-trip), so duplicate-content files
   * write each distinct hash at most once per checkpoint window. Use ONLY where the
   * store is known-empty (the first-enable pass); the steady-state {@link put} keeps
   * its disk `exists` dedup for the general case.
   */
  async putNew(hash: string, content: Uint8Array): Promise<void> {
    // A memCache hit means this blob was already written (put/putNew), buffered, or
    // loaded (get) this session — all imply it is on disk or about to be — so it is
    // redundant. (Cross-session dedup: a blob already in a prior pack is skipped by the
    // capture's own `entry.contentHash === hash` gate before putNew is even called.)
    if (this.memCache.has(hash)) return;
    this.memCache.set(hash, content);
    const t = nowMs();
    const b64 = uint8ToBase64(content);
    if (this.capturePutPerf) this.capturePutPerf.encodeMs += nowMs() - t;
    // Pack-writes (A3): buffer the encoded blob instead of issuing a per-blob native
    // write. The buffer is appended to a pack in one native call per checkpoint by
    // `flushPack` (which the capture loop calls before each `saveOpLog`), so ~8389
    // serial writes collapse to ~2 appends per 200-blob chunk. No I/O here — just the
    // base64 encode (CPU) + a RAM push, bounded to one chunk by the checkpoint flush.
    this.packBuffer.push({ hash, b64 });
  }

  /**
   * Append the buffered blobs to a fresh **pack** file (one native append) and their
   * locations to the `pack/index` (a second append), then clear the buffer. A no-op on
   * an empty buffer, so the capture loop can call it unconditionally at every checkpoint.
   *
   * **Per-chunk packs.** Each flush writes a brand-new `pack/<id>.pack` (never appended
   * to again), so a whole-pack `get` reads at most one chunk (≤200 blobs) and the
   * append cost is irrelevant for the pack body (written once); only the small `index`
   * is appended repeatedly, and device measurement shows those small appends are flat/
   * O(delta) (append-bench). Two native writes per 200-blob chunk vs 200 before.
   *
   * **Ordering (blob-before-op, spec §4).** The capture loop calls this *before* the
   * chunk's `registry.flush()` / `saveOpLog()`, so every blob an op references is durable
   * before that op is journalled. A crash between the two appends leaves either an
   * unindexed pack (blobs read as missing → re-captured) or an index line pointing past
   * a torn pack body (hash-verify on read → missing) — F1-safe, never corrupt.
   */
  async flushPack(): Promise<void> {
    if (this.packBuffer.length === 0) return;
    const packId = String(this.nextPackId++);
    let packBody = '';
    let idxDelta = '';
    for (const { hash, b64 } of this.packBuffer) {
      const header = `${hash} ${b64.length}\n`;
      const offset = packBody.length + header.length; // char offset of the body
      packBody += header + b64 + '\n';
      this.index.set(hash, { packId, offset, len: b64.length });
      idxDelta += `${hash} ${packId} ${offset} ${b64.length}\n`;
    }
    await this.ensurePackDir();
    await this.metadata.append(this.packPath(packId), packBody);
    await this.metadata.append(PACK_INDEX_PATH, idxDelta);
    this.packBuffer = [];
  }

  /** Retrieve content by hash. Returns null if not found — or if the stored bytes fail
   *  to hash back to `hash` (a torn blob from an interrupted non-atomic `putNew` write,
   *  C4). Treating a corrupt blob as *missing* is the safety net that lets the content
   *  store use a non-atomic direct write: the merge sees a missing base and degrades to a
   *  conflict (F1) rather than three-way-merging against corrupt bytes. Verification runs
   *  only on the disk path — memCache content was just written/verified in-process, and
   *  blob reads are rare (merge bases) so the extra SHA-256 (0.16 ms) is immaterial. */
  async get(hash: string): Promise<Uint8Array | null> {
    const cached = this.memCache.get(hash);
    if (cached) return cached;

    const raw = await this.metadata.read(this.contentPath(hash));
    if (raw !== null) {
      const content = base64ToUint8(raw);
      // Integrity check: a content hash names its exact bytes, so a mismatch means the
      // blob is torn/corrupt. Don't cache it and don't return it — report missing (F1).
      if ((await hashContent(content)) !== hash) return null;
      this.memCache.set(hash, content);
      return content;
    }
    // Loose miss → try the packs (A3). Steady-state edits stay loose, so this only
    // fires for capture-packed blobs (merge bases, on-conflict reads, the push stage).
    return this.getFromPack(hash);
  }

  /**
   * Extract a packed blob, hash-verifying it (C4, per blob) exactly as the loose path
   * does. Whole-pack amortization: reading the pack caches **every** blob it holds, so a
   * round that reads many blobs from one pack pays a single native read (mitigates the
   * lack of a ranged-read primitive — spec §3.3). Returns null if the blob is unknown,
   * its pack is gone, or its bytes fail to hash back (torn tail → missing, F1-safe).
   */
  private async getFromPack(hash: string): Promise<Uint8Array | null> {
    const loc = this.index.get(hash);
    if (!loc) return null;
    const pack = await this.metadata.read(this.packPath(loc.packId));
    if (pack === null) return null;
    for (const [h, l] of this.index) {
      if (l.packId !== loc.packId || this.memCache.has(h)) continue;
      const body = pack.substr(l.offset, l.len);
      if (body.length !== l.len) continue; // truncated/torn record → skip (reads missing)
      const content = base64ToUint8(body);
      if ((await hashContent(content)) === h) this.memCache.set(h, content);
    }
    return this.memCache.get(hash) ?? null;
  }

  /** Check if content is available without loading it. */
  async has(hash: string): Promise<boolean> {
    if (this.memCache.has(hash)) return true;
    if (this.index.has(hash)) return true;
    return this.metadata.exists(this.contentPath(hash));
  }

  /** Remove content by hash. Drops it from the memCache, the loose `.bin` (if present),
   *  and the pack index. A packed blob's *bytes* stay in the pack (no in-place edit), but
   *  dropping the index entry makes it read as missing (`get`/`has` miss) and reclaims the
   *  space when whole-pack GC later retires the pack; the index rewrite keeps that durable
   *  across a reload. Loose-only deletes (the GC hot path) never touch the index. */
  async delete(hash: string): Promise<void> {
    this.memCache.delete(hash);
    const path = this.contentPath(hash);
    if (await this.metadata.exists(path)) {
      await this.metadata.remove(path);
    }
    if (this.index.delete(hash)) await this.rewriteIndex();
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
    const hashes = new Set<string>(await this.listLooseHashes());
    // GC safety (spec §4): the keep-set must see *packed* hashes too, or GC would
    // ignore them (or, worse, a naive loose delete would leave them stranded). Union
    // in the in-memory index keys — the durable mirror of every packed blob.
    for (const hash of this.index.keys()) hashes.add(hash);
    return [...hashes];
  }

  /** The loose (`.bin`) hashes only — the 256-shard sweep. Split out so `gc` can route
   *  loose blobs through the per-blob mtime path and packed blobs through whole-pack
   *  retention (a packed hash has no `.bin` to `delete`). */
  private async listLooseHashes(): Promise<string[]> {
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
    // ── Loose (`.bin`) blobs — per-blob mtime retention (unchanged) ────────────
    for (const hash of await this.listLooseHashes()) {
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
    // ── Packed blobs — whole-pack retention (spec §3.5) ────────────────────────
    await this.gcPacks(keepHashes, retentionMs, now);
  }

  /**
   * A blob inside a pack can't be deleted individually (no in-place edit / ranged
   * write), so GC works at pack granularity: a pack is dropped only when **every** blob
   * it holds is unreferenced AND the pack file itself has aged past the window. First-
   * enable packs are mostly all-referenced (every captured file is live), so this frees
   * space once churn fully retires a chunk; a partially-live pack is kept whole (spec
   * §3.5 defers mark-and-compact). Conservative on datelessness, mirroring the loose path.
   */
  private async gcPacks(keepHashes: Set<string>, retentionMs: number, now: number): Promise<void> {
    const members = new Map<string, string[]>(); // packId → its blob hashes
    for (const [hash, loc] of this.index) {
      let list = members.get(loc.packId);
      if (!list) members.set(loc.packId, (list = []));
      list.push(hash);
    }
    let removedAny = false;
    for (const [packId, hashes] of members) {
      if (hashes.some(h => keepHashes.has(h))) continue; // any live blob → keep the pack
      let mtime: number | null = null;
      try {
        const stat = await this.metadata.stat(this.packPath(packId));
        mtime = stat?.mtime ?? null;
      } catch {
        mtime = null;
      }
      if (mtime === null || now - mtime < retentionMs) continue; // keep young/undatable
      await this.metadata.remove(this.packPath(packId));
      for (const h of hashes) {
        this.index.delete(h);
        this.memCache.delete(h);
      }
      removedAny = true;
    }
    // The `index` file is append-only during capture; a GC that drops packs is the one
    // place it's rewritten wholesale (rare, off the hot path) so it doesn't keep listing
    // dead blobs. Atomic `write` — a torn rewrite here would lose live index entries.
    if (removedAny) await this.rewriteIndex();
  }

  /** Rewrite `pack/index` from the surviving in-memory index (after a GC pack drop). */
  private async rewriteIndex(): Promise<void> {
    let body = '';
    for (const [hash, loc] of this.index) {
      body += `${hash} ${loc.packId} ${loc.offset} ${loc.len}\n`;
    }
    await this.metadata.write(PACK_INDEX_PATH, body);
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

  /** Ensure the `pack/` directory exists (once per session; mirrors `ensureShard`). */
  private async ensurePackDir(): Promise<void> {
    if (this.packDirEnsured) return;
    if (!(await this.metadata.exists(PACK_DIR))) {
      await this.metadata.mkdir(PACK_DIR);
    }
    this.packDirEnsured = true;
  }

  private packPath(packId: string): string {
    return `${PACK_DIR}/${packId}.pack`;
  }
}
