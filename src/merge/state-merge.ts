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
      return resolveCreateCollision(le, remoteEntry, local, remote, /* selfIsRemote */ true, dag);
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
      return resolveCreateCollision(localEntry, re, local, remote, /* selfIsRemote */ false, dag);
    }
    // A local-only live file classifies as `send_remote` from its entry alone — no
    // staged bytes are read (A2, §4.1). The push loop uploads the content from the
    // pending oplog + content store, not from this action; requiring staged bytes
    // here only served to flip `no_op`→`send_remote`, and forced every untouched
    // file's bytes into the snapshot. Dropping it is what lets an untouched file
    // need zero content staging.
    return {
      type: 'send_remote',
      fileId,
      path: localEntry.path,
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
    // Identical content does NOT imply causal convergence. Two devices can reach the
    // same bytes by *concurrent* edits (both empty a file, both type the same value):
    // that is two distinct heads off a common base, not one converged head. Stopping
    // at `no_op` here leaves BOTH heads open in the DAG; a later edit off one of them
    // then diverges from the orphaned other, and the LCA rolls back *past* the shared
    // value — resurrecting it as a spurious three-way conflict base (the concurrent
    // empty↔empty→edit bug). So when the DAG shows the heads genuinely diverged, unite
    // them with a merge node; when the histories are linear, converge the head pointer.
    // Identical heads (or no DAG / unknown heads) keep the cheap no_op fast path.
    if (dag && le.headVersionId && re.headVersionId && le.headVersionId !== re.headVersionId) {
      // Is local actually AT its head? An unlogged in-window edit (debounce race)
      // leaves the head stale while `buildLocalState` corrects `le.contentHash` from
      // disk; converging the head over that pending edit would mis-parent it. Only act
      // when local's content matches its head — otherwise defer (no_op) to next round.
      const localAtHead = dag.contentHashOf(le.headVersionId) === le.contentHash;
      // Local is the descendant (we already hold the newer head) → keep ours; the peer
      // fast-forwards to us when it pulls. Safe regardless of the in-window guard.
      if (dag.isAncestor(re.headVersionId, le.headVersionId)) {
        return { type: 'no_op', fileId };
      }
      if (localAtHead && dag.isAncestor(le.headVersionId, re.headVersionId)) {
        // Remote is the strict descendant — adopt its head so ours advances. Content is
        // identical, so this only moves the head pointer (idempotent re-write of bytes).
        const content = local.contentStore.get(le.contentHash) ?? remote.contentStore.get(re.contentHash);
        if (content) {
          return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId };
        }
      } else if (localAtHead) {
        // Genuine divergence with identical content → unite the two heads into a merge
        // node so the next edit descends from a single converged head. The id is the
        // deterministic content-address of (bytes, parents), so both devices mint the
        // identical node and fast-forward onto it — no merge storm (decisions §, §2).
        const content = local.contentStore.get(le.contentHash) ?? remote.contentStore.get(re.contentHash);
        if (content) {
          return { type: 'write_merge', fileId, path: le.path, content, parents: [le.headVersionId, re.headVersionId] };
        }
      }
      // Bytes unavailable, or local not at its head → fall through and defer.
    }
    return { type: 'no_op', fileId };
  }

  // ── One side deleted ─────────────────────────────────────────────────────
  // A *clean* one-sided delete: the surviving side has not touched the file
  // since the last common base (its content still matches the DAG LCA and it was
  // not renamed), so the deletion propagates without asking. If the surviving side
  // changed or renamed the file, it's a genuine delete/modify(-or-rename) conflict.
  // A two-parent merge node descending from our head is a *resolution* a peer
  // already settled — adopt it (structural replacement for the retired `supersedes`).
  if (le.deleted && !re.deleted) {
    // Remote holds a present file that is a restore *resolution* (merge node)
    // descending from our deletion → a peer settled this in favour of keeping the
    // file. Adopt it instead of re-prompting.
    if (dag && le.headVersionId && re.headVersionId
        && dag.isMergeNode(re.headVersionId) && dag.isAncestor(le.headVersionId, re.headVersionId)) {
      const content = remote.contentStore.get(re.contentHash) ?? local.contentStore.get(re.contentHash);
      if (content) return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId };
    }
    // Remote unchanged since the common base (same content, not renamed) → our
    // deletion propagates cleanly.
    if (isUnchangedSinceBase(re, le, dag)) {
      return { type: 'delete_remote', fileId, path: re.path };
    }
    // Content is hash-addressed: an unchanged-content rename's bytes are skipped
    // by fetchRemoteBlobs (we already hold them locally), so fall back to the
    // local store before declining.
    const content = remote.contentStore.get(re.contentHash) ?? local.contentStore.get(re.contentHash);
    if (!content) return { type: 'no_op', fileId }; // surviving bytes unavailable — defer, don't restore empty
    return { type: 'delete_conflict', fileId, path: re.path, side: 'local_deleted', content, parents: deleteParents(le, re) };
  }

  if (!le.deleted && re.deleted) {
    // Remote is a *keep-deleted* resolution (tombstone merge node) descending from
    // our present head → a peer settled this in favour of the deletion. Accept it
    // cleanly (the resolution already accounts for our head, so a local rename is
    // moot — it settled that too).
    if (dag && le.headVersionId && re.headVersionId
        && dag.isMergeNode(re.headVersionId) && dag.isAncestor(le.headVersionId, re.headVersionId)) {
      return { type: 'delete_local', fileId, path: le.path };
    }
    // Local unchanged since the common base (same content, not renamed) → the
    // remote's deletion propagates cleanly.
    if (isUnchangedSinceBase(le, re, dag)) {
      return { type: 'delete_local', fileId, path: le.path };
    }
    // Hash-addressed: fall back to the remote store in case the local copy was
    // GC'd but the same bytes are held remotely, before declining.
    const content = local.contentStore.get(le.contentHash) ?? remote.contentStore.get(le.contentHash);
    if (!content) return { type: 'no_op', fileId }; // surviving bytes unavailable — defer, don't restore empty
    return { type: 'delete_conflict', fileId, path: le.path, side: 'remote_deleted', content, parents: deleteParents(le, re) };
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
  // ── Already two-headed: a conflict was surfaced as inline markers (Step 5) ──
  // This file is awaiting local resolution — zdiff3 markers sit on disk and both
  // heads (`le.conflictParents`) stay open. Re-running the three-way merge here would
  // re-detect the conflict and write markers *over the markers*, nesting them every
  // round. So while two-headed we never re-conflict:
  //   · a peer already resolved (its head is a merge node descending from BOTH our
  //     open heads) → adopt that resolution, clearing our markers. Safe: markers are
  //     machine-generated working state, and `conflictParents` set ⇒ we haven't
  //     resolved locally (the resolving save clears it). The write_local path's F5
  //     drift guard still protects a resolution the user is mid-typing.
  //   · otherwise → hold: no_op, leave the markers for the user. The remote head is
  //     recorded in the DAG regardless, so nothing is lost.
  if (le.conflictParents && le.conflictParents.length >= 2) {
    if (dag && re.headVersionId
        && dag.isMergeNode(re.headVersionId)
        && le.conflictParents.every(h => dag.isAncestor(h, re.headVersionId!))) {
      const content = remote.contentStore.get(re.contentHash) ?? local.contentStore.get(re.contentHash);
      if (content) {
        return { type: 'write_local', fileId, path: re.path, content, hlc: re.hlcTimestamp, headVersionId: re.headVersionId };
      }
    }
    return { type: 'no_op', fileId };
  }

  // A user-resolved conflict is now a two-parent merge node in the DAG, so the
  // fast-forward below adopts it structurally (a peer holding either conflicting
  // head descends into the resolution) — no `supersedes` content-hash shortcut is
  // needed. Retrieve file content.
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
  const { baseHash, ambiguous, hasKnownAncestor } = resolveThreeWayBase(le, re, dag);

  // The two conflicting heads (sync v2): when both are known, the user's resolution
  // is re-emitted as a two-parent merge node with these parents, so peers holding
  // either head fast-forward onto it. Undefined without both heads (pure-VaultState
  // tests / legacy) ⇒ the applicator falls back to a `supersedes` resolution.
  const conflictParents = le.headVersionId && re.headVersionId
    ? [le.headVersionId, re.headVersionId]
    : undefined;

  const wholeConflict = (): MergeAction => ({
    type: 'conflict',
    fileId,
    localPath: le.path,
    remotePath: re.path,
    mergeResult: wholeFileConflict(localText, remoteText),
    localContent: localText,
    remoteContent: remoteText,
    parents: conflictParents,
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
      parents: conflictParents,
    };
  }

  // Ambiguous DAG base (criss-cross): surface a conflict rather than pick a base.
  if (ambiguous) return wholeConflict();

  // Attempt three-way merge using the resolved base.
  const ancestorContent = baseHash != null
    ? (local.contentStore.get(baseHash) ?? remote.contentStore.get(baseHash))
    : undefined;

  // A *known* ancestor — a real LCA id, whether its content hash is simply
  // unrecorded (a parent-only DAG stub, `baseHash === null` but
  // `hasKnownAncestor`) or its bytes are GC'd/never fetched for a recorded hash
  // (`baseHash` set but `ancestorContent` absent) — is NOT a valid "no base" case.
  // Falling back to an empty ancestor makes diff3 treat both full versions as
  // inserts at the same gap and silently *unions* them, duplicating the whole
  // file. Only a genuinely disconnected history (`hasKnownAncestor === false`) may
  // fall back to an empty ancestor. When a base is known to exist but its content
  // isn't available, surface a conflict so nothing is silently concatenated.
  if (hasKnownAncestor && ancestorContent === undefined) {
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

  // True conflict — needs user resolution. Carry the two conflicting heads so the
  // applicator re-emits the resolution as a two-parent merge node, letting peers
  // that still hold either side fast-forward onto it cleanly.
  return {
    type: 'conflict',
    fileId,
    localPath: le.path,
    remotePath: re.path,
    mergeResult,
    localContent: localText,
    remoteContent: remoteText,
    parents: conflictParents,
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
  dag: VersionDag | undefined,
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

  // ── Already-resolved by a peer (a two-parent merge node in the DAG). ─────────
  // If one head descends from the other, a peer already reconciled this exact
  // collision — fast-forward onto the resolution instead of re-prompting (the
  // structural replacement for the retired `supersedes` shortcut). Checked before
  // identical-content so a resolution is adopted by identity, not re-derived.
  if (dag && le.headVersionId && re.headVersionId) {
    // Remote descends from our head → it is the resolution; adopt its id + content.
    if (dag.isAncestor(le.headVersionId, re.headVersionId)) return adoptRemoteId();
    // Our head descends from remote's → we already hold the resolution; keep ours.
    if (dag.isAncestor(re.headVersionId, le.headVersionId)) return noOp;
  }

  // ── Identical content: the same file under two ids. Converge id, no conflict. ─
  if (le.contentHash === re.contentHash) {
    const winner = pickCollisionWinner(le, re);
    // Winner keeps its id: if it is the remote id, adopt it (dropping the local
    // duplicate); if it is the local id, keep it and let the remote-only branch
    // no-op. Either way the loser branch no-ops.
    return winner === re ? adoptRemoteId() : noOp;
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
    // The two colliding creates' heads → the resolution is a two-parent merge node
    // peers fast-forward onto. Both are freshly-created files, so both heads exist.
    parents: le.headVersionId && re.headVersionId ? [le.headVersionId, re.headVersionId] : undefined,
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
 * Returns `{ baseHash, ambiguous, hasKnownAncestor }`:
 *   · `ambiguous` — the DAG found multiple incomparable bases (a criss-cross); the
 *     caller must surface a conflict, never guess a base (decisions §6).
 *   · `hasKnownAncestor` — a real LCA id exists in the DAG, whether or not its
 *     content hash is recorded. `mergeBase` only needs to walk `parents` sets, so
 *     it can name a base the DAG knows only as a *parent-only stub* — referenced
 *     as someone's parent but never itself recorded via its own op (never pushed/
 *     pulled by this device, e.g. across a vaultId switch that left a stale local
 *     head). `contentHashOf` then returns `undefined` for that id, which must NOT
 *     collapse to "no common ancestor" (`baseHash === null` alone is ambiguous
 *     between the two) — a stub base is exactly as unsafe to treat as empty as a
 *     known-but-GC'd one (F1): both must degrade to a conflict, never an
 *     empty-ancestor union. Only `hasKnownAncestor === false` means genuinely no
 *     common ancestor exists, where an empty-ancestor fallback (both sides pure
 *     inserts) is safe.
 *   · `baseHash` — the base's content hash when known; `null` when either no base
 *     exists at all or a real base exists but its hash is unrecorded (check
 *     `hasKnownAncestor` to tell those apart).
 */
function resolveThreeWayBase(
  le: FileEntry,
  re: FileEntry,
  dag: VersionDag | undefined,
): { baseHash: string | null; ambiguous: boolean; hasKnownAncestor: boolean } {
  if (dag && le.headVersionId && re.headVersionId) {
    const mb = dag.mergeBase(le.headVersionId, re.headVersionId);
    if (mb === MULTIPLE_BASES) return { baseHash: null, ambiguous: true, hasKnownAncestor: false };
    if (mb !== null) {
      return { baseHash: dag.contentHashOf(mb) ?? null, ambiguous: false, hasKnownAncestor: true };
    }
    // mb === null: the two heads share no ancestor in the DAG (disconnected) — no
    // common base, so the caller falls back to an empty ancestor.
  }
  return { baseHash: null, ambiguous: false, hasKnownAncestor: false };
}

/** The two conflicting heads to carry on a delete/binary/content conflict action,
 *  so the applicator re-emits the resolution as a two-parent merge node peers
 *  fast-forward onto. Undefined when a head is unknown (pure-VaultState tests). */
function deleteParents(le: FileEntry, re: FileEntry): string[] | undefined {
  return le.headVersionId && re.headVersionId ? [le.headVersionId, re.headVersionId] : undefined;
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
 * Has the `survivor` been left untouched since the last common base — the signal
 * that the `other` side's deletion can be applied cleanly rather than surfaced as a
 * delete/modify(-or-rename) conflict? True only when the survivor was NOT renamed
 * since the last sync AND its content still equals the common base (the LCA over the
 * op-id DAG).
 *
 * Rename check: a rename since the last shared sync counts as "touched" (a
 * concurrent delete of a renamed file is a delete/rename conflict). The synced path
 * is recorded on whichever side still carries it — the local one; a projected remote
 * has `lastSyncedPath == null` — so compare the survivor's current path against
 * whichever side knows the synced path.
 *
 * Content check: over the DAG. No DAG, an unknown head, an ambiguous (criss-cross)
 * base, or a base whose content is unknown all read as "changed", so we err toward
 * asking rather than propagate a deletion over a possibly-edited file.
 */
function isUnchangedSinceBase(survivor: FileEntry, other: FileEntry, dag: VersionDag | undefined): boolean {
  const syncedPath = survivor.lastSyncedPath ?? other.lastSyncedPath ?? null;
  if (syncedPath != null && survivor.path !== syncedPath) return false; // renamed ⇒ touched
  if (!dag || !survivor.headVersionId || !other.headVersionId) return false;
  const base = dag.mergeBase(survivor.headVersionId, other.headVersionId);
  if (base === null || base === MULTIPLE_BASES) return false;
  const baseContent = dag.contentHashOf(base);
  return baseContent !== undefined && survivor.contentHash === baseContent;
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
