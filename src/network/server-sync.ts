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

import { VaultState, FileEntry, MergeAction, Operation, HLC, affectsLocalVault } from '../types';
import { HybridLogicalClock } from '../core/hlc';
import { hlcCompare } from '../core/hlc';
import { mergeVaultStates } from '../merge/state-merge';
import { VersionDag } from '../core/version-dag';
import { VaultCrypto } from './encryption';
import { PhaseTimer, PhaseTimingSink } from './perf-timer';

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

// The typed, user-actionable error family lives in `sync-errors.ts` (obsidian-free,
// shared with the HTTP transport). Re-exported here so existing importers of
// `StaleCursorError` / `KeyMismatchError` from this module keep working.
import {
  StaleCursorError,
  KeyMismatchError,
  DecryptError,
} from './sync-errors';
export {
  StaleCursorError,
  KeyMismatchError,
  AuthError,
  NotFoundError,
  ServerError,
  NetworkError,
  TimeoutError,
  DecryptError,
} from './sync-errors';

/** One blob in a batch upload: its (blinded) hash and the *encrypted* envelope. */
export interface BlobUpload {
  hash: string;
  bytes: Uint8Array;
}

/**
 * The spec endpoints (§4–§5). Implemented over `requestUrl` in prod
 * (HttpServerApi) and in memory for tests (FakeSyncServer). Blob bytes are the
 * *encrypted* envelope; hashes are already blinded by the caller.
 */
export interface ServerApi {
  pullOps(since: number, limit: number): Promise<PullOpsResult>;
  appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult>;
  checkBlobs(hashes: string[]): Promise<{ missing: string[] }>;
  /** Upload many blobs in one request (spec §5.5) — the primary upload path,
   *  collapsing a first sync's thousands of one-blob round-trips into ⌈N/batch⌉. */
  putBlobBatch(blobs: BlobUpload[]): Promise<void>;
  /** Upload a single blob. Used for the two cases batching doesn't serve: the
   *  lone key-check blob, and a large attachment whose bytes would bloat a
   *  base64 JSON batch — sent as raw `application/octet-stream` instead. */
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
  /** Deserialize the persisted version-DAG once for the whole round. `runSync`
   *  calls this a single time after the key/dag guard and threads the returned
   *  instance into `dagNeedsRebuild`, `buildLocalState`, and `recordVersionEdges`,
   *  so the graph is rebuilt from disk once per round instead of three times
   *  (round-residual spec §3). The consumers must not persist mutations to it
   *  except through `recordVersionEdges`. */
  loadDag(): Promise<VersionDag>;
  /** Snapshot of the local IDENTITY: fileEntries (with the A1 stat-gate hash
   *  correction) + un-pushed pendingOps, and a contentStore holding at most the
   *  drift set's bytes (read for the correction; kept so `stageContent` needn't
   *  re-read them) — empty on a converged round. Runs before the pull; `stageContent`
   *  fills the rest afterwards, scoped to what the merge needs (A2, §4.2). `dag` is
   *  the round's single loaded graph; identity does not mutate or walk it. */
  buildLocalIdentity(dag: VersionDag): Promise<VaultState>;
  /** Fill `state.contentStore` with the bytes for exactly `hashes` (content-cache
   *  read; disk read on a live entry's miss). Called after the pull with the files
   *  the merge will reconcile — their local bytes + DAG-reachable bases — so staging
   *  is O(touched), not O(vault). A genuinely-absent base is left unstaged and the
   *  merge degrades it to a conflict (F1). Already-present hashes are skipped. */
  stageContent(state: VaultState, hashes: Iterable<string>): Promise<void>;
  /** TRANSITIONAL (A2 rollout step 2): pre-A2 whole-vault snapshot =
   *  `buildLocalIdentity` + stage(all live bytes + all reachable bases). Kept only
   *  until the scoped staging moves into the round (§4.3); deleted in step 3. */
  buildLocalState(dag: VersionDag): Promise<VaultState>;
  /** Apply merge actions to the real vault (writes/deletes/moves, conflict
   *  prompts). Returns `deferred` (fileIds whose destructive action was skipped for
   *  on-disk drift (F5) or an auto-deferred conflict — the caller holds the cursor
   *  so their remote ops re-pull next round) and `deferredConflicts` (the subset of
   *  `deferred` that is an auto-deferred delete/binary conflict, surfaced with
   *  reason 'conflict' — Step 7's derived replacement for the outstanding badge). */
  applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<{ deferred: Set<string>; deferredConflicts: Set<string> }>;
  /** Drop the pending ops once they are durably on the server. */
  clearPendingOps(): Promise<void>;
  loadCursor(): Promise<number>;
  saveCursor(cursor: number): Promise<void>;
  /** Record the causal parent edges of these ops into the persisted version-DAG
   *  (sync v2): each op contributes `op.id → parents` (with its `contentHash` and
   *  `fileId`), keyed by op-id. Returns the updated in-memory DAG so the round can
   *  hand it to the merge, which derives the three-way base (LCA) and fast-forward
   *  from it. Called with this round's local + pulled ops BEFORE the merge, so both
   *  heads are present when the merge reads the graph. Mutates `dag` in place (the
   *  round's single loaded graph) and returns it. */
  recordVersionEdges(ops: Operation[], dag: VersionDag): Promise<VersionDag>;
  /** Whether the persisted version-DAG was lost (a torn write on an older build,
   *  or a deleted metadata file) and must be rebuilt from the server op log. True
   *  when this device has consumed server ops before (cursor > 0) yet the DAG loaded
   *  empty — the DAG is a derived cache of the log, so the round heals it by
   *  rewinding the cursor and replaying (see runSync). Never true for a fresh
   *  device (cursor 0), and false again once rebuilt, so it can't loop. Reads the
   *  round's single loaded `dag` (round-residual spec §3). */
  dagNeedsRebuild(dag: VersionDag): Promise<boolean>;
}

export interface ServerSyncOptions {
  api: ServerApi;
  crypto: VaultCrypto;
  host: VaultSyncHost;
  hlc: HybridLogicalClock;
  /** Page size for the pull loop (server may cap lower). */
  opsLimit?: number;
  /** Max ops per `POST /ops` batch. A large offline backlog is split across this
   *  many-op appends so it can't exceed the server's per-POST cap (§9.6) and 413.
   *  Must be ≤ the server's env-configured `MaxOpsPerPost`. Test hook; defaults to
   *  {@link DEFAULT_MAX_OPS_PER_APPEND}. */
  maxOpsPerAppend?: number;
  /** Max blob `PUT`s in flight at once. A fresh vault's first sync uploads one blob
   *  per note; doing them serially is latency-bound (one round-trip each). A bounded
   *  pool overlaps the round-trips without swamping a mobile `requestUrl`. Test hook;
   *  defaults to {@link DEFAULT_BLOB_UPLOAD_CONCURRENCY}. */
  blobUploadConcurrency?: number;
  /** Max blobs packed into one `blobs:batch` request. Must be ≤ the server's
   *  env-configured `MaxBlobsPerBatch`. Test hook; defaults to
   *  {@link DEFAULT_BLOB_BATCH_MAX_COUNT}. */
  blobBatchMaxCount?: number;
  /** Max total (plaintext) bytes packed into one batch. The base64 JSON body is
   *  ~1.34× this, so the default leaves headroom under the server's
   *  `MaxBlobBatchSize`. Test hook; defaults to {@link DEFAULT_BLOB_BATCH_MAX_BYTES}. */
  blobBatchMaxBytes?: number;
  /** Blobs larger than this (plaintext bytes) are uploaded individually via
   *  `putBlob` rather than batched, so a big attachment can't bloat a batch. Test
   *  hook; defaults to {@link DEFAULT_BLOB_BATCH_THRESHOLD}. */
  blobBatchThreshold?: number;
  onProgress?: (label: string) => void;
  /** Structured blob-upload progress `(uploaded, total)`, fired as each batch/PUT
   *  settles during the push — the numeric twin of the `Uploading files …` string
   *  `onProgress` emits. Lets the plugin drive a *determinate* progress bar in the
   *  status modal: the first sync of a large baseline uploads one blob per note and
   *  can run for minutes, so a filling bar shows it's actually making headway. Fired
   *  only for an upload worth showing (more than one concurrency wave), matching the
   *  string's guard. */
  onUploadProgress?: (uploaded: number, total: number) => void;
  /** Diagnostic per-phase wall-clock sink (perf baseline, Layer 3). When omitted
   *  (the default) `runSync` installs no timer and does no timing work — inert. The
   *  plugin wires this only when the `perfLog` setting is on. */
  perfLog?: PhaseTimingSink;
}

const DEFAULT_OPS_LIMIT = 500;

/** Default batch size for the append loop. A whole-vault offline capture (e.g. a
 *  fresh vault's first sync) can queue thousands of pending ops; posting them in
 *  one `POST /ops` exceeds the server's per-POST op cap and is rejected 413
 *  (`ErrBatchTooLarge`, spec §9.6). Chunk the append into batches of at most this
 *  many ops. Keep this ≤ the server's env-configured `MaxOpsPerPost`. */
const DEFAULT_MAX_OPS_PER_APPEND = 1000;

/** Default number of concurrent blob `PUT`s. Each upload is one HTTP round-trip, so a
 *  fresh vault's baseline (thousands of blobs) is dominated by latency, not bandwidth —
 *  overlapping a handful of round-trips cuts wall-clock ~linearly in this factor. Kept
 *  modest (near the classic ~6 connections-per-host ceiling) so a mobile `requestUrl`
 *  and the per-blob AES-GCM encrypt aren't swamped. */
const DEFAULT_BLOB_UPLOAD_CONCURRENCY = 8;

/** Default max blobs per `blobs:batch` request. Matches the server's default
 *  `MaxBlobsPerBatch` (256); a fresh vault's thousands of tiny notes upload in
 *  ⌈N/256⌉ requests instead of N one-blob PUTs, the dominant first-sync cost. */
const DEFAULT_BLOB_BATCH_MAX_COUNT = 256;

/** Default max total plaintext bytes per batch. The base64 JSON body is ~1.34×
 *  this, so 16 MiB stays comfortably under the server's default 32 MiB
 *  `MaxBlobBatchSize` even with per-blob AEAD + JSON overhead. */
const DEFAULT_BLOB_BATCH_MAX_BYTES = 16 * 1024 * 1024;

/** Default cutoff (plaintext bytes) above which a blob is PUT individually rather
 *  than batched. Batching pays off for many small blobs; a large attachment is
 *  already one round-trip's worth of bytes, so it gains nothing and would only
 *  crowd out small blobs from a batch. */
const DEFAULT_BLOB_BATCH_THRESHOLD = 512 * 1024;

/** What a sync round did, surfaced to the plugin so the observable sync-state
 *  (S2) can record it. `deferred`/`stranded` are the fileless raw sets the round
 *  already computes for its cursor logic — the plugin resolves them to paths. */
export interface SyncRoundSummary {
  /** Count of locally-authored pending ops pushed this round. */
  pushed: number;
  /** Count of remote ops pulled this round. */
  pulled: number;
  /** fileIds whose action was deferred this round (F5 drift *or* an auto-deferred
   *  delete/binary conflict); the cursor is held so they re-pull and re-merge. */
  deferred: string[];
  /** content hashes whose blob couldn't be fetched this round (F3). */
  stranded: string[];
  /** The subset of `deferred` that is an auto-deferred delete/binary *conflict*
   *  (needs a manual sync), as opposed to F5 drift. The plugin tags these
   *  `reason:'conflict'` in the observable state — the derived replacement for the
   *  old hand-maintained outstanding-conflict set (sync v2 Step 7). */
  deferredConflicts: string[];
}

/** Whether this device's passphrase agrees with the vault already on the server:
 *  `match` (key-check verified), `mismatch` (a record exists but our key can't
 *  reproduce it — wrong passphrase), or `unstamped` (no key-check record yet — an
 *  empty or pre-guard vault, so agreement can't be proven until data exists). */
export type PreflightKeyState = 'match' | 'mismatch' | 'unstamped';

/** Result of a non-mutating {@link ServerSyncClient.preflight}. Reaching this point
 *  means the server + token + vault were reachable (any failure threw a typed error);
 *  `keyState` reports the passphrase check. */
export interface PreflightResult {
  keyState: PreflightKeyState;
}

export class ServerSyncClient {
  private readonly api: ServerApi;
  private readonly crypto: VaultCrypto;
  private readonly host: VaultSyncHost;
  private readonly hlc: HybridLogicalClock;
  private readonly opsLimit: number;
  private readonly maxOpsPerAppend: number;
  private readonly blobUploadConcurrency: number;
  private readonly blobBatchMaxCount: number;
  private readonly blobBatchMaxBytes: number;
  private readonly blobBatchThreshold: number;
  private readonly onProgress?: (label: string) => void;
  private readonly onUploadProgress?: (uploaded: number, total: number) => void;
  private readonly perfLog?: PhaseTimingSink;

  constructor(opts: ServerSyncOptions) {
    this.api = opts.api;
    this.crypto = opts.crypto;
    this.host = opts.host;
    this.hlc = opts.hlc;
    this.opsLimit = opts.opsLimit ?? DEFAULT_OPS_LIMIT;
    this.maxOpsPerAppend = Math.max(1, opts.maxOpsPerAppend ?? DEFAULT_MAX_OPS_PER_APPEND);
    this.blobUploadConcurrency = Math.max(
      1,
      opts.blobUploadConcurrency ?? DEFAULT_BLOB_UPLOAD_CONCURRENCY,
    );
    this.blobBatchMaxCount = Math.max(1, opts.blobBatchMaxCount ?? DEFAULT_BLOB_BATCH_MAX_COUNT);
    this.blobBatchMaxBytes = Math.max(1, opts.blobBatchMaxBytes ?? DEFAULT_BLOB_BATCH_MAX_BYTES);
    this.blobBatchThreshold = Math.max(0, opts.blobBatchThreshold ?? DEFAULT_BLOB_BATCH_THRESHOLD);
    this.onProgress = opts.onProgress;
    this.onUploadProgress = opts.onUploadProgress;
    this.perfLog = opts.perfLog;
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

    // Per-phase timing (perf baseline, Layer 3): only installed when the plugin
    // passed a `perfLog` sink (the diagnostic setting is on). `undefined` otherwise,
    // so every `timer?.lap(...)` below is a no-op — zero overhead by default.
    const timer = this.perfLog ? new PhaseTimer(this.perfLog) : undefined;

    // ── 0. Passphrase / key-agreement guard ─────────────────────────────────
    // Before we decrypt a single pulled op or push under our key, confirm this
    // device's derived key is the one the vault was established with. A present
    // record that our key can't reproduce means a mistyped passphrase (or wrong
    // salt): fail loudly and actionably here rather than wedging the vault into two
    // key regimes or dying on a raw AES exception mid-pull. Absent → nobody has
    // stamped the vault yet; we claim it below once our key is established (we
    // decrypted existing ops, or we're the first device pushing). The GET degrades
    // to "no record" on a withholding server (spec threat model: omission → the
    // pre-guard status quo, never corruption).
    const keyCheckKey = await this.keyCheckBlobKey();
    const existingKeyCheck = await this.api.getBlob(keyCheckKey);
    if (existingKeyCheck && !(await this.crypto.verifyKeyCheck(existingKeyCheck))) {
      throw new KeyMismatchError();
    }
    const keyCheckAbsent = existingKeyCheck === null;

    // Self-heal a lost/corrupt version-DAG before reading the cursor. If the graph
    // was torn away (an old build's non-atomic write, a deleted metadata file) but
    // we've synced before, rewind the cursor so this round re-pulls the whole
    // server log and `recordVersionEdges` rebuilds the DAG from the source of
    // truth. The replay is idempotent — already-applied files merge to a no-op —
    // the same self-healing `recheckConflicts` triggers by hand. Rebuilt DAG is
    // non-empty, so the next round won't re-trigger.
    // Deserialize the persisted DAG exactly once and thread it through every
    // consumer this round (dag-guard, buildLocalState, recordVersionEdges), instead
    // of each reloading it from disk (round-residual spec §3: 3 loads → 1). A torn
    // graph loads as empty here; the guard below sees size 0 and rewinds the cursor,
    // and recordVersionEdges rebuilds into this same (empty) instance.
    let dag = await this.host.loadDag();
    if (await this.host.dagNeedsRebuild(dag)) {
      this.onProgress?.('Rebuilding sync history…');
      await this.host.saveCursor(0);
    }
    timer?.lap('keycheck+dag-guard');

    const local = await this.host.buildLocalState(dag);
    const startCursor = await this.host.loadCursor();
    const pushed = local.pendingOps.length;
    timer?.lap('buildLocalState');

    // ── 1. Pull remote ops since our cursor ──────────────────────────────────
    this.onProgress?.('Pulling changes…');
    const { ops: pulled, cursor: pulledCursor } = await this.pullAll(startCursor);
    timer?.lap('pull');

    // ── 2. Reconstruct the remote projection and fetch the content it needs ──
    // Exclude our own re-pulled ops — projecting them would make a fresh local
    // edit merge against our own history and corrupt the ancestor (see the
    // reconstructRemoteState docs).
    const remote = reconstructRemoteState(pulled.map(p => p.op), local.deviceId);
    const missingContent = await this.fetchRemoteBlobs(remote, local);
    timer?.lap('fetchBlobs');

    // ── 2b. Claim the key-check record if the vault has none yet ─────────────
    // Stamp it once our key is established: either we successfully decrypted the
    // remote ops we just pulled (our key matches an existing, pre-guard vault — this
    // upgrades it in place), or we're the first device pushing into an empty vault (we
    // define the key). PUT is idempotent and first-write-wins, so a race resolves to a
    // single record and any wrong-key claimer is caught by the mismatch check above on
    // the next device. Do this before pushing our ops so the guard never lags behind
    // the very ops it protects.
    if (keyCheckAbsent && (pulled.length > 0 || local.pendingOps.length > 0)) {
      await this.api.putBlob(keyCheckKey, await this.crypto.buildKeyCheck());
    }

    // ── 3. Push our pending ops (blobs first, then the append) ───────────────
    if (local.pendingOps.length > 0) {
      this.onProgress?.(`Pushing ${local.pendingOps.length} change(s)…`);
      await this.pushPendingOps(local, startCursor);
      await this.host.clearPendingOps();
    }
    timer?.lap('push');

    // ── 4. Merge remote into local and apply ─────────────────────────────────
    // Record this round's causal edges into the op-id DAG FIRST — both our authored
    // ops (the snapshot taken before clearPendingOps) and the ops we pulled — so the
    // merge sees both this round's heads (local's and remote's) and can derive the
    // three-way base (LCA) and fast-forward from graph structure. The returned DAG
    // is handed to the merge.
    dag = await this.host.recordVersionEdges([...local.pendingOps, ...pulled.map(p => p.op)], dag);
    timer?.lap('recordVersionEdges');

    this.onProgress?.('Merging…');
    const merge = mergeVaultStates(local, remote, dag);
    timer?.lap('merge');
    // Advance the clock past the merged HLC *before* applying: a user-resolved
    // conflict mints an op inside applyMerge, and it must dominate the remote
    // content it supersedes so peers accept the resolution (last-writer-wins)
    // rather than re-conflicting. Doing this after apply would let the
    // resolution be timestamped below the remote it resolves.
    this.hlc.setCurrent(merge.mergedHlc);
    // Apply is its own phase — a first sync writes every pulled file to disk, which can
    // run far longer than the merge computation itself. Label it so the UI stops showing
    // "Merging…" (a sub-second step) for what is actually minutes of disk writes. Count
    // only the actions that touch the local vault (`affectsLocalVault` owns that
    // classification): the merge emits one action per file, and on a single self-syncing
    // device every file is a transport-only `send_remote`, so counting raw actions made
    // an unchanged vault report "Applying 8390 changes" when nothing local was written.
    const localChanges = merge.actions.filter(affectsLocalVault).length;
    if (localChanges > 0) this.onProgress?.(`Applying ${localChanges} change(s)…`);
    const { deferred, deferredConflicts } = await this.host.applyMerge(merge.actions, local, remote);
    timer?.lap('applyMerge');

    // ── 4b. Multi-head reconciliation sweep (causal audit Finding B) ─────────
    // `reconstructRemoteState` collapses concurrent remote heads for one file to the
    // single HLC-max op, so when we pulled ≥2 heads for a file the main merge only
    // reconciled our head against that one — the other head(s) landed in the DAG as
    // stranded leaves nothing reconciled. Fold them into our head here, so THIS
    // device converges by itself instead of depending on whichever peer already
    // computed the merge staying online to push it. Reuses the ordinary pairwise
    // `mergeVaultStates` path (a clean fold mints a `write_merge`; overlapping edits
    // surface a conflict), so newly-minted merge nodes replicate on the next round
    // like any other resolution. May add to `missingContent` (an extra leaf's bytes
    // weren't fetched by the HLC-max projection) so `safeCursor` re-pulls it (F3).
    // Files the main apply deferred (F5 drift, or an auto-deferred delete/binary
    // conflict) are skipped: their cursor is held so the whole round re-pulls, and
    // reconciling them here would write over the very in-window edit F5 protects.
    this.onProgress?.('Reconciling…');
    await this.reconcileConcurrentHeads(pulled, dag, local.deviceId, missingContent, deferred);
    timer?.lap('reconcileConcurrentHeads');

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
    timer?.lap('saveCursor');
    timer?.end('total');

    return {
      pushed,
      pulled: pulled.length,
      deferred: [...deferred],
      stranded: [...missingContent],
      deferredConflicts: [...deferredConflicts],
    };
  }

  /**
   * Preflight the configured server + token + vault + passphrase WITHOUT mutating
   * anything — the settings "Test connection" affordance, so a setup mistake is
   * caught before the first real round wedges on it. A read-only `blobs:check([])`
   * validates URL + token + vault reachability (server-http maps any failure to the
   * typed error family). Then it reads the key-check record to report whether this
   * device's passphrase matches the vault already on the server.
   */
  async preflight(): Promise<PreflightResult> {
    if (!this.crypto.isReady()) throw new Error('Vault key not derived');
    // Reachability + auth, side-effect-free: the server must answer an empty check 200.
    await this.api.checkBlobs([]);
    const record = await this.api.getBlob(await this.keyCheckBlobKey());
    const keyState: PreflightKeyState =
      record === null ? 'unstamped'
        : (await this.crypto.verifyKeyCheck(record)) ? 'match' : 'mismatch';
    return { keyState };
  }

  /**
   * The well-known blob slot that holds the vault's key-check record. A fixed,
   * non-secret value hashed to 64 hex chars so it's format-compatible with a real
   * content hash (the server treats blobs opaquely; some may validate the key shape)
   * and cannot collide with a blinded content hash. It is deliberately *not* blinded
   * by the vault key: a wrong-passphrase device must resolve the *same* slot so it
   * finds — and fails to reproduce — the existing record, rather than looking past it.
   * Per-vault namespacing comes from the `/vaults/{vaultId}/blobs/` path, so a constant
   * body key is safe across vaults.
   */
  private cachedKeyCheckBlobKey?: string;
  private async keyCheckBlobKey(): Promise<string> {
    if (!this.cachedKeyCheckBlobKey) {
      this.cachedKeyCheckBlobKey = await sha256Hex(new TextEncoder().encode('vault-sync:keycheck:v1'));
    }
    return this.cachedKeyCheckBlobKey;
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
        let op: Operation;
        try {
          op = await this.crypto.decryptOp<Operation>(rec.ciphertext);
        } catch {
          // A raw AES/GCM failure here means our key can't read this vault's data —
          // almost always a wrong passphrase. The key-check guard catches this up
          // front for stamped vaults; this is the actionable fallback for a
          // pre-guard vault with no key-check record. (Never a KeyMismatchError here:
          // that's reserved for the explicit key-check, which already passed.)
          throw new DecryptError();
        }
        ops.push({ seq: rec.seq, op });
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
      const content = await this.fetchBlob(contentHash);
      if (!content) { missing.add(contentHash); continue; } // absent — merge no-ops it; hold the cursor (F3)
      remote.contentStore.set(contentHash, content);
    }
    return missing;
  }

  /**
   * Fetch one blob by its (unblinded) content hash: blind it, GET the encrypted
   * envelope, decrypt, and verify it hashes back to the asserted hash. Returns
   * `null` when the blob is absent on the server (a transient F3 stranding the
   * caller handles by holding the cursor). Shared by {@link fetchRemoteBlobs} and
   * the multi-head reconciliation sweep, which stages an extra concurrent leaf's
   * bytes the HLC-max projection never fetched.
   */
  private async fetchBlob(contentHash: string): Promise<Uint8Array | null> {
    const blinded = await this.crypto.blindHash(contentHash);
    const envelope = await this.api.getBlob(blinded);
    if (!envelope) return null;
    const content = await this.crypto.decryptBlob(envelope);
    if ((await sha256Hex(content)) !== contentHash) {
      throw new Error(`Blob ${blinded} failed content-hash verification`);
    }
    return content;
  }

  /**
   * Upload the content for our pending ops (deduped via `blobs:check`), then
   * append the ops. Blobs must land before ops or the server 422s the append —
   * `uploadBlobs` awaits *every* `PUT` before we reach the append loop, so the
   * bounded-concurrency pool doesn't weaken that ordering.
   *
   * The append is split into batches of at most `maxOpsPerAppend` ops so a large
   * offline backlog (a fresh vault's whole-vault capture can be thousands of ops)
   * never exceeds the server's per-POST op cap and 413s (§9.6). Batching is safe:
   * each op is idempotent by `clientOpId`, and the caller only `clearPendingOps`
   * once this returns — so a failure partway through re-sends every batch next
   * round, and the batches already stored dedupe server-side.
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
      await this.uploadBlobs(missing, blobs);
    }

    // Append in batches so a big backlog can't 413 (see the method doc). Thread the
    // head cursor the server returns as the next batch's advisory baseCursor — it's
    // the freshest value, so it minimises the stale-writer (409) window between
    // batches. Only narrate per-batch progress when there's more than one batch.
    let cursor = baseCursor;
    const total = records.length;
    for (let i = 0; i < total; i += this.maxOpsPerAppend) {
      const batch = records.slice(i, i + this.maxOpsPerAppend);
      if (total > this.maxOpsPerAppend) {
        this.onProgress?.(`Uploading changes ${i + batch.length}/${total}…`);
      }
      cursor = await this.appendBatch(batch, cursor);
    }
  }

  /**
   * Encrypt and upload every missing blob, with at most `blobUploadConcurrency`
   * requests in flight. A fresh vault is thousands of tiny notes, and one PUT per
   * blob makes that baseline latency-bound (one round-trip each). So small blobs
   * are packed into `blobs:batch` requests (up to `blobBatchMaxCount` /
   * `blobBatchMaxBytes` each) and large blobs still PUT individually; both are
   * dispatched through one bounded pool. A batch of B blobs is a single round-trip
   * instead of B, which is the dominant first-sync win.
   *
   * Safety: this resolves only once *all* requests settle, preserving the blobs-
   * before-append ordering the server requires (a 422 otherwise). Every upload is
   * idempotent by hash, so if one rejects — aborting the round via `Promise.all` —
   * the whole push re-runs next round and stored blobs dedupe server-side. Order is
   * irrelevant: no op is appended until every blob has landed.
   */
  private async uploadBlobs(missing: string[], blobs: Map<string, Uint8Array>): Promise<void> {
    if (missing.length === 0) return;
    const total = missing.length;
    let done = 0;
    const bump = (n: number): void => {
      done += n;
      if (total > this.blobUploadConcurrency) {
        this.onProgress?.(`Uploading files ${done}/${total}…`);
        this.onUploadProgress?.(done, total);
      }
    };

    // Build the in-flight unit list: each batch is one request, each large blob is
    // one PUT. Batching is the primary path; large blobs split out to raw PUTs.
    const units: Array<() => Promise<void>> = [];
    const { batches, singles } = this.planBlobUpload(missing, blobs);
    for (const batch of batches) {
      units.push(() => this.uploadBlobBatch(batch, blobs).then(() => bump(batch.length)));
    }
    for (const hash of singles) {
      units.push(() => this.uploadOneBlob(hash, blobs).then(() => bump(1)));
    }

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= units.length) return;
        await units[i]!();
      }
    };
    const workers = Math.min(this.blobUploadConcurrency, units.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  /**
   * Partition the missing hashes into batches of small blobs plus a list of large
   * blobs to PUT individually, packing by *plaintext* size (the encrypted envelope
   * adds only a small fixed AEAD overhead, absorbed by the byte-budget headroom).
   * A new batch starts once the current one hits `blobBatchMaxCount` blobs or would
   * exceed `blobBatchMaxBytes`.
   */
  private planBlobUpload(
    missing: string[],
    blobs: Map<string, Uint8Array>,
  ): { batches: string[][]; singles: string[] } {
    const batches: string[][] = [];
    const singles: string[] = [];
    let cur: string[] = [];
    let curBytes = 0;
    for (const hash of missing) {
      const size = blobs.get(hash)!.length;
      if (size > this.blobBatchThreshold) {
        singles.push(hash);
        continue;
      }
      if (cur.length > 0 && (cur.length >= this.blobBatchMaxCount || curBytes + size > this.blobBatchMaxBytes)) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(hash);
      curBytes += size;
    }
    if (cur.length > 0) batches.push(cur);
    return { batches, singles };
  }

  /** Encrypt a batch's blobs and upload them in one request. */
  private async uploadBlobBatch(hashes: string[], blobs: Map<string, Uint8Array>): Promise<void> {
    const entries: BlobUpload[] = [];
    for (const hash of hashes) {
      entries.push({ hash, bytes: await this.crypto.encryptBlob(blobs.get(hash)!) });
    }
    await this.api.putBlobBatch(entries);
  }

  /** Encrypt and PUT a single blob. */
  private async uploadOneBlob(hash: string, blobs: Map<string, Uint8Array>): Promise<void> {
    const envelope = await this.crypto.encryptBlob(blobs.get(hash)!);
    await this.api.putBlob(hash, envelope);
  }

  /**
   * Append one batch at `baseCursor` (advisory, spec §9.3), recovering a too-stale
   * 409 by re-pulling to the current head and retrying — bounded (F4), never a
   * wedge. The append is idempotent by `clientOpId`, so a retry (or a batch
   * re-sent after a mid-push failure) can't duplicate. Ops others slipped in
   * during the 409 window sit at seq > head and are re-pulled next round (we don't
   * merge them mid-retry). Returns the server's head cursor after the append.
   */
  private async appendBatch(batch: AppendOp[], baseCursor: number): Promise<number> {
    let cursor = baseCursor;
    for (let attempt = 0; ; attempt++) {
      try {
        const { headCursor } = await this.api.appendOps(cursor, batch);
        return headCursor;
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

  /**
   * Multi-head reconciliation sweep (causal audit Finding B). The remote projection
   * keeps only the HLC-max op per fileId, so a round that pulled ≥2 concurrent heads
   * for one file reconciled our head against just that one and left the rest as
   * un-reconciled DAG leaves. Fold every such extra leaf into our head with the
   * ordinary pairwise `mergeVaultStates` — a clean fold mints a `write_merge` node,
   * overlapping edits surface a conflict (markers) — until a single head remains.
   *
   * Determinism/commutativity across devices: `mergeVersionId` is content-addressed
   * and order-independent in its parents, and we fold the extra leaves in a fixed
   * order (sorted by version-id), so two devices sweeping the same leaves mint the
   * identical merge node(s) and fast-forward onto each other (no storm). For the
   * common two-head case both devices fold the same pair, so they converge exactly.
   *
   * Scope is the files a *peer* touched this round (the only place a second head can
   * arrive alongside the collapsed HLC-max). We only fold live↔live edits that share
   * a real common base — a disconnected re-create root (Finding A) or a tombstone
   * leaf is left alone (benign per the audit) rather than unioned. An extra leaf's
   * bytes weren't fetched by the projection, so we stage them here; if the blob is
   * absent we add its hash to `missingContent` so `safeCursor` holds the cursor and
   * the leaf re-pulls next round (F3), never silently dropped.
   */
  private async reconcileConcurrentHeads(
    pulled: PulledOp[],
    dag: VersionDag,
    ownDeviceId: string,
    missingContent: Set<string>,
    deferred: Set<string>,
  ): Promise<void> {
    // fileIds a peer touched this round, plus a lookup from a leaf's version-id
    // (op-id) to the pulled op that carries its path/HLC/type/contentHash — the DAG
    // node alone doesn't record those.
    const touched = new Set<string>();
    const opById = new Map<string, Operation>();
    for (const { op } of pulled) {
      opById.set(op.id, op);
      if (op.hlcTimestamp.deviceId !== ownDeviceId) touched.add(op.fileId);
    }
    if (touched.size === 0) return;

    // Cheap pre-check on the in-memory DAG before paying for a full O(vault)
    // `buildLocalState` (the perf logs show this at ~69s on a large mobile vault):
    // reconciliation only has work when some touched file has ≥2 open leaves — a
    // genuine concurrent divergence. A converged file has exactly one leaf. Without
    // this, EVERY round that merely pulled a peer op ran one whole-vault buildLocalState
    // below just to discover there was nothing to fold. `leaves(fileId) < 2` is a safe
    // under-approximation: the loop's "extra leaf" scan needs ≥2 leaves, so this never
    // hides real work — it only skips the provable no-op case.
    const anyMultiHead = [...touched].some(fileId => dag.leaves(fileId).length >= 2);
    if (!anyMultiHead) return;

    // Leaves we've already tried to fold this round, keyed `fileId leafId` (both are
    // space-free — a UUID and an op-id). A clean
    // fold collapses its leaf (it becomes an ancestor of the new head, so it stops
    // being an "extra" naturally) — but a fold whose pairwise merge CONFLICTS does
    // NOT collapse the heads, so without this guard the loop re-picks the same
    // un-foldable leaf every iteration, spins to `maxFolds` (≈ pulled ops), and
    // re-runs the full `buildLocalState` each time (the B2 deep-history blow-up:
    // a two-headed text conflict pulled alongside a long history ⇒ O(pulled) round
    // cost, docs/mobile-perf-baseline-spec.md). Skipping an already-attempted leaf
    // bounds folds to O(distinct extra leaves) and lets the scan advance to the next
    // extra instead of stalling on a conflicting one; an unresolved conflict re-pulls
    // and retries fresh next round (the design already converges across rounds).
    const attempted = new Set<string>();
    // Each successful fold removes one leaf; the extras are bounded by the ops we
    // pulled, so this terminates. The +touched guard covers the initial pass.
    const maxFolds = pulled.length + touched.size + 1;
    for (let step = 0; step < maxFolds; step++) {
      const local = await this.host.buildLocalState(dag);
      // Fold any merge node a previous iteration minted (now a pending op, not yet
      // in the persisted DAG) into the graph so this fold's LCA/leaf scan sees it.
      dag = await this.host.recordVersionEdges(local.pendingOps, dag);

      let folded = false;
      for (const fileId of [...touched].sort()) {
        // A file the main apply deferred (F5 drift / auto-deferred conflict) re-pulls
        // next round with the cursor held; reconciling it now would overwrite the
        // in-window edit the deferral is protecting. Leave it for a settled round.
        if (deferred.has(fileId)) continue;
        const le = local.fileEntries.get(fileId);
        if (!le || le.deleted || !le.headVersionId) continue;
        const localHead = le.headVersionId;

        // Extra concurrent leaves: open leaves of this file our head does NOT already
        // descend from. Sorted → deterministic fold order across devices.
        const extras = dag.leaves(fileId)
          .filter(v => v !== localHead && !dag.isAncestor(v, localHead))
          .sort();
        if (extras.length === 0) continue;

        // First *foldable* extra: a live (non-tombstone) peer edit that shares a real
        // common base with our head (a genuine Finding-B concurrent edit). A leaf with
        // no pulled op this round (no metadata to project), a delete, or a disconnected
        // lineage (mergeBase null — a re-create root, Finding A) is skipped, not unioned.
        let leafId: string | undefined;
        let leafOp: Operation | undefined;
        for (const cand of extras) {
          if (attempted.has(fileId + ' ' + cand)) continue; // don't re-spin a non-collapsing fold
          const op = opById.get(cand);
          if (!op || op.type === 'delete') continue;
          if (dag.mergeBase(localHead, cand) === null) continue;
          leafId = cand; leafOp = op; break;
        }
        if (!leafId || !leafOp) continue;
        attempted.add(fileId + ' ' + leafId);

        const leafHash = dag.contentHashOf(leafId) ?? leafOp.contentHash;
        // Stage the extra leaf's bytes (the HLC-max projection never fetched them).
        // Absent on the server → hold the cursor (F3) and retry next round.
        let bytes = local.contentStore.get(leafHash) ?? null;
        if (!bytes) bytes = await this.fetchBlob(leafHash);
        if (!bytes) { missingContent.add(leafHash); continue; }

        // Reconcile our head against this one extra leaf via the ordinary pairwise
        // merge. The base (LCA) bytes are already staged by buildLocalState (they are
        // reachable from our head); a known-but-missing base degrades to a conflict
        // inside mergeVaultStates (F1), never a union.
        const localOne = singleFileState(local, fileId);
        const remoteOne = leafRemoteState(leafOp, leafId, leafHash, bytes);
        const merge = mergeVaultStates(localOne, remoteOne, dag);
        this.hlc.setCurrent(merge.mergedHlc);
        await this.host.applyMerge(merge.actions, localOne, remoteOne);
        folded = true;
        break; // rebuild from fresh state before the next fold
      }
      if (!folded) break;
    }
  }
}

/** A single-file view of the local snapshot, for reconciling one extra leaf against
 *  the file's head without the merge touching unrelated files. Shares the snapshot's
 *  content store (read-only in the merge), which already holds the head's bytes and
 *  the DAG-reachable base bytes. */
function singleFileState(local: VaultState, fileId: string): VaultState {
  const le = local.fileEntries.get(fileId)!;
  return {
    deviceId: local.deviceId,
    hlc: local.hlc,
    fileEntries: new Map([[fileId, le]]),
    pendingOps: [],
    contentStore: local.contentStore,
  };
}

/** Project one extra concurrent leaf as a one-file remote `VaultState` the pairwise
 *  merge consumes exactly like the normal remote projection: the leaf's op-id is the
 *  head the merge reconstructs the base (LCA) from, and its bytes are staged so the
 *  three-way merge can read the remote side. */
function leafRemoteState(op: Operation, leafId: string, leafHash: string, bytes: Uint8Array): VaultState {
  const entry: FileEntry = {
    id: op.fileId,
    path: op.path,
    contentHash: leafHash,
    hlcTimestamp: op.hlcTimestamp,
    deleted: false,
    lastSyncedPath: null,
    headVersionId: leafId,
  };
  return {
    deviceId: 'server',
    hlc: op.hlcTimestamp,
    fileEntries: new Map([[op.fileId, entry]]),
    pendingOps: [],
    contentStore: new Map([[leafHash, bytes]]),
  };
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
 * The three-way base is the op-id DAG's LCA of the two heads, not anything carried
 * on this projection. The projection is partial (only files touched since the
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
      // The pulled op IS this remote version, so its op-id is the remote head the
      // merge reconstructs the DAG from (its parents are the parent version-ids,
      // carried on the op itself). The merge derives the true three-way base (LCA)
      // and the fast-forward from `headVersionId` over the op-id DAG. A projected
      // remote entry has no last-synced path of its own (that is a *local* notion),
      // so it is null — the delete-vs-rename check reads the local side's synced
      // path instead.
      lastSyncedPath: null,
      // A `move` is not a new content version: it carries no content of its own,
      // so its head is the content version it renamed (its parent), keeping the
      // renamed file connected in the DAG. Every other op IS its own version.
      headVersionId: op.type === 'move' ? (op.parents[0] ?? op.id) : op.id,
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
