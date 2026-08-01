// ---------------------------------------------
//  Content Store  (pack-only)
//  Phase 1.3 · A3 unify-on-packs
// ---------------------------------------------
//
//  Content-addressed storage for ancestor versions and pending content. Every blob
//  lives in a **pack** — many blobs per file — under `.opsblobs/content/pack/`:
//  a per-checkpoint `pack/<id>.pack` holds the base64 bodies, and an append-only
//  `pack/index` maps each hash → {pack, offset, len}. There is ONE on-disk format;
//  the loose one-file-per-blob layout was removed (unify-on-packs-spec).
//
//  Why packs only: on the Capacitor/Android bridge a native fs call is ~pure latency
//  independent of payload, so cost is native-call *count*. A loose write is one
//  `write` + one `exists` probe per blob (~8389 for an 8k-vault first enable, ~56 s);
//  buffering into a pack collapses a whole chunk to ~2 appends (~1.1 s). Loose was
//  never cheaper even for a single edit (break-even at one blob), so it is gone.
//
//  Uses Web Crypto SHA-256 (available on all platforms incl. iOS). Reads hash-verify
//  every extracted blob (C4): a torn blob reports as *missing* (F1), never corrupt
//  bytes into a merge — which is what lets packs use non-atomic appends.

import { MetadataStore } from '../ports/metadata-store';
import { uint8ToBase64, base64ToUint8 } from './encoding';
import { nowMs } from './perf-clock';

/** Optional per-`putBuffered` sub-phase accumulator (first-enable capture diagnostics,
 *  A3 §3.2). When set on a {@link ContentStore}, `putBuffered` adds the base64-encode
 *  time here so `main.ts` can attribute how much of `putMs` is CPU encode vs the native
 *  pack `append`. Null by default → zero overhead. */
export interface PutPerf {
  encodeMs: number; // Σ uint8ToBase64
}

// Re-exported so existing importers of these names from content-store keep working.
export { uint8ToBase64, base64ToUint8 };

const CONTENT_DIR = '.opsblobs/content';
// Packed-blob storage (A3). A first-enable capture buffers blobs and appends them in
// large per-checkpoint packs; steady-state edits and the sync applicator write through
// the same buffered path (`put` = buffer + immediate flush). `pack` is NOT a 2-hex
// name, so it never collides with a content hash. See docs/unify-on-packs-spec.md.
const PACK_DIR = `${CONTENT_DIR}/pack`;
const PACK_INDEX_PATH = `${PACK_DIR}/index`;

// Mark-and-compact threshold (spec §4.2): a pack is repacked only when its *live
// fraction* is below this — i.e. enough of it is dead superseded versions to be worth
// rewriting the survivors into a fresh pack and reclaiming the rest. Too high → churny
// repacking; too low → slow reclamation. Not load-bearing for correctness.
const COMPACT_LIVE_FRACTION = 0.5;

/**
 * Byte budget for the in-memory blob cache (§ memCache below). Sized to hold a few
 * whole packs (a 200-note pack of markdown is ~1 MB) so the whole-pack amortisation
 * `getFromPack` relies on still pays off across a sync round, while staying well
 * under what Obsidian mobile can absorb. Not load-bearing for correctness — every
 * cached blob is durable in a pack, so an eviction only costs a re-read + C4
 * re-verify. Exported so tests can reason about it; the constructor takes an
 * override so a test can drive eviction with a handful of tiny blobs.
 */
export const MEM_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

/** Where a packed blob's base64 body lives: which pack, the char offset of the body
 *  within it, and the body's char length. base64 is ASCII so char offset == byte
 *  offset; `pack.substr(offset, len)` slices the body with no delimiter scan. */
interface PackLoc {
  packId: string;
  offset: number;
  len: number;
}

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
  // In-memory cache to avoid repeated disk reads during a single sync session.
  //
  // **Bounded, LRU.** The store outlives every pass (one instance per plugin load), and
  // a steady-state round applies far fewer items than a `PackCheckpoint` needs to fire,
  // so nothing was ever dropping this: each round staged more, `keepWarm` skipped the
  // terminal clear, and `getFromPack` pins a WHOLE pack per single-blob lookup. That is
  // unbounded RAM growth for the life of the plugin. So the cache carries a byte budget
  // ({@link MEM_CACHE_BUDGET_BYTES}) and evicts least-recently-used entries past it —
  // which keeps the whole-pack amortisation (the reason `getFromPack` caches greedily)
  // safe instead of merely tolerated. Map iteration order is insertion order, and a
  // cache hit re-inserts, so the front of the map is the LRU end.
  private memCache: Map<string, Uint8Array> = new Map();
  // Σ byteLength of everything in `memCache`, maintained on every insert/evict/delete
  // so the budget check is O(1) rather than a walk.
  private memBytes = 0;

  // ── Packed-blob state (A3) ──────────────────────────────────────────────────
  // In-memory index of every packed blob's location, loaded from `pack/index` at
  // `init()` and extended by `flushPack`. Authoritative for the session; the on-disk
  // append-only `index` file is its durable mirror.
  private index: Map<string, PackLoc> = new Map();
  // Blobs `putBuffered` has buffered but not yet appended to a pack. Flushed (and
  // cleared) by `flushPack` at each checkpoint / on every `put`. Bounded to one chunk
  // of base64 (~MB).
  private packBuffer: Array<{ hash: string; b64: string }> = [];
  // Hashes currently in `packBuffer`. Two jobs: (a) eviction skips them — a buffered
  // blob is not durable yet, and dropping it would let a second `putBuffered` of the
  // same hash re-buffer the same bytes into the pack; (b) it stands in for the memCache
  // dedup guard in `putBuffered` once eviction can remove a still-pending entry.
  private pending: Set<string> = new Set();
  // Monotonic per-chunk pack id, resumed past any pack already on disk at `init()` so
  // a new session never reuses an id and clobbers a pack.
  private nextPackId = 0;
  // `pack/` dir ensured once per session.
  private packDirEnsured = false;

  /** When non-null, `putBuffered` accumulates its base64-encode time here (A3 capture
   *  diagnostics). Set by `main.ts` around the first-enable capture; null otherwise. */
  capturePutPerf: PutPerf | null = null;

  /**
   * @param metadata      vault-metadata port the packs live on.
   * @param memBudgetBytes  in-memory blob-cache ceiling; see {@link MEM_CACHE_BUDGET_BYTES}.
   */
  constructor(
    private metadata: MetadataStore,
    private readonly memBudgetBytes: number = MEM_CACHE_BUDGET_BYTES,
  ) {}

  /** Bytes currently held in the in-memory blob cache. Diagnostics + tests: this is the
   *  number that must NOT trend upward across sync rounds. */
  get memCacheBytes(): number {
    return this.memBytes;
  }

  /** Entry count of the in-memory blob cache (diagnostics + tests). */
  get memCacheEntries(): number {
    return this.memCache.size;
  }

  /** Insert (or refresh) a cached blob and evict LRU entries until the budget holds. */
  private cacheSet(hash: string, content: Uint8Array): void {
    const prev = this.memCache.get(hash);
    if (prev) this.memBytes -= prev.byteLength;
    this.memCache.delete(hash); // re-insert at the MRU end
    this.memCache.set(hash, content);
    this.memBytes += content.byteLength;
    this.evictToBudget();
  }

  /** Drop a cached blob, keeping the byte counter honest. */
  private cacheDelete(hash: string): void {
    const prev = this.memCache.get(hash);
    if (!prev) return;
    this.memBytes -= prev.byteLength;
    this.memCache.delete(hash);
  }

  /**
   * Evict from the LRU end until the cache fits its budget. Pending (buffered-not-yet-
   * flushed) blobs are skipped — they are the one thing the cache is *authoritative*
   * for. So the ceiling is `budget + one checkpoint's worth of buffered blobs`, the
   * same bound the pack buffer itself already carries; it drains at the next
   * `flushPack`. Stops when nothing evictable remains (never spins).
   */
  private evictToBudget(): void {
    if (this.memBytes <= this.memBudgetBytes) return;
    for (const [hash, content] of this.memCache) {
      if (this.memBytes <= this.memBudgetBytes) return;
      if (this.pending.has(hash)) continue;
      this.memBytes -= content.byteLength;
      this.memCache.delete(hash);
    }
  }

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
   * tear (append only ever cuts the end). A duplicate hash (e.g. a re-appended or
   * compacted blob) is resolved last-wins, so the freshest location prevails.
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

  /**
   * Buffer a blob for the next pack — NO I/O. The single write primitive: both bulk
   * writers (first-enable capture; the sync applicator) and the steady-state {@link put}
   * go through here. A memCache or `pending` hit means the blob was already written,
   * buffered, or loaded this session — all imply it is on disk or about to be — so it is
   * a no-op. (An LRU eviction can drop a cached blob, so a later re-put may re-append
   * bytes that are already packed; the index resolves that last-wins, exactly as it does
   * for a blob re-captured in a later session.)
   *
   * Bulk writers call this in a loop and `flushPack()` once per checkpoint, amortising
   * to ~2 native writes per chunk. The base64 encode (CPU) + a RAM push are the only
   * cost here; the buffer is bounded to one chunk by the flush.
   */
  async putBuffered(hash: string, content: Uint8Array): Promise<void> {
    if (this.memCache.has(hash) || this.pending.has(hash)) return;
    const t = nowMs();
    const b64 = uint8ToBase64(content);
    if (this.capturePutPerf) this.capturePutPerf.encodeMs += nowMs() - t;
    // Mark pending BEFORE caching so this blob is eviction-proof until it is flushed.
    this.pending.add(hash);
    this.cacheSet(hash, content);
    this.packBuffer.push({ hash, b64 });
  }

  /**
   * Durable single-blob write (steady-state edits): buffer + flush immediately, so the
   * blob is on disk (its own 1-blob pack) before its referencing op is journalled —
   * the same blob-before-op ordering the old loose write gave. A no-op if already
   * present (buffer stays empty → `flushPack` is itself a no-op). The 1-blob packs a
   * stream of edits produces are folded back together by mark-and-compact (§4).
   */
  async put(hash: string, content: Uint8Array): Promise<void> {
    await this.putBuffered(hash, content);
    await this.flushPack();
  }

  /**
   * Append the buffered blobs to a fresh **pack** file (one native append) and their
   * locations to the `pack/index` (a second append), then clear the buffer. A no-op on
   * an empty buffer, so callers can invoke it unconditionally at every checkpoint.
   *
   * **Per-chunk packs.** Each flush writes a brand-new `pack/<id>.pack` (never appended
   * to again), so a whole-pack `get` reads at most one chunk and the append cost is
   * irrelevant for the pack body (written once); only the small `index` is appended
   * repeatedly, and device measurement shows those small appends are flat/O(delta).
   *
   * **Ordering (blob-before-op, spec §3).** Callers flush *before* the referencing op
   * is journalled, so every blob an op references is durable before that op. A crash
   * between the two appends leaves either an unindexed pack (blobs read as missing →
   * re-captured) or an index line pointing past a torn pack body (hash-verify on read →
   * missing) — F1-safe, never corrupt.
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
    // These blobs are durable now, so they lose their eviction exemption. Re-apply the
    // budget: a bulk pass parks a whole checkpoint's worth of pending blobs above it.
    this.pending.clear();
    this.evictToBudget();
  }

  /** Retrieve content by hash. Returns null if not found — or if the stored bytes fail
   *  to hash back to `hash` (a torn blob from an interrupted append, C4). Treating a
   *  corrupt blob as *missing* is the safety net that lets the store use non-atomic
   *  appends: the merge sees a missing base and degrades to a conflict (F1) rather than
   *  three-way-merging against corrupt bytes. */
  async get(hash: string): Promise<Uint8Array | null> {
    const cached = this.memCache.get(hash);
    if (cached) {
      // Re-insert at the MRU end so the LRU order reflects reads, not just writes.
      this.memCache.delete(hash);
      this.memCache.set(hash, cached);
      return cached;
    }
    return this.getFromPack(hash);
  }

  /**
   * Extract a packed blob, hash-verifying it (C4, per blob). Whole-pack amortization:
   * reading the pack caches **every** blob it holds, so a round that reads many blobs
   * from one pack pays a single native read (mitigates the lack of a ranged-read
   * primitive). Returns null if the blob is unknown, its pack is gone, or its bytes
   * fail to hash back (torn tail → missing, F1-safe).
   */
  private async getFromPack(hash: string): Promise<Uint8Array | null> {
    const loc = this.index.get(hash);
    if (!loc) return null;
    const pack = await this.metadata.read(this.packPath(loc.packId));
    if (pack === null) return null;
    // Hold the requested blob locally: a pack larger than the cache budget can evict it
    // again before the loop ends, and the caller must still get its bytes.
    let found: Uint8Array | null = this.memCache.get(hash) ?? null;
    for (const [h, l] of this.index) {
      if (l.packId !== loc.packId || this.memCache.has(h)) continue;
      const body = pack.substr(l.offset, l.len);
      if (body.length !== l.len) continue; // truncated/torn record → skip (reads missing)
      const content = base64ToUint8(body);
      if ((await hashContent(content)) !== h) continue;
      if (h === hash) found = content;
      this.cacheSet(h, content);
    }
    return found;
  }

  /** Check if content is available without loading it. */
  async has(hash: string): Promise<boolean> {
    return this.memCache.has(hash) || this.index.has(hash);
  }

  /** Remove content by hash. Drops it from the memCache and the pack index; the blob's
   *  *bytes* stay in the pack (no in-place edit), but dropping the index entry makes it
   *  read as missing (`get`/`has` miss) and the space is reclaimed when GC later retires
   *  or compacts the pack. The index rewrite keeps the drop durable across a reload. */
  async delete(hash: string): Promise<void> {
    this.cacheDelete(hash);
    if (this.index.delete(hash)) await this.rewriteIndex();
  }

  /**
   * List all stored hashes. Pack-only ⇒ the in-memory index keys are the complete,
   * durable mirror of every packed blob — `[...index.keys()]` is complete by
   * construction, which is exactly the GC-safety property `listHashes` must hold
   * (miss a hash and GC either deletes live blobs or leaks dead ones).
   */
  async listHashes(): Promise<string[]> {
    return [...this.index.keys()];
  }

  /**
   * Garbage-collect stored content (pack-only). A blob is *live* if `keepHashes.has(hash)`
   * (registry-referenced live content + DAG-reachable merge bases). Age is taken at pack
   * granularity — a pack's blobs are written together so they age together — via two
   * mechanisms, both off the hot path (GC runs from `clearContentCache`):
   *
   *   4.1 **Whole-pack retirement.** A pack with NO live blob that has aged past the
   *       window is removed outright.
   *   4.2 **Mark-and-compact.** An aged pack holding a *mix* of live and dead blobs whose
   *       live fraction is below {@link COMPACT_LIVE_FRACTION} is rewritten: its live
   *       blobs move to a fresh pack, the old pack is dropped, reclaiming the dead bytes
   *       a cold-but-live blob was pinning (the precise reclamation loose gave, batched).
   *
   * `now` is injected (never `Date.now()` here) so the window is deterministic under
   * test. An undatable pack (stat null/throws) is kept — we don't delete what we can't
   * date. `keepHashes` is authoritative: a live blob is always carried forward.
   */
  async gc(keepHashes: Set<string>, retentionMs: number, now: number): Promise<void> {
    const members = new Map<string, string[]>(); // packId → its blob hashes
    for (const [hash, loc] of this.index) {
      let list = members.get(loc.packId);
      if (!list) members.set(loc.packId, (list = []));
      list.push(hash);
    }
    let dirty = false;
    const toCompact: string[] = [];
    for (const [packId, hashes] of members) {
      if (!(await this.packAged(packId, retentionMs, now))) continue; // young/undatable → keep whole
      const liveCount = hashes.reduce((n, h) => n + (keepHashes.has(h) ? 1 : 0), 0);
      if (liveCount === 0) {
        // 4.1 Whole-pack retirement — no live blob and aged.
        await this.metadata.remove(this.packPath(packId));
        for (const h of hashes) {
          this.index.delete(h);
          this.cacheDelete(h);
        }
        dirty = true;
      } else if (liveCount < hashes.length && liveCount / hashes.length < COMPACT_LIVE_FRACTION) {
        // 4.2 Mark-and-compact — aged, mixed, and mostly dead. Deferred so retirements
        // finish first and each compaction re-buffers at most one pack's live blobs.
        toCompact.push(packId);
      }
      // Aged-but-mostly-live (or fully live) packs are kept whole.
    }
    for (const packId of toCompact) {
      await this.compactPack(packId, keepHashes);
      dirty = true;
    }
    // Fold retirements + compaction drops into a clean, durable index (append-only in
    // steady state; the wholesale rewrite happens only here). Atomic `write`.
    if (dirty) await this.rewriteIndex();
  }

  /**
   * Rewrite the live blobs of `packId` into a fresh pack and drop the old one, reclaiming
   * the dead bytes a cold-but-live blob was pinning. Ordering (§4.2): the fresh pack +
   * its index delta are made durable (via `flushPack`) BEFORE the old pack is removed,
   * so a crash mid-compact leaves the live blob reachable via *either* pack (the new
   * index entry wins last-on-reload), never neither. Bounded: re-buffers ≤ one pack.
   */
  private async compactPack(packId: string, keepHashes: Set<string>): Promise<void> {
    // Members still pointing at this pack (live + dead), snapshotted from the index.
    const packMembers: string[] = [];
    for (const [h, loc] of this.index) if (loc.packId === packId) packMembers.push(h);
    const live = packMembers.filter(h => keepHashes.has(h));
    // Re-buffer each live blob. `get` whole-pack-reads the old pack once, hash-verifies
    // per blob (C4), and caches; a torn/missing blob returns null and is simply dropped
    // (F1-safe). Push straight into the buffer, bypassing putBuffered's dedup guard.
    for (const h of live) {
      const bytes = await this.get(h);
      if (bytes === null) continue;
      this.pending.add(h); // mirrors packBuffer — keeps it eviction-exempt until flushed
      this.packBuffer.push({ hash: h, b64: uint8ToBase64(bytes) });
    }
    await this.flushPack(); // durable: reassigns each live hash's index entry to the new pack
    await this.metadata.remove(this.packPath(packId));
    // Drop the members still pointing at the now-removed old pack (the dead blobs, plus
    // any live blob that failed re-buffer); live blobs were repointed by flushPack.
    for (const h of packMembers) {
      if (this.index.get(h)?.packId === packId) {
        this.index.delete(h);
        this.cacheDelete(h);
      }
    }
  }

  /** Whether `packId`'s file has aged past the retention window. Undatable (stat
   *  null/throws) → false (conservative keep, mirroring the old loose path). */
  private async packAged(packId: string, retentionMs: number, now: number): Promise<boolean> {
    let mtime: number | null = null;
    try {
      const stat = await this.metadata.stat(this.packPath(packId));
      mtime = stat?.mtime ?? null;
    } catch {
      mtime = null;
    }
    if (mtime === null) return false;
    return now - mtime >= retentionMs;
  }

  /** Rewrite `pack/index` from the surviving in-memory index (after a GC retire/compact).
   *  Atomic `write` — a torn rewrite here would lose live index entries. */
  private async rewriteIndex(): Promise<void> {
    let body = '';
    for (const [hash, loc] of this.index) {
      body += `${hash} ${loc.packId} ${loc.offset} ${loc.len}\n`;
    }
    await this.metadata.write(PACK_INDEX_PATH, body);
  }

  /** Drop the whole in-memory blob cache (bulk-pass checkpoints). The LRU budget already
   *  bounds RAM, so this is now an optimisation — release a pass's working set at once
   *  rather than paying for it to age out — not the only thing keeping the cache finite.
   *  `packBuffer`/`pending` are untouched: buffered bytes live in the buffer itself. */
  clearMemCache(): void {
    this.memCache.clear();
    this.memBytes = 0;
  }

  /** Ensure the `pack/` directory exists (once per session). */
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
