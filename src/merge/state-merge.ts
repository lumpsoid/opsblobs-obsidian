// ─────────────────────────────────────────────
//  State Merge Function
//  Phase 2.1
// ─────────────────────────────────────────────
//
//  Pure function — no side effects.
//  Compares two VaultStates and returns a list of actions to apply.
//  Commutative: merge(A, B) produces equivalent actions as merge(B, A).

import { VaultState, FileEntry, MergeAction, StateMergeResult } from '../types';
import { hlcCompare, hlcMax } from '../core/hlc';
import { threeWayMerge } from './diff3';

export function mergeVaultStates(local: VaultState, remote: VaultState): StateMergeResult {
  const actions: MergeAction[] = [];
  const mergedHlc = hlcMax(local.hlc, remote.hlc);

  // Union of all file UUIDs
  const allIds = new Set([
    ...local.fileEntries.keys(),
    ...remote.fileEntries.keys(),
  ]);

  for (const fileId of allIds) {
    const localEntry = local.fileEntries.get(fileId);
    const remoteEntry = remote.fileEntries.get(fileId);

    const action = classifyAndResolve(fileId, localEntry, remoteEntry, local, remote);
    actions.push(action);
  }

  return { actions, mergedHlc };
}

function classifyAndResolve(
  fileId: string,
  localEntry: FileEntry | undefined,
  remoteEntry: FileEntry | undefined,
  local: VaultState,
  remote: VaultState,
): MergeAction {

  // ── Only one side knows about this file ─────────────────────────────────
  if (!localEntry && remoteEntry) {
    if (remoteEntry.deleted) return { type: 'no_op', fileId };
    const content = remote.contentStore.get(remoteEntry.contentHash);
    if (!content) return { type: 'no_op', fileId }; // can't write without content
    return {
      type: 'write_local',
      fileId,
      path: remoteEntry.path,
      content,
      hlc: remoteEntry.hlcTimestamp,
    };
  }

  if (localEntry && !remoteEntry) {
    if (localEntry.deleted) return { type: 'no_op', fileId };
    const content = local.contentStore.get(localEntry.contentHash);
    if (!content) return { type: 'no_op', fileId };
    return {
      type: 'send_remote',
      fileId,
      path: localEntry.path,
      content,
      hlc: localEntry.hlcTimestamp,
    };
  }

  // Both sides know about this file
  const le = localEntry!;
  const re = remoteEntry!;

  // ── Both deleted ─────────────────────────────────────────────────────────
  if (le.deleted && re.deleted) {
    return { type: 'no_op', fileId };
  }

  // ── Same content ─────────────────────────────────────────────────────────
  if (!le.deleted && !re.deleted && le.contentHash === re.contentHash) {
    // Handle rename conflict even if content is same
    if (le.path !== re.path) {
      return resolveRenameConflict(fileId, le, re);
    }
    return { type: 'no_op', fileId };
  }

  // ── One side deleted ─────────────────────────────────────────────────────
  // A *clean* one-sided delete: the surviving side has not touched the file
  // since the last common sync (its content still matches the shared ancestor),
  // so the deletion propagates without asking. If the surviving side changed
  // the file, it's a genuine delete/modify conflict.
  if (le.deleted && !re.deleted) {
    // Remote holds a present file. If it is a *restore* resolution whose
    // `supersedes` names our deleted side, a peer already settled this
    // delete/modify conflict in favour of keeping the file — adopt it instead of
    // re-prompting (mirrors the content-conflict shortcut in resolveContentConflict).
    if (re.supersedes?.includes(le.contentHash)) {
      const content = remote.contentStore.get(re.contentHash) ?? local.contentStore.get(re.contentHash);
      if (content) return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp };
    }
    if (isUnchangedSinceAncestor(re)) {
      return { type: 'delete_remote', fileId, path: re.path };
    }
    const content = remote.contentStore.get(re.contentHash) ?? new Uint8Array();
    return { type: 'delete_conflict', fileId, path: re.path, side: 'local_deleted', content, parentHashes: [le.contentHash, re.contentHash] };
  }

  if (!le.deleted && re.deleted) {
    // Remote is a delete. If it is a *keep_deleted* resolution whose `supersedes`
    // names our present content, a peer already settled this conflict in favour
    // of the deletion — accept it cleanly instead of re-prompting.
    if (re.supersedes?.includes(le.contentHash)) {
      return { type: 'delete_local', fileId, path: le.path };
    }
    if (isUnchangedSinceAncestor(le)) {
      return { type: 'delete_local', fileId, path: le.path };
    }
    const content = local.contentStore.get(le.contentHash) ?? new Uint8Array();
    return { type: 'delete_conflict', fileId, path: le.path, side: 'remote_deleted', content, parentHashes: [le.contentHash, re.contentHash] };
  }

  // ── Both modified (different content, neither deleted) ───────────────────
  // This is the three-way merge case
  return resolveContentConflict(fileId, le, re, local, remote);
}

function resolveContentConflict(
  fileId: string,
  le: FileEntry,
  re: FileEntry,
  local: VaultState,
  remote: VaultState,
): MergeAction {
  // ── Already-resolved conflict ────────────────────────────────────────────
  // One side is a user-resolved conflict whose `supersedes` set names the exact
  // content hashes the human chose between. If the *other* side still holds one
  // of those superseded versions, the resolution already accounts for it —
  // adopt it wholesale rather than re-running a three-way merge that would just
  // re-surface the same conflict a peer already settled. Deterministic on both
  // devices: only the resolution carries `supersedes`, so exactly one branch fires.
  if (re.supersedes?.includes(le.contentHash)) {
    // Content is hash-addressed: prefer the remote store, but fall back to the
    // local one — an unchanged-content resolution (e.g. a rename) is skipped by
    // fetchRemoteBlobs precisely because we already hold those bytes.
    const content = remote.contentStore.get(re.contentHash) ?? local.contentStore.get(re.contentHash);
    if (content) {
      return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp };
    }
  }
  if (le.supersedes?.includes(re.contentHash)) {
    // Our own content is the resolution and the remote holds a superseded side —
    // keep ours and push it (send_remote), don't merge back toward the old version.
    const content = local.contentStore.get(le.contentHash);
    if (content) {
      return { type: 'send_remote', fileId, path: le.path, content, hlc: le.hlcTimestamp };
    }
  }

  // Retrieve file content
  const localContent = local.contentStore.get(le.contentHash);
  const remoteContent = remote.contentStore.get(re.contentHash);

  if (!localContent || !remoteContent) {
    // Can't merge without content — defer to higher HLC
    const winner = hlcCompare(le.hlcTimestamp, re.hlcTimestamp) >= 0 ? le : re;
    const content = (winner === le ? localContent : remoteContent) ?? new Uint8Array();
    return { type: 'write_local', fileId, path: winner.path, content, hlc: winner.hlcTimestamp };
  }

  const localText = new TextDecoder().decode(localContent);
  const remoteText = new TextDecoder().decode(remoteContent);

  // If it's a binary file, skip text merge
  if (isBinary(localContent) || isBinary(remoteContent)) {
    // For binary files: higher HLC wins deterministically
    if (hlcCompare(le.hlcTimestamp, re.hlcTimestamp) >= 0) {
      return { type: 'no_op', fileId }; // local wins, nothing to do
    } else {
      return { type: 'write_local', fileId, path: re.path, content: remoteContent, hlc: re.hlcTimestamp };
    }
  }

  // Attempt three-way merge using ancestor
  const ancestorHash = le.ancestorContentHash ?? re.ancestorContentHash;
  const ancestorContent = ancestorHash
    ? (local.contentStore.get(ancestorHash) ?? remote.contentStore.get(ancestorHash))
    : undefined;

  const ancestorText = ancestorContent
    ? new TextDecoder().decode(ancestorContent)
    : '';  // Fall back to empty ancestor if not available

  const mergeResult = threeWayMerge(ancestorText, localText, remoteText);

  if (!mergeResult.hasConflicts) {
    // Clean merge — write result locally and send to remote
    const merged = mergeResult.merged.join('\n');
    const content = new TextEncoder().encode(merged);
    return {
      type: 'write_local',
      fileId,
      path: le.path,
      content,
      hlc: hlcMax(le.hlcTimestamp, re.hlcTimestamp),
    };
  }

  // True conflict — needs user resolution. Carry the two conflicting content
  // hashes so the applicator can tag the resolution op with what it supersedes,
  // letting peers that still hold either side adopt the resolution cleanly.
  return {
    type: 'conflict',
    fileId,
    localPath: le.path,
    remotePath: re.path,
    mergeResult,
    localContent: localText,
    remoteContent: remoteText,
    parentHashes: [le.contentHash, re.contentHash],
  };
}

function resolveRenameConflict(fileId: string, le: FileEntry, re: FileEntry): MergeAction {
  // Higher HLC timestamp wins
  if (hlcCompare(le.hlcTimestamp, re.hlcTimestamp) >= 0) {
    return { type: 'no_op', fileId }; // local path wins, nothing to change locally
  } else {
    return { type: 'move_local', fileId, fromPath: le.path, toPath: re.path };
  }
}

/**
 * Has this entry been left untouched since the last common sync? True only when
 * we have a recorded ancestor hash, the current content still equals it, *and*
 * the path is unchanged — the signal that the *other* side's deletion can be
 * applied cleanly rather than surfaced as a delete/modify(-or-rename) conflict.
 * A null content ancestor (never synced) is treated as "changed" so we err
 * toward asking. A renamed file (path differs from the ancestor path) counts as
 * touched: a concurrent delete of it is a delete/rename conflict, not a silent
 * removal. A legacy entry lacking an ancestor path is treated as un-renamed so
 * the migration doesn't manufacture false conflicts.
 */
function isUnchangedSinceAncestor(entry: FileEntry): boolean {
  const contentUnchanged =
    entry.ancestorContentHash !== null && entry.contentHash === entry.ancestorContentHash;
  const pathUnchanged = entry.ancestorPath == null || entry.path === entry.ancestorPath;
  return contentUnchanged && pathUnchanged;
}

/** Number of leading bytes sniffed for a null byte when detecting binary content. */
const BINARY_SNIFF_BYTES = 8192;

/** Heuristic binary detection: check for null bytes in the first 8KB. */
function isBinary(content: Uint8Array): boolean {
  const sample = content.slice(0, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}
