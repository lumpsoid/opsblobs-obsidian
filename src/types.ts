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
}

export type OperationType = 'create' | 'update' | 'delete' | 'move';

export interface Operation {
  id: string;              // unique operation ID
  deviceId: string;        // which device generated this
  hlcTimestamp: HLC;       // when it happened (HLC)
  fileId: string;          // UUID of the file
  type: OperationType;
  path: string;            // file path at time of operation
  contentHash: string;     // hash of file content after operation
  previousPath?: string;   // for move/rename operations only
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
  resolution?: 'local' | 'remote' | 'both' | 'custom';
  customText?: string[];
}

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
  | { type: 'conflict'; fileId: string; localPath: string; remotePath: string; mergeResult: ThreeWayMergeResult; localContent: string; remoteContent: string }
  | { type: 'delete_conflict'; fileId: string; path: string; side: 'local_deleted' | 'remote_deleted'; content: Uint8Array }
  | { type: 'no_op'; fileId: string };

export interface StateMergeResult {
  actions: MergeAction[];
  mergedHlc: HLC;
}

export interface SyncSession {
  sessionId: string;
  remoteDeviceId: string;
  startedAt: number;
  status: 'connecting' | 'exchanging' | 'merging' | 'transferring' | 'applying' | 'complete' | 'error';
  progress?: { current: number; total: number; label: string };
  error?: string;
}

export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  encryptionKeyBase64: string;
  lastSyncHlc: HLC | null;
  lastSyncTime: number | null;
}

export interface SyncSettings {
  deviceId: string;
  deviceName: string;
  pairedDevices: PairedDevice[];
  debounceMs: number;
  excludedPatterns: string[];
  deleteConflictStrategy: 'ask' | 'keep_deleted' | 'keep_modified';
  syncObsidianConfig: boolean;
  ancestorRetentionDays: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  deviceId: '',
  deviceName: '',
  pairedDevices: [],
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

// ─── Protocol messages ────────────────────────────────────────────────────────

export interface ProtoHello {
  type: 'HELLO';
  deviceId: string;
  deviceName: string;
  hlc: HLC;
  sessionId: string;
}

export interface ProtoOpsExchange {
  type: 'OPS_SINCE';
  ops: Operation[];
  lastSyncHlc: HLC | null;
}

export interface ProtoStateExchange {
  type: 'STATE';
  fileEntries: Array<[string, FileEntry]>;  // serialised map entries
}

export interface ProtoContentRequest {
  type: 'CONTENT_REQUEST';
  hashes: string[];
}

export interface ProtoContentResponse {
  type: 'CONTENT';
  chunks: Array<{ hash: string; dataBase64: string }>;
}

export interface ProtoSyncComplete {
  type: 'SYNC_COMPLETE';
  newHlc: HLC;
}

export interface ProtoError {
  type: 'ERROR';
  code: string;
  message: string;
}

export type ProtoMessage =
  | ProtoHello
  | ProtoOpsExchange
  | ProtoStateExchange
  | ProtoContentRequest
  | ProtoContentResponse
  | ProtoSyncComplete
  | ProtoError;
