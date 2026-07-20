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
  previousPath?: string;   // for move/rename operations only
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
  | { type: 'write_local'; fileId: string; path: string; content: Uint8Array; hlc: HLC }
  | { type: 'send_remote'; fileId: string; path: string; content: Uint8Array; hlc: HLC }
  | { type: 'delete_local'; fileId: string; path: string }
  | { type: 'delete_remote'; fileId: string; path: string }
  | { type: 'move_local'; fileId: string; fromPath: string; toPath: string }
  | { type: 'conflict'; fileId: string; localPath: string; remotePath: string; mergeResult: ThreeWayMergeResult; localContent: string; remoteContent: string; parentHashes: string[] }
  | { type: 'delete_conflict'; fileId: string; path: string; side: 'local_deleted' | 'remote_deleted'; content: Uint8Array; parentHashes: string[] }
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
