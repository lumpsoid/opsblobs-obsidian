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
import { hlcCompare, hlcMax } from '../core/hlc';
import { mergeVaultStates } from '../merge/state-merge';
import { VersionDag } from '../core/version-dag';
import { VaultCrypto } from './encryption';
import { PhaseTimer, PhaseTimingSink, nowMs } from './perf-timer';

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
  BatchTooLargeError,
  isTransientLinkError,
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
import { SyncCancelToken } from './sync-cancellation';
import { ApplyFailure } from './sync-applicator';
export { SyncCancelToken, SyncCancelledError } from './sync-cancellation';

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
  /** Download many blobs in one request (spec §5.5) — the download-side mirror of
   *  `putBlobBatch`, collapsing a first sync's thousands of one-blob GETs into
   *  ⌈N/batch⌉. Returns the bytes for every requested hash the vault holds (keyed
   *  by hash); a hash the vault doesn't hold is reported in `missing`, not an
   *  error. Over the combined-size cap the transport throws `BatchTooLargeError`. */
  getBlobBatch(hashes: string[]): Promise<{ blobs: Map<string, Uint8Array>; missing: string[] }>;
  /** Read-only, side-effect-free probe of server URL + token + vault access
   *  (spec preflight endpoint). Unlike every other call it does **not** claim an
   *  unclaimed vault — it only reads the ownership verdict, so "Test connection"
   *  can run any number of times without staking a claim. `claimed` is true when
   *  this account owns the vault; a vault owned by *another* account surfaces as
   *  the transport's `AuthError`. When `keyCheckKey` names the vault's key-check
   *  blob and the owned vault holds it, `keyCheck` is that blob's bytes; otherwise
   *  (unclaimed vault, absent slot, or oversized non-record) it is null. */
  preflight(keyCheckKey: string): Promise<{ claimed: boolean; keyCheck: Uint8Array | null }>;
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
  /** Stage into `state.contentStore` every hash the persistent local content store
   *  (the packs) ALREADY durably holds, and return the set it served. The pull uses
   *  it to serve a blob from local packs instead of re-downloading it (Tier 1). Unlike
   *  {@link stageContent} there is NO live-path fallback: a pack miss means "not held",
   *  never a disk read of a same-hash-keyed vault path — which for a REMOTE projection
   *  would read this device's file at the remote entry's path and stage those (possibly
   *  diverged) bytes under the remote hash, unverified. Serving only from the
   *  hash-verified `ContentStore.get` (F1-safe) keeps a locally-sourced blob exactly as
   *  trustworthy as a downloaded-and-verified one. Already-present hashes count served. */
  stageLocalContent(state: VaultState, hashes: Iterable<string>): Promise<Set<string>>;
  /** Whether the persistent content store already holds `hash`. Synchronous and
   *  in-memory (an index/cache probe, no I/O) because it is called once per node of
   *  the version-DAG ancestor walk, to cut that walk at the first base whose bytes
   *  are gone — see `stageForFiles`. */
  hasStoredContent(hash: string): boolean;
  /** Apply merge actions to the real vault (writes/deletes/moves, conflict
   *  prompts). Returns `deferred` (fileIds whose destructive action was skipped for
   *  on-disk drift (F5) or an auto-deferred conflict — the caller holds the cursor
   *  so their remote ops re-pull next round) and `deferredConflicts` (the subset of
   *  `deferred` that is an auto-deferred delete/binary conflict, surfaced with
   *  reason 'conflict' — Step 7's derived replacement for the outstanding badge).
   *  `failures` are actions that threw: each is also in `deferred` (so the cursor is
   *  held and it retries), reported separately so a permanent failure surfaces as an
   *  error instead of an ever-retrying deferral. */
  applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<{ deferred: Set<string>; deferredConflicts: Set<string>; failures: ApplyFailure[] }>;
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
  /** Max `blobs:fetch` requests in flight at once during the pull. The download-side
   *  twin of {@link blobUploadConcurrency}: a fresh vault's first sync downloads the
   *  whole baseline, so overlapping a handful of batch round-trips cuts wall-clock.
   *  Test hook; defaults to {@link DEFAULT_BLOB_DOWNLOAD_CONCURRENCY}. */
  blobDownloadConcurrency?: number;
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
  /** Cooperative cancellation for a user-triggered "Cancel sync" (sync-cancellation.ts).
   *  Checked only at checkpoints before the round touches the local vault — see that
   *  module's doc for why this is always safe. Omitted (the default) means the round
   *  can't be cancelled (e.g. the preflight check never wires one). */
  cancelToken?: SyncCancelToken;
  /** Wait before each attempt of the preflight gate, in order (so `[0, …]` fires the
   *  first attempt immediately). Its length is the attempt count. Test hook; defaults
   *  to {@link DEFAULT_PREFLIGHT_RETRY_DELAYS_MS}. */
  preflightRetryDelaysMs?: number[];
  /** How the retry schedule waits. Test hook (tests pass a no-op so the schedule is
   *  assertable without real time); defaults to a `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * When the round's preflight gate fires: immediately, then 500 ms later, then 1 s
 * after that — three attempts spanning ~1.5 s of waiting plus whatever the attempts
 * themselves take.
 *
 * Sized for the failure it exists to absorb: a link that is *momentarily* down
 * (radio waking from doze, Wi-Fi/VPN handover, a cold DNS cache) rather than absent.
 * Those recover in hundreds of milliseconds, so spacing the retries across a second
 * and a half catches them while keeping a genuinely offline device's total wait at
 * roughly the transport's preflight budget — seconds, not the two minutes a blob-path
 * timeout used to cost. Nothing here retries a server that *answered*: see
 * {@link isTransientLinkError}.
 */
const DEFAULT_PREFLIGHT_RETRY_DELAYS_MS = [0, 500, 1000];

/** Default page size for the pull loop's `GET /ops?limit=`. Set to the server's
 *  default `MaxPullLimit` (`SYNC_MAX_PULL_LIMIT`, spec §9.6) so a full-sync drain
 *  moves the most ops per round-trip; a server with a lower cap clamps this down. */
const DEFAULT_OPS_LIMIT = 2000;

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

/** Default number of concurrent `blobs:fetch` requests during the pull. Same
 *  reasoning as the upload pool: each batch is one latency-bound round-trip, so a
 *  fresh vault's baseline download overlaps a handful of them without swamping a
 *  mobile `requestUrl`. */
const DEFAULT_BLOB_DOWNLOAD_CONCURRENCY = 8;

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
  /** Actions that THREW while being applied. Each fileId is also in `deferred` (the
   *  cursor is held, so it re-pulls and retries next round), but a deferral alone
   *  reads as "retries automatically, no action needed" — which is a lie for a
   *  permanent fault. The plugin records these as the round's error so a repeatedly
   *  failing action is visible instead of silently looping (guide §7). */
  applyFailures: ApplyFailure[];
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
  private readonly blobDownloadConcurrency: number;
  private readonly onProgress?: (label: string) => void;
  private readonly onUploadProgress?: (uploaded: number, total: number) => void;
  private readonly perfLog?: PhaseTimingSink;
  private readonly cancelToken?: SyncCancelToken;
  private readonly preflightRetryDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;

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
    this.blobDownloadConcurrency = Math.max(
      1,
      opts.blobDownloadConcurrency ?? DEFAULT_BLOB_DOWNLOAD_CONCURRENCY,
    );
    this.onProgress = opts.onProgress;
    this.onUploadProgress = opts.onUploadProgress;
    this.perfLog = opts.perfLog;
    this.cancelToken = opts.cancelToken;
    // An empty schedule would mean "never even try", so fall back to the default.
    const delays = opts.preflightRetryDelaysMs;
    this.preflightRetryDelaysMs = delays && delays.length > 0 ? delays : DEFAULT_PREFLIGHT_RETRY_DELAYS_MS;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
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
    // A cancel requested before the round even started (e.g. a double-click) — bail
    // before any I/O. See sync-cancellation.ts for why every check in this method
    // stops once step 4 (merge/apply, the local-vault-mutating phase) begins.
    this.cancelToken?.throwIfCancelled();

    // Per-phase timing (perf baseline, Layer 3): only installed when the plugin
    // passed a `perfLog` sink (the diagnostic setting is on). `undefined` otherwise,
    // so every `timer?.lap(...)` below is a no-op — zero overhead by default.
    const timer = this.perfLog ? new PhaseTimer(this.perfLog) : undefined;

    // ── 0. Reachability gate + passphrase / key-agreement guard ─────────────
    // Before we decrypt a single pulled op or push under our key, confirm this
    // device's derived key is the one the vault was established with. A present
    // record that our key can't reproduce means a mistyped passphrase (or wrong
    // salt): fail loudly and actionably here rather than wedging the vault into two
    // key regimes or dying on a raw AES exception mid-pull. Absent → nobody has
    // stamped the vault yet; we claim it below once our key is established (we
    // decrypted existing ops, or we're the first device pushing). The read degrades
    // to "no record" on a withholding server (spec threat model: omission → the
    // pre-guard status quo, never corruption).
    //
    // The record comes from `preflight`, not `getBlob`, because this call is also the
    // round's first contact with the server and therefore its de-facto reachability
    // check. `getBlob` rides the *blob* budget — sized for multi-megabyte attachments
    // on a slow link (two minutes) — so an unreachable network used to wedge the whole
    // round, and every UI control gated on it, for that entire budget before failing.
    // `preflight` returns the same bytes in one round-trip on a tight budget, is
    // retried across a blip (`preflightWithRetry`), and unlike every other endpoint
    // does not *claim* an unclaimed vault, so a failed round leaves no trace.
    const keyCheckKey = await this.keyCheckBlobKey();
    // `keyCheck` is null for an unclaimed vault, an unstamped one, or a blob too large
    // to be a record (the server declines to inline those). All three mean "no key
    // agreement to check yet" — the same verdict the old GET produced for an absent
    // slot — and the stamp below re-establishes it.
    const { keyCheck: existingKeyCheck } = await this.preflightWithRetry(keyCheckKey);
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
    this.cancelToken?.throwIfCancelled();

    // Build the local IDENTITY only (entries + pending ops + the A1 stat-gate hash
    // correction) — no O(vault) byte staging. The bytes the merge actually needs are
    // staged after the pull, scoped to the touched files (`stageMergeContent`, §4.3).
    // This is the A2 cut: a converged round stages nothing here, collapsing the
    // whole-vault snapshot to a cheap map build.
    const local = await this.host.buildLocalIdentity(dag);
    const startCursor = await this.host.loadCursor();
    const pushed = local.pendingOps.length;
    timer?.lap('buildLocalIdentity');

    // ── 1. Pull remote ops since our cursor ──────────────────────────────────
    this.onProgress?.('Pulling changes…');
    const { ops: pulled, cursor: pulledCursor } = await this.pullAll(startCursor);
    timer?.lap('pull');
    this.cancelToken?.throwIfCancelled();

    // ── 2. Reconstruct the remote projection and fetch the content it needs ──
    // Exclude our own re-pulled ops — projecting them would make a fresh local
    // edit merge against our own history and corrupt the ancestor (see the
    // reconstructRemoteState docs).
    const remote = reconstructRemoteState(pulled.map(p => p.op), local.deviceId);
    const missingContent = await this.fetchRemoteBlobs(remote, local);
    timer?.lap('fetchBlobs');
    this.cancelToken?.throwIfCancelled();

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
    this.cancelToken?.throwIfCancelled();
    if (local.pendingOps.length > 0) {
      this.onProgress?.(`Pushing ${local.pendingOps.length} change(s)…`);
      // Stage the pending ops' content so `pushPendingOps` can upload their blobs.
      // `buildLocalIdentity` staged no bytes, and these ops are local-only — the merge
      // classifies such a file as `send_remote` without reading bytes (§4.1) and the
      // scoped merge-stage runs only over remote-touched files — so without this their
      // content would be absent from `local.contentStore` and the blobs would never
      // upload (the op appended with no blob = data loss / a 422). Served from the
      // content-cache; a live entry's own bytes fall back to a disk read on a miss.
      const pendingContent = new Set<string>();
      for (const op of local.pendingOps) {
        if (op.type !== 'delete' && op.contentHash !== '') pendingContent.add(op.contentHash);
      }
      await this.host.stageContent(local, pendingContent);
      await this.pushPendingOps(local, startCursor);
      await this.host.clearPendingOps();
    }
    timer?.lap('push');

    // ── 4. Merge remote into local and apply ─────────────────────────────────
    // No cancellation checks from here to the end of the round (sync-cancellation.ts):
    // this is where the round starts mutating the local vault (registry/DAG/disk), and
    // an interrupted apply is exactly the failure mode "Cancel sync" must never risk.
    // Everything above was either read-only or already-durable/idempotent network state,
    // so it's fine to cancel through step 3; from here the round always runs to completion.
    // Record this round's causal edges into the op-id DAG FIRST — both our authored
    // ops (the snapshot taken before clearPendingOps) and the ops we pulled — so the
    // merge sees both this round's heads (local's and remote's) and can derive the
    // three-way base (LCA) and fast-forward from graph structure. The returned DAG
    // is handed to the merge.
    dag = await this.host.recordVersionEdges([...local.pendingOps, ...pulled.map(p => p.op)], dag);
    timer?.lap('recordVersionEdges');

    // ── Scoped content staging (A2, §4.3) ────────────────────────────────────
    // `buildLocalIdentity` staged NO bytes; stage now exactly what the merge will
    // read — the local bytes + DAG-reachable bases of the files it reconciles.
    // recordVersionEdges just folded this round's heads into `dag`, so a fresh local
    // head reaches its base here. An untouched file is absent from the scoped set, so
    // its bytes are never staged: staging drops from O(vault) to O(touched this round
    // + their bases), zero on a converged round. A genuinely-missing base stays
    // unstaged and the merge degrades it to a conflict (F1), exactly as before.
    await this.stageMergeContent(local, remote, dag);
    timer?.lap('stageContent');

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
    const { deferred, deferredConflicts, failures } = await this.host.applyMerge(merge.actions, local, remote);
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
    await this.reconcileConcurrentHeads(pulled, dag, local.deviceId, missingContent, deferred, failures);
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
      applyFailures: failures,
    };
  }

  /**
   * Preflight the configured server + token + vault + passphrase WITHOUT mutating
   * anything — the settings "Test connection" affordance, so a setup mistake is
   * caught before the first real round wedges on it. One read-only `preflight`
   * round-trip validates URL + token + vault reachability (server-http maps any
   * failure to the typed error family) *and* returns the key-check record, so we
   * report whether this device's passphrase matches the vault already on the server.
   *
   * This replaces the earlier `blobs:check([])` + `getBlob(keyCheck)` pair — both
   * of which ran the *claiming* access path, so the old "Test connection" would
   * claim an unclaimed vault. `preflight` reads the ownership verdict without ever
   * claiming, so the check is truly side-effect-free.
   */
  async preflight(): Promise<PreflightResult> {
    if (!this.crypto.isReady()) throw new Error('Vault key not derived');
    const { keyCheck } = await this.preflightWithRetry(await this.keyCheckBlobKey());
    const keyState: PreflightKeyState =
      keyCheck === null ? 'unstamped'
        : (await this.crypto.verifyKeyCheck(keyCheck)) ? 'match' : 'mismatch';
    return { keyState };
  }

  /**
   * The preflight call under {@link DEFAULT_PREFLIGHT_RETRY_DELAYS_MS}: a couple of
   * closely-spaced re-attempts so a link that is merely *waking* isn't reported as
   * offline, then the last link error is raised for the caller to surface.
   *
   * Only link failures are retried — a server that answered (bad token, wrong vault,
   * 5xx) will answer identically a half-second later, and re-asking just delays an
   * actionable message. Retrying is safe precisely because preflight is the one
   * non-mutating, non-claiming endpoint: N attempts and 1 attempt leave the server in
   * the same state.
   */
  private async preflightWithRetry(keyCheckKey: string): Promise<{ claimed: boolean; keyCheck: Uint8Array | null }> {
    let lastError: unknown;
    for (const waitMs of this.preflightRetryDelaysMs) {
      // A cancel requested while we're spacing out attempts shouldn't have to wait
      // for the schedule to run out (this whole gate precedes any local mutation).
      this.cancelToken?.throwIfCancelled();
      if (waitMs > 0) await this.sleep(waitMs);
      try {
        return await this.api.preflight(keyCheckKey);
      } catch (err) {
        if (!isTransientLinkError(err)) throw err;
        lastError = err;
      }
    }
    throw lastError as Error;
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
      // Read-only so far (nothing pushed/applied yet) — safe to cancel between pages
      // of a large first-sync pull instead of only at the top of `runSync`.
      this.cancelToken?.throwIfCancelled();
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
    // Which live remote hashes must land in `remote.contentStore` for the merge? A
    // content hash is a cryptographic content identity, so "do I already have this?"
    // is answerable without a byte read or a network round-trip. Three tiers, cheapest
    // first — this is what stops a device re-downloading blobs it already holds (a
    // fresh DAG build over an existing vault, or a cursor-rewind DAG rebuild).
    const missing = new Set<string>();

    // ── Tier 0 — registry match (no I/O, no bytes, no network) ────────────────
    // A remote entry whose file (SAME id) already holds the same content locally is
    // converged: the merge fast-forwards/no-ops it, sourcing any bytes it needs from
    // the LOCAL side (staged scoped at step 5, `stageMergeContent`). So it needs
    // nothing in `remote.contentStore` — skip it entirely. Keyed on (fileId, hash),
    // NOT bare hash membership: a REMOTE-ONLY file whose bytes equal some other local
    // file still reads `remote.contentStore` exclusively (`state-merge.ts` write_local
    // at :84), so it must fall through to Tier 1/2 to get its bytes staged.
    // The skip is against `remote.contentStore`, NOT `local.contentStore`: the two are
    // separate maps, and a remote-only file's write reads `remote.contentStore`
    // exclusively (`state-merge.ts` :84). A hash held only in `local.contentStore` (e.g.
    // an un-opped-edit's drift bytes) does NOT make it available to that read, so keying
    // the skip on local would leave remote empty and silently no-op the write.
    const wanted = new Set<string>();
    for (const [id, entry] of remote.fileEntries) {
      if (entry.deleted) continue;
      if (remote.contentStore.has(entry.contentHash)) continue; // already staged this round
      const le = local.fileEntries.get(id);
      if (le && !le.deleted && le.contentHash === entry.contentHash) continue; // Tier 0: converged
      wanted.add(entry.contentHash);
    }
    if (wanted.size === 0) return missing;

    // ── Tier 1 — pack store (local read, no network) ──────────────────────────
    // Serve every wanted hash the local packs already durably hold straight into
    // `remote.contentStore` (hash-verified, F1-safe), replacing a network round-trip
    // with an amortized local read. Covers remote-only files whose content this device
    // already holds and divergent files whose remote bytes the merge needs.
    const served = await this.host.stageLocalContent(remote, wanted);
    for (const h of served) wanted.delete(h);
    if (wanted.size === 0) return missing;

    // ── Tier 2 — download the genuine gaps from the server ────────────────────
    this.onProgress?.(`Downloading ${wanted.size} file(s)…`);

    // Blind every wanted content hash once, keeping the reverse map so a returned
    // (or absent) blinded key resolves back to the content hash the store is keyed
    // by. `blobs:fetch` collapses ⌈N/blobBatchMaxCount⌉ requests out of N GETs.
    const byBlinded = new Map<string, string>(); // blinded → contentHash
    for (const contentHash of wanted) {
      byBlinded.set(await this.crypto.blindHash(contentHash), contentHash);
    }
    const blinded = [...byBlinded.keys()];

    // Partition into count-bounded chunks (≤ the server's per-batch cap); the
    // combined-byte cap is unknowable ahead of a download, so an oversized batch is
    // recovered by split-and-retry inside `getBlobBatchSplit`, not planned around.
    const chunks: string[][] = [];
    for (let i = 0; i < blinded.length; i += this.blobBatchMaxCount) {
      chunks.push(blinded.slice(i, i + this.blobBatchMaxCount));
    }

    const total = wanted.size;
    let done = 0;
    const bump = (n: number): void => {
      done += n;
      if (total > this.blobBatchMaxCount) this.onProgress?.(`Downloading files ${done}/${total}…`);
    };

    // Overlap the chunk round-trips with a bounded worker pool, mirroring the
    // upload path. Each chunk decrypts + hash-verifies its blobs and stages them;
    // a hash absent from the response strands its content hash (F3).
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        // Read-only — safe to cancel between chunks of a large first-sync download.
        this.cancelToken?.throwIfCancelled();
        const i = next++;
        if (i >= chunks.length) return;
        await this.fetchBlobChunk(chunks[i]!, byBlinded, remote, missing, bump);
      }
    };
    const workers = Math.min(this.blobDownloadConcurrency, chunks.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return missing;
  }

  /**
   * Download one chunk of blinded hashes in a single `blobs:fetch`, then for each:
   * decrypt, verify it hashes back to the asserted content hash, and stage it in
   * the remote content store. A hash the server didn't return is absent — its
   * content hash goes to `missing` so the caller holds the cursor and retries (F3).
   */
  private async fetchBlobChunk(
    chunk: string[],
    byBlinded: Map<string, string>,
    remote: VaultState,
    missing: Set<string>,
    bump: (n: number) => void,
  ): Promise<void> {
    const blobs = await this.getBlobBatchSplit(chunk);
    for (const blinded of chunk) {
      const contentHash = byBlinded.get(blinded)!;
      const envelope = blobs.get(blinded);
      if (!envelope) { missing.add(contentHash); continue; } // absent — merge no-ops it; hold the cursor (F3)
      const content = await this.crypto.decryptBlob(envelope);
      if ((await sha256Hex(content)) !== contentHash) {
        throw new Error(`Blob ${blinded} failed content-hash verification`);
      }
      remote.contentStore.set(contentHash, content);
    }
    bump(chunk.length);
  }

  /**
   * `getBlobBatch` for a chunk, recovering the server's combined-size 413
   * (`BatchTooLargeError`) by halving the chunk and retrying each half. A single
   * blob still over the cap can't ride any batch, so it streams via single `getBlob`
   * — the download analogue of the upload path routing a large blob to `putBlob`.
   */
  private async getBlobBatchSplit(hashes: string[]): Promise<Map<string, Uint8Array>> {
    try {
      return (await this.api.getBlobBatch(hashes)).blobs;
    } catch (err) {
      if (!(err instanceof BatchTooLargeError)) throw err;
      if (hashes.length <= 1) {
        const one = new Map<string, Uint8Array>();
        const bytes = await this.api.getBlob(hashes[0]!);
        if (bytes) one.set(hashes[0]!, bytes);
        return one;
      }
      const mid = Math.floor(hashes.length / 2);
      const [a, b] = await Promise.all([
        this.getBlobBatchSplit(hashes.slice(0, mid)),
        this.getBlobBatchSplit(hashes.slice(mid)),
      ]);
      return new Map<string, Uint8Array>([...a, ...b]);
    }
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
      // Each batch append is idempotent by clientOpId — safe to cancel between
      // batches of a large offline backlog.
      this.cancelToken?.throwIfCancelled();
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
    // Once any unit fails, the round is aborted and other in-flight workers'
    // completions must not resurrect progress state after the caller has
    // already reset it in response to the failure (see `aborted` below).
    let aborted = false;
    const bump = (n: number): void => {
      done += n;
      if (aborted) return;
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
        if (aborted) return;
        // Every upload is idempotent by hash (method doc) — safe to cancel between
        // blobs of a large first-sync push, same as the abort-on-failure path below.
        if (this.cancelToken?.isCancelled) {
          aborted = true;
          this.cancelToken.throwIfCancelled();
        }
        const i = next++;
        if (i >= units.length) return;
        try {
          await units[i]!();
        } catch (err) {
          aborted = true;
          throw err;
        }
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
   * Stage the local bytes the main merge will read this round (A2, §4.3). The merge
   * reads `local.contentStore.get(hash)` only for a file it reconciles: one the remote
   * projection names (touched since our cursor), plus — for an F2 create/create
   * collision — a local-only live file whose PATH a live remote entry also occupies,
   * whose bytes `resolveCreateCollision` reads under the LOCAL id (not the remote one).
   * A local-only non-colliding file falls to `send_remote`, which reads no bytes
   * (§4.1), so it is deliberately absent from the scope. Everything else is untouched
   * and never read — the O(vault)→O(touched) cut.
   *
   * Stage-side Tier 0 (stage-merge-converged-skip-spec): a file both sides already
   * agree on — same content, same head op-id, same path — is reconciled by the merge
   * as a bytes-free `no_op` (state-merge.ts :133 → :177; the byte-reading :161/:170
   * branches are gated on differing heads), so it is dropped from the projection here
   * rather than read. On a whole-vault re-pull (cursor rewind → the remote projection
   * IS the vault) this removes the residual O(vault) local pack read A2's scoping still
   * incurred, mirroring the pull-download Tier 0 in `fetchRemoteBlobs`.
   */
  private async stageMergeContent(local: VaultState, remote: VaultState, dag: VersionDag): Promise<void> {
    const fileIds = new Set<string>();
    for (const [id, re] of remote.fileEntries) {
      const le = local.fileEntries.get(id);
      // Stage-side Tier 0: a file both sides agree on — same content, same head, same
      // path — is reconciled by the merge as a bytes-free no_op (state-merge.ts :133 →
      // :177; the byte-reading :161/:170 branches are gated on differing heads). Staging
      // its local bytes + bases is wasted pack I/O. `headVersionId` must be present and
      // equal (two absent heads compare === but are not a proven no_op → do NOT skip).
      if (
        le && !le.deleted && !re.deleted &&
        le.headVersionId != null && le.headVersionId === re.headVersionId &&
        le.contentHash === re.contentHash &&
        le.path === re.path
      ) {
        continue;
      }
      fileIds.add(id);
    }

    // Unchanged intent: a LOCAL-ONLY file colliding by path with a live remote entry
    // (F2 create/create) is a genuine reconciliation whose bytes the merge reads — always
    // stage it. `!remote.fileEntries.has(id)` keeps this to genuinely local-only ids: a
    // file already named by the remote projection was decided by the loop above (staged
    // unless converged), so re-adding it here would undo the converged skip.
    const remoteLivePaths = new Set<string>();
    for (const re of remote.fileEntries.values()) if (!re.deleted) remoteLivePaths.add(re.path);
    if (remoteLivePaths.size > 0) {
      for (const [id, le] of local.fileEntries) {
        if (!le.deleted && !remote.fileEntries.has(id) && remoteLivePaths.has(le.path)) fileIds.add(id);
      }
    }
    await this.stageForFiles(local, fileIds, dag);
  }

  /**
   * Stage, into `state.contentStore`, the local bytes + DAG-reachable bases for each
   * of `fileIds` — the merge inputs for the files being reconciled. `dag` must already
   * hold this round's heads (call after `recordVersionEdges`), so a fresh local head
   * reaches its base. A base whose bytes are genuinely absent is left unstaged and the
   * merge degrades it to a conflict (F1). Shared by the main round
   * (`stageMergeContent`) and the multi-head reconcile sweep.
   *
   * The ancestor walk is **bounded by what the store still holds**: the full chain is
   * as long as the file's whole edit history, so a note edited a thousand times used
   * to walk a thousand nodes and hand a thousand hashes to `stageContent` — one
   * content-store probe each — on every round that touched it, though the merge can
   * use at most one of them (the LCA) and everything past the retention horizon was
   * collected long ago. Cutting each branch at the first version whose bytes are gone
   * makes the round cost O(retained history) instead of O(edits-ever); the boundary
   * hash is still requested, so `stageContent`'s live-path fallback is unaffected and
   * a base that survives is staged exactly as before.
   */
  private async stageForFiles(state: VaultState, fileIds: Iterable<string>, dag: VersionDag): Promise<void> {
    // A hash already staged this round (identity's drift bytes) is usable even if the
    // persistent store never held it — so it must not cut the walk either.
    const bounds = { has: (h: string) => state.contentStore.has(h) || this.host.hasStoredContent(h) };
    const needed = new Set<string>();
    for (const id of fileIds) {
      const le = state.fileEntries.get(id);
      if (!le || le.deleted) continue;
      if (le.contentHash !== '') needed.add(le.contentHash);
      if (le.headVersionId) {
        for (const h of dag.reachableContentHashes(le.headVersionId, bounds)) needed.add(h);
      }
    }
    await this.host.stageContent(state, needed);
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
    /** Accumulator for actions that threw inside a fold's apply — appended to the
     *  round's `applyFailures` so a fold failure is as visible as a main-apply one
     *  instead of being swallowed with the rest of this sweep's ignored result. */
    failures: ApplyFailure[],
  ): Promise<void> {
    // ── Diagnostic sub-phase timing (perfLog only; zero cost when off) ────────
    // Attributes the reconcile lap across its regions so a slow first-sync round shows
    // exactly where the time goes (precheck vs whole-vault rebuild vs enumeration vs
    // fold I/O). `reconcile:*Files/passes/folds` values are COUNTS, not ms. Emitted
    // once at the single exit via `emit()` so the early-return paths report too.
    const perf = this.perfLog;
    const T = perf ? nowMs : null;
    let tBuild = 0, tRecord = 0, tStage = 0, tEnum = 0, tFetch = 0, tFold = 0, tPrecheck = 0;
    let passes = 0, folds = 0;
    const emit = (touchedCount: number, multiHeadCount: number): void => {
      if (!perf) return;
      perf('reconcile:touchedFiles', touchedCount);   // COUNT
      perf('reconcile:multiHeadFiles', multiHeadCount); // COUNT (files with ≥2 leaves)
      perf('reconcile:passes', passes);               // COUNT
      perf('reconcile:folds', folds);                 // COUNT
      perf('reconcile:precheck', tPrecheck);
      perf('reconcile:buildIdentity', tBuild);
      perf('reconcile:recordEdges', tRecord);
      perf('reconcile:stageForFiles', tStage);
      perf('reconcile:enumerate', tEnum);
      perf('reconcile:fetchLeafBytes', tFetch);
      perf('reconcile:foldMergeApply', tFold);
    };

    // fileIds a peer touched this round, plus a lookup from a leaf's version-id
    // (op-id) to the pulled op that carries its path/HLC/type/contentHash — the DAG
    // node alone doesn't record those.
    const touched = new Set<string>();
    const opById = new Map<string, Operation>();
    for (const { op } of pulled) {
      opById.set(op.id, op);
      if (op.hlcTimestamp.deviceId !== ownDeviceId) touched.add(op.fileId);
    }
    // No peer touched anything this round (the common converged / solo round) — nothing
    // to reconcile and nothing worth attributing; return silently so the perf log isn't
    // padded with a zero-work breakdown every round. The sub-phase lines below fire only
    // on a round that actually pulled peer ops.
    if (touched.size === 0) return;

    // Cheap pre-check on the in-memory DAG before paying for a full O(vault)
    // `buildLocalState` (the perf logs show this at ~69s on a large mobile vault):
    // reconciliation only has work when some touched file has ≥2 open leaves — a
    // genuine concurrent divergence. A converged file has exactly one leaf. Without
    // this, EVERY round that merely pulled a peer op ran one whole-vault buildLocalState
    // below just to discover there was nothing to fold.
    //
    // Resolve every file's leaves in ONE O(nodes) pass (`leavesByFile`), NOT
    // `dag.leaves(fileId)` per touched file — that rebuilds the whole child-set on each
    // call, so a first sync pulling a peer op for each of thousands of files spent
    // O(files·nodes) ≈ O(vault²) here (a measured ~30s precheck at ~16.8k touched files,
    // zero of them multi-head). One pass + an O(1) lookup per touched file collapses it.
    const preStart = T ? T() : 0;
    const leavesByFile = dag.leavesByFile();
    let multiHeadCount = 0;
    for (const fileId of touched) if ((leavesByFile.get(fileId)?.length ?? 0) >= 2) multiHeadCount++;
    if (T) tPrecheck = T() - preStart;
    if (multiHeadCount === 0) { emit(touched.size, 0); return; }

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
      passes++;
      let s = T ? T() : 0;
      const local = await this.host.buildLocalIdentity(dag);
      if (T) tBuild += T() - s;
      // Fold any merge node a previous iteration minted (now a pending op, not yet
      // in the persisted DAG) into the graph so this fold's LCA/leaf scan AND the
      // scoped staging below see it.
      s = T ? T() : 0;
      dag = await this.host.recordVersionEdges(local.pendingOps, dag);
      if (T) tRecord += T() - s;
      // Stage only the bytes the fold's pairwise merge reads: each multi-head file's
      // local head bytes + its DAG-reachable bases (the LCA against the extra leaf).
      // The extra leaf's own bytes are fetched separately below. Scoped to `touched`
      // (the concurrent-divergence files), never the whole vault (A2, §4.3).
      s = T ? T() : 0;
      await this.stageForFiles(local, touched, dag);
      if (T) tStage += T() - s;

      // One O(nodes) pass for this pass's leaves (dag just changed via recordVersionEdges),
      // then an O(1) lookup per touched file below — never `dag.leaves(fileId)` per file.
      const passLeaves = dag.leavesByFile();
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
        const eStart = T ? T() : 0;
        const extras = (passLeaves.get(fileId) ?? [])
          .filter(v => v !== localHead && !dag.isAncestor(v, localHead))
          .sort();

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
        if (T) tEnum += T() - eStart;   // leaves + isAncestor + mergeBase, per file per pass
        if (!leafId || !leafOp) continue;
        attempted.add(fileId + ' ' + leafId);

        const leafHash = dag.contentHashOf(leafId) ?? leafOp.contentHash;
        // Stage the extra leaf's bytes (the HLC-max projection never fetched them).
        // Absent on the server → hold the cursor (F3) and retry next round.
        s = T ? T() : 0;
        let bytes = local.contentStore.get(leafHash) ?? null;
        if (!bytes) bytes = await this.fetchBlob(leafHash);
        if (T) tFetch += T() - s;
        if (!bytes) { missingContent.add(leafHash); continue; }

        // Reconcile our head against this one extra leaf via the ordinary pairwise
        // merge. The base (LCA) bytes are already staged by buildLocalState (they are
        // reachable from our head); a known-but-missing base degrades to a conflict
        // inside mergeVaultStates (F1), never a union.
        const foldStart = T ? T() : 0;
        const localOne = singleFileState(local, fileId);
        const remoteOne = leafRemoteState(leafOp, leafId, leafHash, bytes);
        const merge = mergeVaultStates(localOne, remoteOne, dag);
        // Monotonic clock advance. Folding every foldable file within ONE pass means
        // `local.hlc` is the pass-start snapshot (stale) for all but the first fold, so a
        // later fold's `mergedHlc` can sit below an earlier fold's. Take the running max
        // so the minted op — stamped with `hlc.getCurrent()` inside applyMerge — never
        // regresses the clock (F7) while still dominating its own parents (mergedHlc ≥
        // both). The merge NODE id is content-addressed (order-independent parents), so a
        // higher stamp never changes cross-device convergence; only the per-fold rebuild
        // used to keep this monotonic, which is exactly the cost being removed.
        this.hlc.setCurrent(hlcMax(this.hlc.getCurrent(), merge.mergedHlc));
        failures.push(...(await this.host.applyMerge(merge.actions, localOne, remoteOne)).failures);
        if (T) tFold += T() - foldStart;   // singleFileState + mergeVaultStates + applyMerge
        folds++;
        folded = true;
        // No `break`: fold EVERY foldable file in this single pass rather than one file
        // per whole-vault `buildLocalIdentity`. Each touched file is independent — a
        // distinct fileId owns distinct DAG leaves/LCA and a distinct registry entry — so
        // folding one leaves the stale `local`/`dag` valid for the rest (applyMerge
        // mutates disk + registry for THIS file only; the minted node belongs to another
        // fileId and isn't needed until the next pass folds it in). Only a file with a
        // 3rd concurrent leaf needs another pass, which the outer loop still provides.
        // This turns O(folds) rebuilds into O(passes) (≈ max concurrent leaves per file,
        // normally 1) — the fix for the ~9s first-sync reconcile lap.
      }
      if (!folded) break;
    }
    emit(touched.size, multiHeadCount);
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
