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
  ancestorContentHash: string | null;  // hash at last successful sync (for three-way merge)
  // Path at last successful sync. Lets the merge tell a *rename* since the last
  // sync from an untouched file: a concurrent delete of an untouched file
  // propagates cleanly, but of a renamed one is a delete/rename conflict.
  // Optional for migration — a legacy entry without it is treated as un-renamed.
  ancestorPath?: string | null;
  // Content hashes this entry's content resolved/superseded. Set only on a
  // user-resolved conflict: the two conflicting sides the human chose between.
  // A peer that still holds one of these hashes adopts this content cleanly
  // instead of re-prompting — the decision already weighed its version.
  supersedes?: string[];
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
  // Set only on a resolution op (a user-resolved conflict re-emitted by the
  // applicator): the content hashes of the two conflicting sides this
  // resolution supersedes. A peer still holding one of them adopts the
  // resolution instead of re-conflicting. See FileEntry.supersedes.
  supersedes?: string[];
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
  | { type: 'send_remote'; fileId: string; path: string; content: Uint8Array; hlc: HLC }
  | { type: 'delete_local'; fileId: string; path: string }
  | { type: 'delete_remote'; fileId: string; path: string }
  | { type: 'move_local'; fileId: string; fromPath: string; toPath: string }
  | { type: 'conflict'; fileId: string; localPath: string; remotePath: string; mergeResult: ThreeWayMergeResult; localContent: string; remoteContent: string; parentHashes: string[] }
  | { type: 'delete_conflict'; fileId: string; path: string; side: 'local_deleted' | 'remote_deleted'; content: Uint8Array; parentHashes: string[] }
  // Two devices edited the same *binary* file concurrently. Binary content can't
  // be three-way merged, so rather than silently dropping one side by
  // last-writer-wins the user chooses which whole version to keep (presented by
  // filename + metadata — there is no meaningful content diff to show). Both
  // versions are carried so the applicator can write the chosen one; parentHashes
  // are the two sides the resolution supersedes (like `conflict`).
  | { type: 'binary_conflict'; fileId: string; localPath: string; remotePath: string; localContent: Uint8Array; remoteContent: Uint8Array; localHlc: HLC; remoteHlc: HLC; parentHashes: string[] }
  | { type: 'no_op'; fileId: string };

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
  ],
  deleteConflictStrategy: 'ask',
  syncObsidianConfig: false,
  ancestorRetentionDays: 30,
};
