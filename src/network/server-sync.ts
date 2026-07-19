// ─────────────────────────────────────────────
//  Server Transport Client  (Phase 3)
// ─────────────────────────────────────────────
//
//  The client half of docs/server-api-spec.md. Speaks to an *untrusted* server
//  that stores only ciphertext + routing metadata and never merges. A sync round
//  is a pull → merge → push flow retargeted onto the oplog endpoints (the shape
//  the retired P2P client used, now against the server rather than a peer).
//
//  This module is deliberately free of any `obsidian` import so it can be unit-
//  tested against an in-memory fake (see fake-server.ts). The two sides it talks
//  to are both interfaces:
//    · ServerApi     — the wire (HttpServerApi in prod, FakeSyncServer in tests)
//    · VaultSyncHost — the local vault (registry/content-store/applicator), so
//                      the orchestrator never touches Obsidian directly.

import { VaultState, FileEntry, MergeAction, Operation, HLC } from '../types';
import { HybridLogicalClock } from '../core/hlc';
import { hlcCompare } from '../core/hlc';
import { mergeVaultStates } from '../merge/state-merge';
import { VaultCrypto } from './encryption';

// ─── Wire records (server-facing; all ciphertext/hashes, no plaintext) ──────────

/** One appended, server-sequenced op. `ciphertext` decrypts to an {@link Operation}. */
export interface OpRecord {
  seq: number;
  deviceId: string;      // informational; the authoritative deviceId is inside ciphertext
  ts: number;            // server receive time (informational)
  ciphertext: string;    // base64 AES-GCM of the serialized Operation
  blobRefs: string[];    // blinded content hashes this op depends on
}

export interface PullOpsResult {
  ops: OpRecord[];
  nextCursor: number;
  hasMore: boolean;
}

/** An op the client wants to append. `clientOpId` makes the append idempotent. */
export interface AppendOp {
  clientOpId: string;
  ciphertext: string;
  blobRefs: string[];
}

export interface AppendResult {
  assigned: Array<{ clientOpId: string; seq: number }>;
  headCursor: number;
}

/**
 * The five spec endpoints (§4–§5). Implemented over `requestUrl` in prod
 * (HttpServerApi) and in memory for tests (FakeSyncServer). Blob bytes are the
 * *encrypted* envelope; hashes are already blinded by the caller.
 */
export interface ServerApi {
  pullOps(since: number, limit: number): Promise<PullOpsResult>;
  appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult>;
  checkBlobs(hashes: string[]): Promise<{ missing: string[] }>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array | null>;
}

// ─── Local vault side (Obsidian-coupled impl injected by the plugin) ────────────

/**
 * Everything the orchestrator needs from the local vault, behind an interface so
 * the round can be driven with in-memory fakes in tests. The production impl
 * (P4) wires FileRegistry, ContentStore, OperationLogger and SyncApplicator.
 */
export interface VaultSyncHost {
  /** Snapshot of the local state: fileEntries, un-pushed pendingOps, and a
   *  contentStore populated with at least every pending op's content + ancestors. */
  buildLocalState(): Promise<VaultState>;
  /** Apply merge actions to the real vault (writes/deletes/moves, conflict prompts). */
  applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<void>;
  /** Drop the pending ops once they are durably on the server. */
  clearPendingOps(): Promise<void>;
  loadCursor(): Promise<number>;
  saveCursor(cursor: number): Promise<void>;
}

export interface ServerSyncOptions {
  api: ServerApi;
  crypto: VaultCrypto;
  host: VaultSyncHost;
  hlc: HybridLogicalClock;
  /** Page size for the pull loop (server may cap lower). */
  opsLimit?: number;
  onProgress?: (label: string) => void;
}

const DEFAULT_OPS_LIMIT = 500;

export class ServerSyncClient {
  private readonly api: ServerApi;
  private readonly crypto: VaultCrypto;
  private readonly host: VaultSyncHost;
  private readonly hlc: HybridLogicalClock;
  private readonly opsLimit: number;
  private readonly onProgress?: (label: string) => void;

  constructor(opts: ServerSyncOptions) {
    this.api = opts.api;
    this.crypto = opts.crypto;
    this.host = opts.host;
    this.hlc = opts.hlc;
    this.opsLimit = opts.opsLimit ?? DEFAULT_OPS_LIMIT;
    this.onProgress = opts.onProgress;
  }

  /**
   * One full sync round (spec §7, returning device):
   *   pull ops → fetch blobs → push our pending ops → merge + apply → save cursor.
   *
   * We push *before* applying so ops are durable on the server before the
   * applicator clears the local oplog; a crash in between is safe because the
   * append is idempotent by `clientOpId`.
   *
   * We push only *locally-authored* ops. Merge-derived content (clean three-way
   * merges) is not pushed: every device that pulls the same source ops recomputes
   * the identical result (the D1 CRDT-replay property), so an op for it would be
   * redundant. The one exception is a *user-resolved* text conflict — a fresh
   * decision replay can't reproduce; the applicator re-emits it as an op (see
   * SyncApplicator's `conflict` case) so it replicates like any other edit.
   */
  async runSync(): Promise<void> {
    if (!this.crypto.isReady()) throw new Error('Vault key not derived');

    const local = await this.host.buildLocalState();
    const startCursor = await this.host.loadCursor();

    // ── 1. Pull remote ops since our cursor ──────────────────────────────────
    this.onProgress?.('Pulling changes…');
    const { ops: remoteOps, cursor: pulledCursor } = await this.pullAll(startCursor);

    // ── 2. Reconstruct the remote projection and fetch the content it needs ──
    // Exclude our own re-pulled ops — projecting them would make a fresh local
    // edit merge against our own history and corrupt the ancestor (see the
    // reconstructRemoteState docs).
    const remote = reconstructRemoteState(remoteOps, local.deviceId);
    await this.fetchRemoteBlobs(remote, local);

    // ── 3. Push our pending ops (blobs first, then the append) ───────────────
    if (local.pendingOps.length > 0) {
      this.onProgress?.(`Pushing ${local.pendingOps.length} change(s)…`);
      await this.pushPendingOps(local, startCursor);
      await this.host.clearPendingOps();
    }

    // ── 4. Merge remote into local and apply ─────────────────────────────────
    this.onProgress?.('Merging…');
    const merge = mergeVaultStates(local, remote);
    // Advance the clock past the merged HLC *before* applying: a user-resolved
    // conflict mints an op inside applyMerge, and it must dominate the remote
    // content it supersedes so peers accept the resolution (last-writer-wins)
    // rather than re-conflicting. Doing this after apply would let the
    // resolution be timestamped below the remote it resolves.
    this.hlc.setCurrent(merge.mergedHlc);
    await this.host.applyMerge(merge.actions, local, remote);

    // ── 5. Advance the cursor past everything we consumed ────────────────────
    // Persist the *pull* cursor, not the append's headCursor: another device may
    // have appended between our pull and our push, and those ops sit at
    // seq ∈ (pulledCursor, headCursor]. Jumping to headCursor would skip them.
    // Our own just-pushed ops re-pull once next round and merge to a no-op.
    await this.host.saveCursor(pulledCursor);
  }

  /** Loop `GET /ops?since` until drained, decrypting each record to an Operation. */
  private async pullAll(startCursor: number): Promise<{ ops: Operation[]; cursor: number }> {
    const ops: Operation[] = [];
    let cursor = startCursor;
    // Bounded to avoid an accidental infinite loop if a server misreports hasMore.
    for (;;) {
      const page = await this.api.pullOps(cursor, this.opsLimit);
      for (const rec of page.ops) {
        ops.push(await this.crypto.decryptOp<Operation>(rec.ciphertext));
      }
      cursor = page.nextCursor;
      if (!page.hasMore || page.ops.length === 0) break;
    }
    return { ops, cursor };
  }

  /**
   * For every live remote file whose plaintext content we don't already hold,
   * fetch its blob (by the *blinded* hash), decrypt it, verify it hashes back to
   * the asserted content hash, and stage it in the remote content store so the
   * merge can read it.
   */
  private async fetchRemoteBlobs(remote: VaultState, local: VaultState): Promise<void> {
    const wanted = new Set<string>();
    for (const entry of remote.fileEntries.values()) {
      if (entry.deleted) continue;
      if (!local.contentStore.has(entry.contentHash)) wanted.add(entry.contentHash);
    }
    if (wanted.size === 0) return;

    this.onProgress?.(`Downloading ${wanted.size} file(s)…`);
    for (const contentHash of wanted) {
      const blinded = await this.crypto.blindHash(contentHash);
      const envelope = await this.api.getBlob(blinded);
      if (!envelope) continue; // referenced blob absent — skip; merge will no-op it
      const content = await this.crypto.decryptBlob(envelope);
      if ((await sha256Hex(content)) !== contentHash) {
        throw new Error(`Blob ${blinded} failed content-hash verification`);
      }
      remote.contentStore.set(contentHash, content);
    }
  }

  /**
   * Upload the content for our pending ops (deduped via `blobs:check`), then
   * append the ops. Blobs must land before ops or the server 422s the append.
   */
  private async pushPendingOps(local: VaultState, baseCursor: number): Promise<void> {
    // Map blinded hash → plaintext content for every op that carries content.
    const blobs = new Map<string, Uint8Array>();
    const records: AppendOp[] = [];

    for (const op of local.pendingOps) {
      const refs: string[] = [];
      const content = op.type === 'delete' ? undefined : local.contentStore.get(op.contentHash);
      if (content) {
        const blinded = await this.crypto.blindHash(op.contentHash);
        refs.push(blinded);
        blobs.set(blinded, content);
      }
      records.push({
        clientOpId: op.id,
        ciphertext: await this.crypto.encryptOp(op),
        blobRefs: refs,
      });
    }

    const blinded = [...blobs.keys()];
    if (blinded.length > 0) {
      const { missing } = await this.api.checkBlobs(blinded);
      for (const hash of missing) {
        const envelope = await this.crypto.encryptBlob(blobs.get(hash)!);
        await this.api.putBlob(hash, envelope);
      }
    }

    await this.api.appendOps(baseCursor, records);
  }
}

// ─── Pure helpers (independently testable) ─────────────────────────────────────

/**
 * Fold a stream of decrypted ops into a projected `VaultState` — "what the vault
 * looks like on the server since our cursor". Latest op per file wins by HLC
 * (the server's `seq` linearizes appends, but logical last-writer is by HLC).
 *
 * `ownDeviceId`, when given, filters out ops this device itself authored. We
 * re-pull our own just-pushed ops every round (we persist the pull cursor, not
 * the append head), and projecting them as "remote" is actively harmful: merging
 * a fresh local edit against the stale projection of our *own* earlier op yields
 * a clean `write_local` of our own content, which then advances our ancestor to
 * that un-acknowledged edit — so a peer's genuinely-concurrent edit later merges
 * against the wrong base and is silently clobbered. Our local state already
 * reflects our own ops, so excluding them is both correct and what makes the
 * re-pull the intended no-op.
 *
 * Ancestor hashes are intentionally null: the shared ancestor for a three-way
 * merge is whatever the *local* side recorded at its last sync, which the merge
 * already prefers. The projection is partial (only files touched since the
 * cursor) — untouched files are simply absent, which the merge treats as
 * "already in sync", producing no local change.
 */
export function reconstructRemoteState(ops: Operation[], ownDeviceId?: string): VaultState {
  const fileEntries = new Map<string, FileEntry>();
  let maxHlc: HLC | null = null;

  for (const op of ops) {
    if (ownDeviceId !== undefined && op.deviceId === ownDeviceId) continue;

    if (!maxHlc || hlcCompare(op.hlcTimestamp, maxHlc) > 0) maxHlc = op.hlcTimestamp;

    const existing = fileEntries.get(op.fileId);
    if (existing && hlcCompare(existing.hlcTimestamp, op.hlcTimestamp) >= 0) continue;

    fileEntries.set(op.fileId, {
      id: op.fileId,
      path: op.path,
      contentHash: op.contentHash,
      hlcTimestamp: op.hlcTimestamp,
      deleted: op.type === 'delete',
      ancestorContentHash: null,
      ancestorPath: null,
      // Carry a resolution op's superseded sides so a peer still holding one of
      // them adopts the resolution rather than re-conflicting (state-merge).
      supersedes: op.supersedes,
    });
  }

  return {
    deviceId: 'server',
    hlc: maxHlc ?? { wallTime: 0, counter: 0, deviceId: 'server' },
    fileEntries,
    pendingOps: ops,
    contentStore: new Map(),
  };
}

/** SHA-256 as lowercase hex. Mirrors content-store's `hashContent` without the
 *  `obsidian` import, so this module stays test-loadable. */
async function sha256Hex(content: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', content as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
