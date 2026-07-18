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

import { ServerApi, OpRecord, PullOpsResult, AppendOp, AppendResult } from './server-sync';

/** Thrown for a `422` — the append referenced a blob that was never uploaded. */
export class MissingBlobError extends Error {
  constructor(public readonly hash: string) {
    super(`Blob ${hash} not present; upload blobs before ops`);
    this.name = 'MissingBlobError';
  }
}

export class FakeSyncServer implements ServerApi {
  private log: OpRecord[] = [];
  private blobs = new Map<string, Uint8Array>();
  private byClientOpId = new Map<string, number>(); // clientOpId → assigned seq
  private seq = 0;

  async pullOps(since: number, limit: number): Promise<PullOpsResult> {
    const after = this.log.filter(o => o.seq > since);
    const ops = after.slice(0, limit);
    const last = ops.length > 0 ? ops[ops.length - 1]!.seq : since;
    return { ops, nextCursor: last, hasMore: after.length > ops.length };
  }

  async appendOps(_baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
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
    return { missing: hashes.filter(h => !this.blobs.has(h)) };
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    // Idempotent by hash — first write wins, re-puts are no-ops.
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes);
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash) ?? null;
  }

  // ── Test/harness introspection ────────────────────────────────────────────
  get opCount(): number { return this.log.length; }
  get blobCount(): number { return this.blobs.size; }
  get headSeq(): number { return this.seq; }
}
