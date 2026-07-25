// ─────────────────────────────────────────────
//  Core Types — Obsidian Vault Sync
// ─────────────────────────────────────────────

export interface HLC {
  wallTime: number;   // physical timestamp (ms)
  counter: number;    // logical counter for same-ms events
  deviceId: string;   // tie-breaker for identical timestamps
}

export interface FileEntry {
  id: string;                          // UUID, assigned at creation, never changes
  path: string;                        // current vault-relative path
  contentHash: string;                 // SHA-256 of current content
  hlcTimestamp: HLC;                   // hybrid logical clock at last modification
  deleted: boolean;                    // tombstone flag
  // Path at last successful sync. Lets the merge tell a *rename* since the last
  // sync from an untouched file: a concurrent delete of an untouched file
  // propagates cleanly, but of a renamed one is a delete/rename conflict. The
  // three-way base is now the op-id DAG's LCA (not a scalar content ancestor), so
  // only the *path* at last sync is still tracked here; content lineage lives in
  // the DAG. Null until the file has synced once. Optional for migration — a
  // legacy entry without it is treated as un-renamed.
  lastSyncedPath?: string | null;
  // The version-id (op-id) of this file's current head — the content version a
  // new local edit descends from, recorded as that edit's `parents` (sync v2).
  // A version's identity is the op-id, NOT the content hash: content recurs
  // (empty → "3" → empty), so a content-hash-keyed DAG cycles and breaks LCA;
  // op-ids are HLC-unique so the DAG stays acyclic. Set whenever content changes
  // (create/update/delete → the new op's id; adopting a remote version → that
  // op's id). `null` until the file has a synced version. See
  // docs/sync-v2-decisions.md §3. Optional for migration — a legacy entry
  // without it reads as null (no known head ⇒ the merge falls back).
  headVersionId?: string | null;
  // The two open head version-ids `[A, B]` while this file is *two-headed* — a
  // text conflict was surfaced as inline zdiff3 markers on disk and is awaiting
  // resolution (sync v2 Step 5). Set by the applicator's `conflict` case (via
  // `markConflicted`); the next ordinary save that removes the markers re-emits a
  // two-parent merge node with exactly these `parents`, then clears this. While it
  // is set the merge does NOT re-conflict (it would nest markers) — it holds or
  // adopts a peer's resolution. `null`/absent means the file is not conflicted. A
  // *projected remote* entry never carries it (a local-only working-copy notion,
  // like `lastSyncedPath`).
  conflictParents?: string[] | null;
  // Cheap change-detection cache: the file's on-disk `mtime` (ms) and byte `size`
  // the last time we hashed its content (O1). `captureOfflineChanges` skips the
  // re-read + re-hash of any tracked file whose current stat still matches this
  // pair, turning an every-sync O(F) drift scan into O(touched). LOCAL-ONLY and
  // self-healing: a *projected remote* entry never carries it (like
  // `lastSyncedPath`/`conflictParents`), and a stale/absent value costs at most one
  // redundant re-hash — which then records the fresh stat and gates the file forever
  // after. `mtime + size` is a *heuristic* for "unchanged": an offline edit that
  // preserves BOTH bytes-for-byte is missed and never syncs (the exact fast-path
  // heuristic rsync/git/Obsidian-sync rely on); **Rebuild sync metadata** forces a
  // full re-hash for anyone who suspects a miss. See
  // docs/capture-optimization-spec.md §3. Absent until content is first hashed.
  mtime?: number;
  size?: number;
}

export type OperationType = 'create' | 'update' | 'delete' | 'move';

/** Current op-format version. Bump when the at-rest / on-wire shape of an
 *  {@link Operation} changes in a non-additive way, so a reader can dispatch on
 *  `op.v`. Ops written before versioning existed carry no `v` and are format 1. */
export const OP_FORMAT_VERSION = 1;

export interface Operation {
  v: number;               // op-format version (OP_FORMAT_VERSION); absent on legacy ops ⇒ 1
  id: string;              // unique operation ID
  hlcTimestamp: HLC;       // when it happened (HLC); its deviceId is the authoring device
  fileId: string;          // UUID of the file
  type: OperationType;
  path: string;            // file path at time of operation
  contentHash: string;     // hash of file content after operation
  // The content hash(es) this version was derived from — the op's causal parents
  // in the per-file content DAG (sync v2). A `create` is a root (`[]`); an
  // ordinary edit or delete has the single prior content hash (`[prevHash]`); a
  // merge node has both reconciled heads (`[headA, headB]`). Carried on the wire
  // so a peer can reconstruct the DAG and compute the true three-way base (LCA)
  // rather than relying on a locally-tracked scalar ancestor, which cannot
  // testify to what a peer's edit was based on. See docs/sync-v2-decisions.md.
  parents: string[];
}

export interface VaultState {
  deviceId: string;
  hlc: HLC;
  fileEntries: Map<string, FileEntry>;       // UUID → FileEntry
  pendingOps: Operation[];                   // ops since last successful sync
  contentStore: Map<string, Uint8Array>;     // hash → file content
}

export interface ConflictChunk {
  startLine: number;
  endLine: number;
  ancestor: string[];
  local: string[];
  remote: string[];
}

// How a user resolved a single ConflictChunk. A discriminated union so an
// invalid combination cannot be represented: 'custom' always carries its text.
export type ConflictResolution =
  | { kind: 'local' }
  | { kind: 'remote' }
  | { kind: 'both' }
  | { kind: 'custom'; text: string[] };

export interface ThreeWayMergeResult {
  merged: string[];
  conflicts: ConflictChunk[];
  hasConflicts: boolean;
}

export type MergeAction =
  // Adopt a version onto the local file. `headVersionId`, when set, is the exact
  // version-id (op-id) being adopted — the remote op's id — which the applicator
  // records as the file's new head so the next local edit descends from it. It is
  // carried explicitly because an op's id is NOT always `hlcToString(hlc)`: a clean
  // merge node has a content-addressed id, so re-deriving the head from the HLC
  // would name a version no DAG node carries and the next edit would lose its base
  // (sync v2, finding #1). Absent (pure-VaultState unit tests / legacy entries with
  // no head) ⇒ the applicator falls back to `hlcToString(hlc)` as before.
  | { type: 'write_local'; fileId: string; path: string; content: Uint8Array; hlc: HLC; headVersionId?: string }
  // A clean three-way merge of two divergent heads (sync v2): unlike `write_local`
  // (which adopts an existing remote version), this synthesizes a NEW reconciled
  // version, so the applicator mints a two-parent merge op — `parents` are the two
  // reconciled heads (version-ids) — with a deterministic, content-addressed id so
  // two devices merging the same pair produce the identical node (dedup on push).
  // Recording it as a real DAG node is what lets the next edit off a merged file
  // find its base in the graph instead of falling back to the scalar ancestor.
  | { type: 'write_merge'; fileId: string; path: string; content: Uint8Array; parents: string[] }
  // A local-only live file to push to the server. Transport-only: the applicator
  // no-ops it and the push loop uploads the bytes from the pending oplog + content
  // store, NOT from this action — so it carries no `content`. Classified from the
  // entry alone (no staged bytes needed), which is what lets an untouched file need
  // zero content staging while still keeping the `send_remote` vs `no_op` split
  // `updateSyncedPaths` relies on for first-sync path advancement (A2, §4.1).
  | { type: 'send_remote'; fileId: string; path: string; hlc: HLC }
  | { type: 'delete_local'; fileId: string; path: string }
  | { type: 'delete_remote'; fileId: string; path: string }
  | { type: 'move_local'; fileId: string; fromPath: string; toPath: string }
  // `parents` are the two conflicting heads' version-ids (sync v2): a user's
  // resolution of this conflict is re-emitted as a two-parent MERGE NODE with these
  // parents, so a peer holding either head fast-forwards onto the resolution instead
  // of re-conflicting — the structural replacement for the retired `supersedes`
  // shortcut. Set whenever both heads are known (always, for a real synced file);
  // absent only in pure-VaultState unit tests that build entries with no head.
  | { type: 'conflict'; fileId: string; localPath: string; remotePath: string; mergeResult: ThreeWayMergeResult; localContent: string; remoteContent: string; parents?: string[] }
  | { type: 'delete_conflict'; fileId: string; path: string; side: 'local_deleted' | 'remote_deleted'; content: Uint8Array; parents?: string[] }
  // Two devices edited the same *binary* file concurrently. Binary content can't
  // be three-way merged, so rather than silently dropping one side by
  // last-writer-wins the user chooses which whole version to keep (presented by
  // filename + metadata — there is no meaningful content diff to show). Both
  // versions are carried so the applicator can write the chosen one; `parents` are
  // the two conflicting heads, so the resolution replicates as a merge node peers
  // fast-forward onto (like `conflict`).
  | { type: 'binary_conflict'; fileId: string; localPath: string; remotePath: string; localContent: Uint8Array; remoteContent: Uint8Array; localHlc: HLC; remoteHlc: HLC; parents?: string[] }
  | { type: 'no_op'; fileId: string };

/**
 * Does applying this action change the LOCAL vault — write, move, or trash a file, or
 * write conflict markers? `send_remote`/`delete_remote` are transport-only (the
 * applicator no-ops them, the push handles the wire) and `no_op` is nothing.
 *
 * This lives with the type it classifies (Tell, Don't Ask) so callers never re-derive
 * the set by hand. It matters because the merge emits ONE action per file: on a single
 * self-syncing device — whose own re-pulled ops are excluded from the remote projection
 * — every file classifies as `send_remote`, so any "applying N changes" progress/UX
 * that counted raw actions reported the whole vault on an unchanged sync. Count only the
 * actions for which this returns true. Exhaustive by construction: a new `MergeAction`
 * variant fails to compile here until it is classified.
 */
export function affectsLocalVault(action: MergeAction): boolean {
  switch (action.type) {
    case 'write_local':
    case 'write_merge':
    case 'delete_local':
    case 'move_local':
    case 'conflict':
    case 'delete_conflict':
    case 'binary_conflict':
      return true;
    case 'send_remote':
    case 'delete_remote':
    case 'no_op':
      return false;
    default: {
      // Compile-time exhaustiveness: if a new MergeAction type is added, `action` is no
      // longer `never` here and this assignment errors until the type is classified above.
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export interface StateMergeResult {
  actions: MergeAction[];
  mergedHlc: HLC;
}

export interface SyncSettings {
  deviceId: string;
  deviceName: string;

  // ── Server (E2E-encrypted sync target) ──────────────────────────────────
  serverUrl: string;         // e.g. https://sync.example.com
  vaultId: string;           // vault scope on the server (shared across devices)
  serverToken: string;       // Bearer token (spec §9.2)
  vaultPassphrase: string;   // derives the at-rest vault key (never leaves the device)

  // ── Sync behavior ───────────────────────────────────────────────────────
  autoSyncIntervalMinutes: number;  // 0 = manual only
  lastSyncTime: number | null;      // wall-clock ms of last successful round
  debounceMs: number;
  excludedPatterns: string[];
  deleteConflictStrategy: 'ask' | 'keep_deleted' | 'keep_modified';
  syncObsidianConfig: boolean;
  ancestorRetentionDays: number;

  // ── Diagnostics ─────────────────────────────────────────────────────────
  // Emit per-phase sync-round + startup timings to the console (and a log file
  // under `.vault-sync/`) for the mobile perf baseline (docs/mobile-perf-baseline-spec.md
  // Layer 3). Off by default and fully inert when off — the only production hook
  // is a guarded `performance.now()` bracket that isn't even installed unless this
  // is set. A manual, pre-release on-device measurement aid, not an everyday toggle.
  perfLog: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  deviceId: '',
  deviceName: '',
  serverUrl: '',
  vaultId: '',
  serverToken: '',
  vaultPassphrase: '',
  autoSyncIntervalMinutes: 0,
  lastSyncTime: null,
  debounceMs: 1500,
  excludedPatterns: [
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/cache',
    '.vault-sync/**',
    '.git',
    '.git/**',
  ],
  deleteConflictStrategy: 'ask',
  syncObsidianConfig: false,
  ancestorRetentionDays: 30,
  perfLog: false,
};
