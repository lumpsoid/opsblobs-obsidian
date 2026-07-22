// ─────────────────────────────────────────────
//  State Merge Function
//  Phase 2.1
// ─────────────────────────────────────────────
//
//  Pure function — no side effects.
//  Compares two VaultStates and returns a list of actions to apply.
//  Commutative: merge(A, B) produces equivalent actions as merge(B, A).

import { VaultState, FileEntry, MergeAction, StateMergeResult, ThreeWayMergeResult } from '../types';
import { hlcCompare, hlcMax } from '../core/hlc';
import { threeWayMerge } from './diff3';
import { VersionDag, MULTIPLE_BASES } from '../core/version-dag';

/**
 * Pure state merge. When `dag` (the op-id version DAG, sync v2) is supplied, a
 * both-modified content conflict derives its three-way base and fast-forward from
 * graph structure — the true LCA over version-ids — instead of the scalar
 * ancestor. When it is absent (pure-`VaultState` unit tests), it falls back to the
 * scalar-ancestor path unchanged. Commutative: merge(A,B) ≡ merge(B,A).
 */
export function mergeVaultStates(local: VaultState, remote: VaultState, dag?: VersionDag): StateMergeResult {
  const actions: MergeAction[] = [];
  const mergedHlc = hlcMax(local.hlc, remote.hlc);

  // Union of all file UUIDs
  const allIds = new Set([
    ...local.fileEntries.keys(),
    ...remote.fileEntries.keys(),
  ]);

  // F2: path → live fileId lookups. A single-sided ("only one side knows this
  // id") entry may still *collide* with a DIFFERENT live id already occupying its
  // path — two devices that independently created the same file mint different
  // UUIDs. These maps let each single-sided branch detect that collision instead
  // of blindly overwriting.
  const localLiveByPath = liveByPath(local);
  const remoteLiveByPath = liveByPath(remote);

  for (const fileId of allIds) {
    const localEntry = local.fileEntries.get(fileId);
    const remoteEntry = remote.fileEntries.get(fileId);

    const action = classifyAndResolve(
      fileId, localEntry, remoteEntry, local, remote, localLiveByPath, remoteLiveByPath, dag,
    );
    actions.push(action);
  }

  return { actions, mergedHlc };
}

/** Build a path → fileId index over a state's live (non-deleted) entries. */
function liveByPath(state: VaultState): Map<string, string> {
  const index = new Map<string, string>();
  for (const [id, entry] of state.fileEntries) {
    if (!entry.deleted) index.set(entry.path, id);
  }
  return index;
}

function classifyAndResolve(
  fileId: string,
  localEntry: FileEntry | undefined,
  remoteEntry: FileEntry | undefined,
  local: VaultState,
  remote: VaultState,
  localLiveByPath: Map<string, string>,
  remoteLiveByPath: Map<string, string>,
  dag: VersionDag | undefined,
): MergeAction {

  // ── Only one side knows about this file ─────────────────────────────────
  if (!localEntry && remoteEntry) {
    if (remoteEntry.deleted) return { type: 'no_op', fileId };
    // F2: does a *different* live local id already hold this path? If so it's a
    // create/create collision (two independently-minted UUIDs for one path), not
    // a brand-new remote file — reconcile it instead of clobbering the local one.
    const collidingLocalId = localLiveByPath.get(remoteEntry.path);
    if (collidingLocalId !== undefined && collidingLocalId !== fileId) {
      const le = local.fileEntries.get(collidingLocalId)!;
      return resolveCreateCollision(le, remoteEntry, local, remote, /* selfIsRemote */ true);
    }
    const content = remote.contentStore.get(remoteEntry.contentHash);
    if (!content) return { type: 'no_op', fileId }; // can't write without content
    return {
      type: 'write_local',
      fileId,
      path: remoteEntry.path,
      content,
      hlc: remoteEntry.hlcTimestamp,
      headVersionId: remoteEntry.headVersionId ?? undefined,
    };
  }

  if (localEntry && !remoteEntry) {
    if (localEntry.deleted) return { type: 'no_op', fileId };
    // F2 (symmetric): a different live remote id holding this path is the same
    // create/create collision seen from the other side. Reachable: after the peer
    // resolves the collision it re-emits the resolution under the winning id, so
    // this device pulls that id at the same path while still keying it under its
    // own. Defer to the shared resolver (only the *winner's* branch acts; the
    // loser's branch no-ops and is dropped when the winner's write adopts the id).
    const collidingRemoteId = remoteLiveByPath.get(localEntry.path);
    if (collidingRemoteId !== undefined && collidingRemoteId !== fileId) {
      const re = remote.fileEntries.get(collidingRemoteId)!;
      return resolveCreateCollision(localEntry, re, local, remote, /* selfIsRemote */ false);
    }
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
      if (content) return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId ?? undefined };
    }
    if (isUnchangedSinceAncestor(re)) {
      return { type: 'delete_remote', fileId, path: re.path };
    }
    // Content is hash-addressed: an unchanged-content rename's bytes are skipped
    // by fetchRemoteBlobs (we already hold them locally), so fall back to the
    // local store before declining.
    const content = remote.contentStore.get(re.contentHash) ?? local.contentStore.get(re.contentHash);
    if (!content) return { type: 'no_op', fileId }; // surviving bytes unavailable — defer, don't restore empty
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
    // Hash-addressed: fall back to the remote store in case the local copy was
    // GC'd but the same bytes are held remotely, before declining.
    const content = local.contentStore.get(le.contentHash) ?? remote.contentStore.get(le.contentHash);
    if (!content) return { type: 'no_op', fileId }; // surviving bytes unavailable — defer, don't restore empty
    return { type: 'delete_conflict', fileId, path: le.path, side: 'remote_deleted', content, parentHashes: [le.contentHash, re.contentHash] };
  }

  // ── Both modified (different content, neither deleted) ───────────────────
  // This is the three-way merge case
  return resolveContentConflict(fileId, le, re, local, remote, dag);
}

function resolveContentConflict(
  fileId: string,
  le: FileEntry,
  re: FileEntry,
  local: VaultState,
  remote: VaultState,
  dag: VersionDag | undefined,
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
      return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId ?? undefined };
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

  // ── Fast-forward over the op-id DAG (linear history, not a divergence) ──────
  // When one head is an ancestor of the other in the version DAG, the histories
  // are linear — one side edited straight from the other's version — so there is
  // no divergence to reconcile: adopt the descendant. This is what makes a
  // sequential empty↔content edit converge (`empty → "3" → empty`: id_3 is a clean
  // ancestor of id_empty2) instead of three-way-merging against a stale scalar
  // ancestor and unioning/duplicating the file. Identity is the op-id, so recurring
  // content never fools this (decisions §3). Both directions are handled:
  //   · remote descends from local → take the remote (adopt the peer's newer edit).
  //   · local descends from remote → keep ours (we already hold the newer version).
  // Safe under genuine concurrency: if the two truly diverged, neither head is an
  // ancestor of the other, so this never fires and the three-way path below runs.
  if (dag && le.headVersionId && re.headVersionId) {
    // Is local ACTUALLY at its head version? An edit made in the op-logger's
    // debounce window reaches disk but isn't yet an op, so no version-id names it —
    // `buildLocalState` re-hashes the disk bytes (correcting le.contentHash) but the
    // head stays at the last logged version. In that state local is really an
    // un-versioned CHILD of its head, so treating the head as representing local and
    // adopting a remote descendant of it would silently clobber the in-window edit.
    // Only fast-forward when local's content matches its head; otherwise fall through
    // to a three-way merge (against the head as base), which surfaces the conflict.
    const localAtHead = dag.contentHashOf(le.headVersionId) === le.contentHash;
    if (localAtHead && dag.isAncestor(le.headVersionId, re.headVersionId)) {
      // Remote is the strict descendant → adopt it. Hash-addressed: prefer the
      // remote store but fall back to the local one — fetchRemoteBlobs skips bytes
      // this device already holds (e.g. the empty blob an emptied file resolves to),
      // so they are absent from the *remote* store yet present locally.
      const content = remoteContent ?? local.contentStore.get(re.contentHash);
      if (content) {
        return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId ?? undefined };
      }
      // Descendant bytes unavailable anywhere — defer rather than fabricate/clobber (F1).
      return { type: 'no_op', fileId };
    }
    if (dag.isAncestor(re.headVersionId, le.headVersionId)) {
      // Local is the strict descendant — we already hold the newer version (plus any
      // in-window drift on top of it); the peer is behind and will fast-forward to
      // ours when it pulls. Nothing to do.
      return { type: 'no_op', fileId };
    }
  } else if (re.ancestorContentHash != null && re.ancestorContentHash === le.contentHash) {
    // Scalar fallback (no DAG — pure-VaultState unit tests): the remote's recorded
    // base equals our current content, so it is a strict descendant. Adopt it.
    const content = remoteContent ?? local.contentStore.get(re.contentHash);
    if (content) {
      return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId ?? undefined };
    }
    return { type: 'no_op', fileId };
  }

  if (!localContent || !remoteContent) {
    // Can't merge without content — defer to higher HLC.
    const winner = hlcCompare(le.hlcTimestamp, re.hlcTimestamp) >= 0 ? le : re;
    const winnerContent = winner === le ? localContent : remoteContent;
    if (!winnerContent) {
      // The winning side's bytes are unavailable (transient blob absence). We
      // must NOT fabricate an empty buffer and overwrite the local file with
      // zero bytes — that turns a transient availability issue into permanent
      // local destruction. Keep local bytes untouched and defer; the op is
      // retried once the content appears.
      return { type: 'no_op', fileId };
    }
    return { type: 'write_local', fileId, path: winner.path, content: winnerContent, hlc: winner.hlcTimestamp, headVersionId: winner.headVersionId ?? undefined };
  }

  const localText = new TextDecoder().decode(localContent);
  const remoteText = new TextDecoder().decode(remoteContent);

  // The three-way base: the LCA over the op-id DAG when available (the true causal
  // common ancestor), else the scalar ancestor. `ambiguous` means the DAG found
  // multiple incomparable bases (a criss-cross) — never guess one; surface a
  // conflict (decisions §6). A `null` baseHash means no common base at all.
  const { baseHash, ambiguous } = resolveThreeWayBase(le, re, dag);

  const wholeConflict = (): MergeAction => ({
    type: 'conflict',
    fileId,
    localPath: le.path,
    remotePath: re.path,
    mergeResult: wholeFileConflict(localText, remoteText),
    localContent: localText,
    remoteContent: remoteText,
    parentHashes: [le.contentHash, re.contentHash],
  });

  // Binary files can't be three-way merged. Deciding by "higher HLC wins" would
  // silently drop the losing side (data loss). Instead, take the sole edit when
  // only ONE side changed since the common ancestor — no conflict, no prompt —
  // and otherwise surface a `binary_conflict` for the user to resolve. Changed-
  // since-ancestor is a cheap *hash* comparison, so (unlike the text path) it
  // needs no ancestor bytes.
  if (isBinary(localContent) || isBinary(remoteContent)) {
    if (!ambiguous && baseHash != null) {
      const localChanged = le.contentHash !== baseHash;
      const remoteChanged = re.contentHash !== baseHash;
      // Only the remote side changed → adopt it cleanly.
      if (remoteChanged && !localChanged) {
        return { type: 'write_local', fileId, path: re.path, content: remoteContent, hlc: re.hlcTimestamp, headVersionId: re.headVersionId ?? undefined };
      }
      // Only the local side changed → keep ours; the local file already holds it.
      if (localChanged && !remoteChanged) {
        return { type: 'no_op', fileId };
      }
    }
    // Both sides diverged (or there is no single common base): a genuine conflict
    // the user must resolve. Never silently overwrite.
    return {
      type: 'binary_conflict',
      fileId,
      localPath: le.path,
      remotePath: re.path,
      localContent,
      remoteContent,
      localHlc: le.hlcTimestamp,
      remoteHlc: re.hlcTimestamp,
      parentHashes: [le.contentHash, re.contentHash],
    };
  }

  // Ambiguous DAG base (criss-cross): surface a conflict rather than pick a base.
  if (ambiguous) return wholeConflict();

  // Attempt three-way merge using the resolved base.
  const ancestorContent = baseHash != null
    ? (local.contentStore.get(baseHash) ?? remote.contentStore.get(baseHash))
    : undefined;

  // A *known-but-missing* base (a real hash was recorded but its bytes are held by
  // neither store — GC'd or never fetched to this device) is NOT a valid three-way
  // base. Falling back to an empty ancestor makes diff3 treat both full versions as
  // inserts at the same gap and silently *unions* them, duplicating the whole file.
  // Distinguish that from "no base recorded at all" (baseHash == null — genuinely no
  // common base): only the latter may fall back to an empty ancestor. When the base
  // is known but unavailable, surface a conflict so nothing is silently concatenated.
  if (baseHash != null && ancestorContent === undefined) {
    return wholeConflict();
  }

  const ancestorText = ancestorContent
    ? new TextDecoder().decode(ancestorContent)
    : '';  // Fall back to empty ancestor only when no ancestor was ever recorded

  const mergeResult = threeWayMerge(ancestorText, localText, remoteText);

  if (!mergeResult.hasConflicts) {
    // Clean merge — write result locally and send to remote
    const merged = mergeResult.merged.join('\n');
    const content = new TextEncoder().encode(merged);
    // Follow the rename: when the two sides disagree on the path — one side renamed
    // the file in the same round it edited it — the write must land at the winning
    // side's path, not blindly the local one. Using `le.path` wrote the new content
    // at the OLD path and silently dropped the rename (H5). Higher HLC wins,
    // consistent with the `hlcMax` stamped below and with `resolveRenameConflict`.
    // For the common no-rename case both paths are equal, so this is a no-op.
    const pathWinner = hlcCompare(le.hlcTimestamp, re.hlcTimestamp) >= 0 ? le : re;
    // Sync v2: when both heads are known (the DAG-backed path), this clean merge
    // synthesizes a NEW reconciled version, so record it as a real two-parent merge
    // NODE — otherwise the next edit off the merged file can't find its base in the
    // DAG and falls back to the scalar ancestor. The applicator mints the merge op
    // with a deterministic content-addressed id. Without both heads (pure-VaultState
    // unit tests, or a legacy entry with no head) fall back to a plain `write_local`
    // — behaviour-identical to before.
    if (le.headVersionId && re.headVersionId) {
      return {
        type: 'write_merge',
        fileId,
        path: pathWinner.path,
        content,
        parents: [le.headVersionId, re.headVersionId],
      };
    }
    return {
      type: 'write_local',
      fileId,
      path: pathWinner.path,
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

/**
 * F2 — reconcile a create/create path collision: `le` (a live *local* entry) and
 * `re` (a live *remote* entry) hold the SAME path under DIFFERENT ids because two
 * devices independently created the file. Called from BOTH single-sided branches
 * with the same `(le, re)` pair; `selfIsRemote` says which id this call is
 * processing (`re.id` when true, `le.id` when false). It returns a deterministic,
 * commutative decision so both devices converge to ONE id at the path:
 *
 *   · identical content  → same file. Adopt the deterministic winner's id (higher
 *     HLC, tie-break by lexicographic fileId); the loser's branch no-ops and its
 *     entry is dropped when the winner's `write_local` runs `adoptRemote`.
 *   · already-resolved   → if one side's entry `supersedes` the other's content
 *     (a peer already settled this exact collision), adopt that resolution's id
 *     and content cleanly, no re-prompt.
 *   · different content  → a genuine conflict. Only the WINNER's branch emits the
 *     `conflict` (keyed to the winning id); the loser's branch no-ops so exactly
 *     one prompt is raised. If either side's bytes are unavailable, defer with a
 *     `no_op` (F1: never clobber to fabricate a decision).
 *
 * The applicator's `write_local`/`conflict` cases both `adoptRemote(fileId, …)`,
 * so whichever id wins becomes the single id both devices key the path under.
 */
function resolveCreateCollision(
  le: FileEntry,
  re: FileEntry,
  local: VaultState,
  remote: VaultState,
  selfIsRemote: boolean,
): MergeAction {
  const selfId = selfIsRemote ? re.id : le.id;
  const noOp: MergeAction = { type: 'no_op', fileId: selfId };

  const localContent = local.contentStore.get(le.contentHash);
  const remoteContent = remote.contentStore.get(re.contentHash);

  // Emit the remote-id adoption (write remote bytes, converge id to re.id). Only
  // the remote-processing branch performs the write; the local branch defers so
  // its entry is dropped by the write's adoptRemote rather than double-acted.
  const adoptRemoteId = (): MergeAction => {
    if (!selfIsRemote) return noOp;
    const content = remoteContent ?? localContent; // identical-content: local holds it
    if (!content) return noOp; // bytes unavailable — defer (F1)
    return { type: 'write_local', fileId: re.id, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId ?? undefined };
  };

  // ── Identical content: the same file under two ids. Converge id, no conflict. ─
  if (le.contentHash === re.contentHash) {
    const winner = pickCollisionWinner(le, re);
    // Winner keeps its id: if it is the remote id, adopt it (dropping the local
    // duplicate); if it is the local id, keep it and let the remote-only branch
    // no-op. Either way the loser branch no-ops.
    return winner === re ? adoptRemoteId() : noOp;
  }

  // ── Already-resolved by a peer (supersedes names the other side's content). ──
  if (re.supersedes?.includes(le.contentHash)) {
    // Remote is a resolution superseding our content → adopt its id + content.
    return adoptRemoteId();
  }
  if (le.supersedes?.includes(re.contentHash)) {
    // Our content is the resolution superseding the remote side → keep local id,
    // drop the remote duplicate (its branch no-ops; ours keeps the file as-is).
    return noOp;
  }

  // ── Genuine create/create conflict (different, unrelated content). ──────────
  // Defer if either side's bytes are missing — never fabricate a decision (F1).
  if (!localContent || !remoteContent) return noOp;

  const winner = pickCollisionWinner(le, re);
  const self = selfIsRemote ? re : le;
  // Only the winner's branch raises the prompt so exactly one conflict surfaces;
  // the loser's branch no-ops (its id is dropped when the resolution is adopted).
  if (self !== winner) return noOp;

  const localText = new TextDecoder().decode(localContent);
  const remoteText = new TextDecoder().decode(remoteContent);
  return {
    type: 'conflict',
    fileId: winner.id,          // resolution converges identity to the winning id
    localPath: le.path,
    remotePath: re.path,
    mergeResult: wholeFileConflict(localText, remoteText),
    localContent: localText,
    remoteContent: remoteText,
    parentHashes: [le.contentHash, re.contentHash],
  };
}

/**
 * Deterministic, commutative winner of a create/create collision: higher HLC
 * wins; ties break by lexicographically greater fileId. Both devices compare the
 * same two entries and pick the same one regardless of argument order, so they
 * converge on one identity. Mirrors the `hlcCompare`-then-id tie-break used
 * elsewhere for last-writer-wins.
 */
function pickCollisionWinner(le: FileEntry, re: FileEntry): FileEntry {
  const cmp = hlcCompare(le.hlcTimestamp, re.hlcTimestamp);
  if (cmp > 0) return le;
  if (cmp < 0) return re;
  return le.id > re.id ? le : re;
}

/**
 * Resolve the three-way base for two divergent heads. Prefers the LCA over the
 * op-id version DAG (the true causal common ancestor over version-ids) when the
 * DAG and both heads are known; otherwise falls back to the scalar ancestor so
 * pure-`VaultState` unit tests (no DAG) behave as before.
 *
 * Returns `{ baseHash, ambiguous }`:
 *   · `ambiguous` — the DAG found multiple incomparable bases (a criss-cross); the
 *     caller must surface a conflict, never guess a base (decisions §6).
 *   · `baseHash === null` — no common base at all (may fall back to an empty
 *     ancestor, i.e. treat both as inserts) — but only when genuinely none exists.
 * A DAG that yields no common base (disconnected histories, e.g. a create/create
 * lineage) degrades to the scalar ancestor rather than forcing a decision.
 */
function resolveThreeWayBase(
  le: FileEntry,
  re: FileEntry,
  dag: VersionDag | undefined,
): { baseHash: string | null; ambiguous: boolean } {
  if (dag && le.headVersionId && re.headVersionId) {
    const mb = dag.mergeBase(le.headVersionId, re.headVersionId);
    if (mb === MULTIPLE_BASES) return { baseHash: null, ambiguous: true };
    if (mb !== null) return { baseHash: dag.contentHashOf(mb) ?? null, ambiguous: false };
    // mb === null: the two heads share no ancestor in the DAG (disconnected) — fall
    // through to the scalar ancestor so this rare case matches pre-DAG behaviour.
  }
  return { baseHash: le.ancestorContentHash ?? re.ancestorContentHash ?? null, ambiguous: false };
}

/**
 * Synthesize a whole-file conflict result for the case where no usable ancestor
 * exists (its bytes are unavailable), so the two versions cannot be reconciled
 * automatically. Mirrors the shape `threeWayMerge` produces for a genuine
 * conflict — `merged` carries the local lines as the placeholder and a single
 * `ConflictChunk` spans that region with an empty ancestor — so the conflict
 * modal/applicator consume it exactly like any other conflict.
 */
function wholeFileConflict(localText: string, remoteText: string): ThreeWayMergeResult {
  const localLines = splitLines(localText);
  const remoteLines = splitLines(remoteText);
  return {
    merged: localLines,
    conflicts: [{
      startLine: 0,
      endLine: localLines.length - 1,
      ancestor: [],
      local: localLines,
      remote: remoteLines,
    }],
    hasConflicts: true,
  };
}

/** Split text into lines the same way diff3 normalizes (CRLF/CR → LF). */
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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
