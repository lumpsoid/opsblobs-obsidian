// ─────────────────────────────────────────────
//  In-memory Fake Sync Server  (Phase 3 tests / Phase 7 harness)
// ─────────────────────────────────────────────
//
//  A minimal, dependency-free implementation of the ServerApi contract
//  (docs/server-api-spec.md §4–§5). Faithful to the parts the client depends on:
//  an append-only oplog with a monotonic per-vault `seq`, idempotent appends by
//  `clientOpId`, a content-addressed blob store, and the `blobs:check` /
//  `422-on-missing-blob` ordering constraint. It never decrypts anything.
//
//  Not obsidian-coupled, so it doubles as the P7 integration harness.

import { ServerApi, OpRecord, PullOpsResult, AppendOp, AppendResult, BlobUpload } from './server-sync';

/** Thrown for a `422` — the append referenced a blob that was never uploaded. */
export class MissingBlobError extends Error {
  constructor(public readonly hash: string) {
    super(`Blob ${hash} not present; upload blobs before ops`);
    this.name = 'MissingBlobError';
  }
}

/** Server cap above which a blob is "too large to be a key-check record": the
 *  preflight endpoint reports `keyCheck: null` rather than inlining it (fetch such
 *  blobs via the streaming single-blob GET instead). Mirrors the Go server's ~64 KiB. */
const KEYCHECK_INLINE_CAP = 64 * 1024;

export class FakeSyncServer implements ServerApi {
  private log: OpRecord[] = [];
  private blobs = new Map<string, Uint8Array>();
  private byClientOpId = new Map<string, number>(); // clientOpId → assigned seq
  private seq = 0;
  // Whether this account owns the vault. Mirrors the Go server, where *every*
  // endpoint but `preflight` runs `EnsureVaultAccess` and so claims an unclaimed
  // vault on first touch — reads included. `preflight` alone reads the ownership
  // verdict without staking one, which is what makes it safe to retry.
  private claimed = false;

  /** First touch claims the vault (the server's `EnsureVaultAccess`). Called by every
   *  endpoint except `preflight`. */
  private claim(): void {
    this.claimed = true;
  }

  async pullOps(since: number, limit: number): Promise<PullOpsResult> {
    this.claim();
    const after = this.log.filter(o => o.seq > since);
    const ops = after.slice(0, limit);
    const last = ops.length > 0 ? ops[ops.length - 1]!.seq : since;
    return { ops, nextCursor: last, hasMore: after.length > ops.length };
  }

  async appendOps(_baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
    this.claim();
    const assigned: Array<{ clientOpId: string; seq: number }> = [];
    for (const op of ops) {
      const prior = this.byClientOpId.get(op.clientOpId);
      if (prior !== undefined) {
        // Idempotent replay — return the existing seq, do not append again.
        assigned.push({ clientOpId: op.clientOpId, seq: prior });
        continue;
      }
      for (const ref of op.blobRefs) {
        if (!this.blobs.has(ref)) throw new MissingBlobError(ref);
      }
      const seq = ++this.seq;
      this.log.push({ seq, deviceId: '', ts: 0, ciphertext: op.ciphertext, blobRefs: op.blobRefs });
      this.byClientOpId.set(op.clientOpId, seq);
      assigned.push({ clientOpId: op.clientOpId, seq });
    }
    return { assigned, headCursor: this.seq };
  }

  async checkBlobs(hashes: string[]): Promise<{ missing: string[] }> {
    this.claim();
    return { missing: hashes.filter(h => !this.blobs.has(h)) };
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    this.claim();
    // Idempotent by hash — first write wins, re-puts are no-ops.
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes);
  }

  async putBlobBatch(blobs: BlobUpload[]): Promise<void> {
    this.claim();
    // Same idempotent, content-addressed store as putBlob — one call, many blobs.
    for (const b of blobs) {
      if (!this.blobs.has(b.hash)) this.blobs.set(b.hash, b.bytes);
    }
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    this.claim();
    return this.blobs.get(hash) ?? null;
  }

  async getBlobBatch(hashes: string[]): Promise<{ blobs: Map<string, Uint8Array>; missing: string[] }> {
    this.claim();
    // Download-side twin of putBlobBatch: return the bytes for every held hash
    // (once, even if requested twice) and list the rest as missing, in request order.
    const blobs = new Map<string, Uint8Array>();
    const missing: string[] = [];
    for (const hash of hashes) {
      const bytes = this.blobs.get(hash);
      if (bytes) blobs.set(hash, bytes);
      else missing.push(hash);
    }
    return { blobs, missing };
  }

  async preflight(keyCheckKey: string): Promise<{ claimed: boolean; keyCheck: Uint8Array | null }> {
    // The one endpoint that never claims: it reads the ownership verdict and stops.
    // Like the server, it skips the key-check lookup entirely for an unclaimed vault
    // (an unowned vault holds no blobs), and only honors a non-empty `keyCheckKey`.
    if (!this.claimed) return { claimed: false, keyCheck: null };
    const record = keyCheckKey ? this.blobs.get(keyCheckKey) ?? null : null;
    // A blob larger than a plausible record is treated as "not a key-check":
    // report null rather than inlining it (fetch large blobs via getBlob).
    const keyCheck = record && record.byteLength <= KEYCHECK_INLINE_CAP ? record : null;
    return { claimed: true, keyCheck };
  }

  // ── Test/harness introspection ────────────────────────────────────────────
  get opCount(): number { return this.log.length; }
  get blobCount(): number { return this.blobs.size; }
  get headSeq(): number { return this.seq; }
  /** Whether a touch has claimed the vault — the state `preflight` reports. */
  get isClaimed(): boolean { return this.claimed; }
}
