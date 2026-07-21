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

/** A too-stale `baseCursor` was rejected (spec §9.3 — a server MAY 409). Lives
 *  here (not in the obsidian-coupled server-http.ts) so this obsidian-free
 *  orchestrator can catch it without a cycle; HttpServerApi imports it from here. */
export class StaleCursorError extends Error {
  constructor() {
    super('Server rejected append: cursor too stale, re-pull first');
    this.name = 'StaleCursorError';
  }
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

/** A pulled, decrypted op paired with its server `seq`. The decrypted
 *  {@link Operation} doesn't carry a seq, so we keep it alongside to compute a
 *  cursor that never strands an op whose content was unavailable (F3). */
interface PulledOp {
  seq: number;
  op: Operation;
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
  /** Apply merge actions to the real vault (writes/deletes/moves, conflict
   *  prompts). Returns `deferred` (fileIds whose destructive action was skipped for
   *  on-disk drift (F5) or an auto-deferred conflict — the caller holds the cursor
   *  so their remote ops re-pull next round) and `converged` (fileIds a converging
   *  action settled this round, so a stale outstanding-conflict badge can clear). */
  applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<{ deferred: Set<string>; converged: Set<string> }>;
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

/** What a sync round did, surfaced to the plugin so the observable sync-state
 *  (S2) can record it. `deferred`/`stranded` are the fileless raw sets the round
 *  already computes for its cursor logic — the plugin resolves them to paths. */
export interface SyncRoundSummary {
  /** Count of locally-authored pending ops pushed this round. */
  pushed: number;
  /** Count of remote ops pulled this round. */
  pulled: number;
  /** fileIds whose destructive action was deferred for on-disk drift (F5). */
  deferred: string[];
  /** content hashes whose blob couldn't be fetched this round (F3). */
  stranded: string[];
  /** fileIds a converging action settled this round — the plugin clears any stale
   *  outstanding-conflict badge for these (a file that resolved automatically, e.g.
   *  by adopting a peer's `supersedes` resolution, never re-enters the handler). */
  converged: string[];
}

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
  async runSync(): Promise<SyncRoundSummary> {
    if (!this.crypto.isReady()) throw new Error('Vault key not derived');

    const local = await this.host.buildLocalState();
    const startCursor = await this.host.loadCursor();
    const pushed = local.pendingOps.length;

    // ── 1. Pull remote ops since our cursor ──────────────────────────────────
    this.onProgress?.('Pulling changes…');
    const { ops: pulled, cursor: pulledCursor } = await this.pullAll(startCursor);

    // ── 2. Reconstruct the remote projection and fetch the content it needs ──
    // Exclude our own re-pulled ops — projecting them would make a fresh local
    // edit merge against our own history and corrupt the ancestor (see the
    // reconstructRemoteState docs).
    const remote = reconstructRemoteState(pulled.map(p => p.op), local.deviceId);
    const missingContent = await this.fetchRemoteBlobs(remote, local);

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
    const { deferred, converged } = await this.host.applyMerge(merge.actions, local, remote);

    // ── 5. Advance the cursor past everything we consumed ────────────────────
    // Persist the *pull* cursor, not the append's headCursor: another device may
    // have appended between our pull and our push, and those ops sit at
    // seq ∈ (pulledCursor, headCursor]. Jumping to headCursor would skip them.
    // Our own just-pushed ops re-pull once next round and merge to a no-op.
    //
    // But never advance *past* an op whose content we couldn't obtain this round
    // (F3). Its merge no-op'd (F1: unavailable content is deferred, not lost);
    // if we advanced past it, nothing would ever re-pull it once the blob
    // appeared and the file would be stranded. Cap the saved cursor just below
    // the earliest op referencing a still-missing content hash so the next round
    // re-pulls and retries it.
    //
    // Likewise, if the applicator deferred a destructive action because the file
    // drifted on disk mid-round (F5), the remote op it skipped must re-pull so it
    // re-merges against the edit we just re-captured. Its content WAS available
    // (not F3's case), so cap the cursor at this round's start.
    await this.host.saveCursor(safeCursor(pulled, pulledCursor, missingContent, startCursor, deferred.size > 0));

    return {
      pushed,
      pulled: pulled.length,
      deferred: [...deferred],
      stranded: [...missingContent],
      converged: [...converged],
    };
  }

  /**
   * Loop `GET /ops?since` until drained, decrypting each record to an Operation.
   * Each op keeps its server `seq` (the decrypted Operation doesn't carry one) so
   * the caller can compute a cursor that never strands an unapplied op (F3).
   */
  private async pullAll(startCursor: number): Promise<{ ops: PulledOp[]; cursor: number }> {
    const ops: PulledOp[] = [];
    let cursor = startCursor;
    // Bounded to avoid an accidental infinite loop if a server misreports hasMore.
    for (;;) {
      const page = await this.api.pullOps(cursor, this.opsLimit);
      for (const rec of page.ops) {
        ops.push({ seq: rec.seq, op: await this.crypto.decryptOp<Operation>(rec.ciphertext) });
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
   *
   * Returns the set of content hashes that were needed (live, not already held)
   * but could NOT be obtained this round — the caller uses it to hold the cursor
   * back so the ops referencing them are re-pulled and retried (F3).
   */
  private async fetchRemoteBlobs(remote: VaultState, local: VaultState): Promise<Set<string>> {
    const wanted = new Set<string>();
    for (const entry of remote.fileEntries.values()) {
      if (entry.deleted) continue;
      if (!local.contentStore.has(entry.contentHash)) wanted.add(entry.contentHash);
    }
    const missing = new Set<string>();
    if (wanted.size === 0) return missing;

    this.onProgress?.(`Downloading ${wanted.size} file(s)…`);
    for (const contentHash of wanted) {
      const blinded = await this.crypto.blindHash(contentHash);
      const envelope = await this.api.getBlob(blinded);
      if (!envelope) { missing.add(contentHash); continue; } // absent — merge no-ops it; hold the cursor (F3)
      const content = await this.crypto.decryptBlob(envelope);
      if ((await sha256Hex(content)) !== contentHash) {
        throw new Error(`Blob ${blinded} failed content-hash verification`);
      }
      remote.contentStore.set(contentHash, content);
    }
    return missing;
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

    // Append with `baseCursor` advisory (spec §9.3). A server MAY 409 a too-stale
    // writer; since we always append with our pull cursor — which is stale the
    // moment anyone else appends — a 409 must be recovered, not fatal, or sync
    // wedges (F4). Refresh the cursor by re-pulling to the current head and
    // re-append; the append is idempotent by `clientOpId`, so a partial prior
    // attempt can't duplicate. Ops others slipped in during the 409 window sit at
    // seq > head and are re-pulled next round (we don't merge them mid-retry).
    let cursor = baseCursor;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.api.appendOps(cursor, records);
        return;
      } catch (err) {
        if (!(err instanceof StaleCursorError)) throw err;
        if (attempt >= MAX_STALE_APPEND_RETRIES) {
          throw new Error(
            `Append rejected as stale after ${MAX_STALE_APPEND_RETRIES} re-pull retries; ` +
              'server head is advancing faster than this client can catch up',
          );
        }
        const refreshed = await this.pullAll(cursor);
        cursor = refreshed.cursor;
      }
    }
  }
}

/** How many times a stale-cursor 409 is recovered by re-pulling before we give
 *  up and surface a clear error (F4). Bounded so a pathologically busy server
 *  can't spin us forever. */
const MAX_STALE_APPEND_RETRIES = 3;

// ─── Pure helpers (independently testable) ─────────────────────────────────────

/**
 * The cursor to persist for a round: `pulledCursor` normally, but capped below
 * the earliest pulled op that references content we couldn't obtain this round
 * (F3). Such ops merged to a no-op (F1), so advancing past them would strand the
 * file until a manual cursor rewind. `missingContent` is already scoped to *live*
 * remote files whose bytes weren't available (see `fetchRemoteBlobs`), so a
 * create later superseded by a delete never holds the cursor back. Returns
 * `min(pulledCursor, minBlockedSeq - 1)`.
 *
 * `driftDeferred` (F5): the applicator declined a destructive action because the
 * file changed on disk mid-round and re-captured that edit as a fresh op. The
 * skipped remote op's content WAS available, so rather than seq-threading it we
 * simply cap at `startCursor` — re-pull the whole round so the skipped op
 * re-merges next round against the re-captured edit. Idempotent merges no-op the
 * files we did apply, and `startCursor ≤ any F3 minBlocked − 1`, so this also
 * subsumes the missing-content cap.
 */
export function safeCursor(
  pulled: PulledOp[],
  pulledCursor: number,
  missingContent: Set<string>,
  startCursor: number,
  driftDeferred: boolean,
): number {
  if (driftDeferred) return startCursor;
  if (missingContent.size === 0) return pulledCursor;
  let minBlocked = Infinity;
  for (const { seq, op } of pulled) {
    if (op.type !== 'delete' && missingContent.has(op.contentHash) && seq < minBlocked) {
      minBlocked = seq;
    }
  }
  if (minBlocked === Infinity) return pulledCursor;
  return Math.min(pulledCursor, minBlocked - 1);
}

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
    // Authorship lives in the HLC; the op no longer duplicates it top-level.
    if (ownDeviceId !== undefined && op.hlcTimestamp.deviceId === ownDeviceId) continue;

    if (!maxHlc || hlcCompare(op.hlcTimestamp, maxHlc) > 0) maxHlc = op.hlcTimestamp;

    const existing = fileEntries.get(op.fileId);
    if (existing && hlcCompare(existing.hlcTimestamp, op.hlcTimestamp) >= 0) continue;

    fileEntries.set(op.fileId, {
      id: op.fileId,
      path: op.path,
      contentHash: op.contentHash,
      hlcTimestamp: op.hlcTimestamp,
      deleted: op.type === 'delete',
      // The op carries the content it was edited from as its causal parent(s);
      // surface the sole parent as the remote entry's ancestor so the merge can
      // reconstruct the true common base and fast-forward a sequential edit
      // (state-merge) instead of three-way-merging against the local device's
      // stale ancestor. A root op (no parents) leaves this null — the merge falls
      // back to prior behaviour. (Step 2 will compute the base from the full DAG.)
      ancestorContentHash: op.parents[0] ?? null,
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
