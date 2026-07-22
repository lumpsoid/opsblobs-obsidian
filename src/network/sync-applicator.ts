// ─────────────────────────────────────────────
//  Sync Applicator
//  Applies merge actions to the actual vault
// ─────────────────────────────────────────────

import { HLC, MergeAction, VaultState } from '../types';
import { VaultFiles } from '../ports/vault-files';
import { FileRegistry } from '../core/file-registry';
import { ContentStore, hashContent } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { mergeVersionId } from '../core/operations';
import { HybridLogicalClock } from '../core/hlc';
import { nextAncestorHash } from '../merge/ancestor-policy';

/**
 * A conflict handler may return this instead of a decision to *defer* the
 * conflict (S5): the applicator applies nothing, adds the fileId to the deferred
 * set, and the round holds its cursor (exactly like an F5 drift) so the conflict
 * re-presents next round rather than being consumed. Unattended auto-sync uses
 * this — it must never open a blocking modal nor silently skip: it records the
 * conflict as outstanding and leaves the actual decision to the next manual sync.
 */
export const DEFER_CONFLICT = Symbol('defer-conflict');
export type DeferConflict = typeof DEFER_CONFLICT;

export type ConflictHandler = (action: Extract<MergeAction, { type: 'conflict' }>) => Promise<Uint8Array | null | DeferConflict>;
export type DeleteConflictHandler = (action: Extract<MergeAction, { type: 'delete_conflict' }>) => Promise<'keep_deleted' | 'restore' | DeferConflict>;
export type BinaryConflictHandler = (action: Extract<MergeAction, { type: 'binary_conflict' }>) => Promise<'keep_local' | 'keep_remote' | DeferConflict>;

/** A user-resolved conflict that must be re-emitted as an op so it replicates.
 *  `kind` is the op it becomes: an `update` (content conflict, or a delete
 *  conflict resolved by restoring the file) or a `delete` (delete conflict
 *  resolved by accepting the deletion). `supersedes` names the sides it settles
 *  so peers holding either adopt the decision instead of re-prompting. */
interface PendingResolution {
  kind: 'update' | 'delete' | 'merge';
  fileId: string;
  path: string;
  contentHash: string;
  hlc: HLC;
  // update/delete resolutions: the two conflicting sides the decision settles.
  supersedes?: string[];
  // merge nodes (sync v2): the two reconciled version-ids and the precomputed
  // deterministic merge id (the applicator hashed the merged bytes to derive it).
  parents?: string[];
  id?: string;
}

export class SyncApplicator {
  constructor(
    private files: VaultFiles,
    private registry: FileRegistry,
    private contentStore: ContentStore,
    private opLogger: OperationLogger,
    private hlc: HybridLogicalClock,
    public onConflict: ConflictHandler,
    public onDeleteConflict: DeleteConflictHandler,
    public onBinaryConflict: BinaryConflictHandler,
  ) {}

  /**
   * Apply the round's merge actions to the vault. Returns two sets of fileIds:
   *  · `deferred` — a destructive action was *skipped* because the file drifted on
   *    disk since the snapshot (F5) or an auto-round deferred a conflict (S5); the
   *    caller holds the cursor so those remote ops re-pull and re-merge next round.
   *  · `converged` — a genuinely-converging local action was applied (write/move/
   *    delete, or a resolved conflict), so the file is now in sync. The plugin uses
   *    this to clear a stale "outstanding conflict" badge for a file that later
   *    resolved automatically (e.g. adopting a peer's `supersedes` resolution via a
   *    clean `write_local`, which never re-enters the conflict handler).
   */
  async applyActions(
    actions: MergeAction[],
    localState: VaultState,
    remoteState: VaultState,
  ): Promise<{ deferred: Set<string>; converged: Set<string> }> {
    // Pause op logging while we apply sync changes (we don't want to re-log them)
    this.opLogger.stopListening();

    // User-resolved conflicts are re-emitted as ops (below) so peers learn the
    // resolution instead of diverging. Collected here and recorded only *after*
    // clearOps, which would otherwise wipe them.
    const resolutions: PendingResolution[] = [];
    // Files whose on-disk bytes changed inside the sync window (F5): their
    // destructive action was skipped to keep the user's edit; recorded so we can
    // re-capture the edit as an op and hold the cursor for the skipped remote op.
    const deferred = new Set<string>();
    // Files a converging action actually settled this round (see the doc above).
    const converged = new Set<string>();

    try {
      for (const action of actions) {
        const resolved = await this.applyAction(action, localState, remoteState, deferred, converged);
        if (resolved) resolutions.push(resolved);
      }
    } finally {
      // Clear pending ops before resuming listeners so that vault events
      // fired asynchronously by our writes (modify/create/delete) don't get
      // re-logged as new pending changes after clearOps returns.
      await this.opLogger.clearOps();
      // Yield to the event loop so Obsidian's async vault events from the
      // writes above are dispatched and silently dropped (listeners are still
      // off at this point), then re-attach.
      await new Promise(resolve => setTimeout(resolve, 0));
      this.opLogger.startListening();
    }

    // Update ancestor hashes for all synced files (but never for a deferred one:
    // its destructive action was skipped, so advancing its ancestor to the
    // remote content we didn't write would corrupt the next three-way merge).
    await this.updateAncestorHashes(actions, localState, remoteState, deferred);

    // Persist the resolution ops now that the already-pushed pending log is
    // clear — they become pending for the next round and replicate the manual
    // resolution to peers. The registry was already updated to the resolved
    // hash during apply, so the resumed modify listener suppresses the echo.
    for (const r of resolutions) {
      if (r.kind === 'merge') {
        await this.opLogger.recordMergeOp(r.fileId, r.path, r.contentHash, r.hlc, r.parents!, r.id!);
      } else if (r.kind === 'delete') {
        await this.opLogger.recordResolvedDelete(r.fileId, r.path, r.contentHash, r.hlc, r.supersedes!);
      } else {
        await this.opLogger.recordResolvedUpdate(r.fileId, r.path, r.contentHash, r.hlc, r.supersedes!);
      }
    }

    // Re-capture each in-window edit we declined to overwrite as a durable
    // pending op (F5), so next round it is a proper three-way merge / conflict
    // against the remote change rather than a silently lost edit. Mirrors the
    // resolution re-emit above: done after clearOps + startListening.
    for (const fileId of deferred) {
      const entry = localState.fileEntries.get(fileId);
      if (entry) await this.opLogger.recaptureLocalEdit(entry.path);
    }

    return { deferred, converged };
  }

  private async applyAction(
    action: MergeAction,
    local: VaultState,
    remote: VaultState,
    deferred: Set<string>,
    converged: Set<string>,
  ): Promise<PendingResolution | null> {
    switch (action.type) {
      case 'write_local': {
        // Where this file currently lives on THIS device. It differs from
        // `action.path` only when the winning side renamed the file in the same
        // round it edited it (H5): the write lands at the new path and the stale
        // copy at `currentPath` is trashed below. Drift/truncation are judged at
        // `currentPath` (where our bytes actually are), not the incoming new path.
        const localEntry = local.fileEntries.get(action.fileId);
        const currentPath = localEntry && !localEntry.deleted ? localEntry.path : action.path;

        if (await this.driftedSinceSnapshot(action.fileId, currentPath, local)) {
          deferred.add(action.fileId);
          console.warn(`Vault Sync: deferring write_local for ${currentPath} — on-disk content changed during the sync window (F5)`);
          return null;
        }
        const hash = await hashContent(action.content);
        // A zero-byte payload here is a LEGITIMATE empty edit: state-merge returns
        // no_op whenever a winner's bytes are actually missing (F1), so it never
        // emits a fabricated empty write. Writing empty is therefore the correct
        // propagation of a user emptying a file — not a truncation to refuse (G13).
        await this.files.write(action.path, action.content);
        await this.contentStore.put(hash, action.content);
        // Adopt the remote file's identity (its UUID) so both devices track this
        // path under ONE id. The merge is id-keyed; without this each device
        // keeps its own id for the same path and their edits never reconcile —
        // permanent divergence with no conflict ever raised. This also keeps the
        // registry consistent so a vault event fired for our own write is
        // suppressed by flushModify's hash-equality guard, and (by registering
        // the id before the create event fires) stops that event from minting a
        // fresh duplicate id for the same path.
        await this.registry.adoptRemote(action.fileId, action.path, hash, action.hlc, action.headVersionId);
        // The file was renamed as part of this merge (H5): remove the now-stale
        // copy at its previous path so the rename isn't left as a duplicate. Guarded
        // on inequality (the common no-rename write never trashes) and tolerant of
        // an already-absent old file.
        if (currentPath !== action.path) {
          await this.files.trash(currentPath);
        }
        converged.add(action.fileId);
        return null;
      }

      case 'write_merge': {
        // A clean three-way merge synthesizes a NEW reconciled version (sync v2).
        // Same drift/rename handling as `write_local`, but instead of adopting an
        // existing remote op we mint a two-parent merge node: a deterministic,
        // content-addressed id so two devices merging the same pair produce the
        // identical op (dedup on push), recorded as a pending op (pushed next round)
        // and set as the file's head so the next local edit descends from it.
        const localEntry = local.fileEntries.get(action.fileId);
        const currentPath = localEntry && !localEntry.deleted ? localEntry.path : action.path;

        if (await this.driftedSinceSnapshot(action.fileId, currentPath, local)) {
          deferred.add(action.fileId);
          console.warn(`Vault Sync: deferring write_merge for ${currentPath} — on-disk content changed during the sync window (F5)`);
          return null;
        }
        const hash = await hashContent(action.content);
        const id = await mergeVersionId(hash, action.parents);
        // Timestamp *now* so the merge dominates both reconciled sides (runSync
        // already advanced the clock past the merged HLC), matching the conflict-
        // resolution path. The id is content-addressed, so it stays deterministic
        // across devices regardless of this per-device timestamp.
        const hlcTs = this.hlc.now();
        await this.files.write(action.path, action.content);
        await this.contentStore.put(hash, action.content);
        // Adopt identity and set the head to the merge node explicitly (its id is
        // NOT hlcToString(hlc), so adoptRemote can't derive it).
        await this.registry.adoptRemote(action.fileId, action.path, hash, hlcTs, id);
        if (currentPath !== action.path) {
          await this.files.trash(currentPath);
        }
        converged.add(action.fileId);
        // Re-emit the merge node as a pending op (after clearOps) so it replicates.
        return { kind: 'merge', fileId: action.fileId, path: action.path, contentHash: hash, hlc: hlcTs, parents: action.parents, id };
      }

      case 'move_local':
        if (await this.driftedSinceSnapshot(action.fileId, action.fromPath, local)) {
          deferred.add(action.fileId);
          console.warn(`Vault Sync: deferring move_local for ${action.fromPath} — on-disk content changed during the sync window (F5)`);
          return null;
        }
        await this.files.move(action.fromPath, action.toPath);
        // Track the move in the registry too. Every other applied action updates
        // both the vault and the registry directly (write_local→adoptRemote,
        // delete_local→markDeleted); move_local must as well. It can't lean on a
        // vault rename event to do it — listeners are paused for the whole apply,
        // so the event the move fires is dropped. Without this the registry path
        // stays stale after a synced rename, and the next reconcile reads it as a
        // delete of the old path + a create of the new one, losing file identity.
        await this.registry.updatePath(action.fromPath, action.toPath, this.hlc.now());
        converged.add(action.fileId);
        return null;

      case 'delete_local':
        if (await this.driftedSinceSnapshot(action.fileId, action.path, local)) {
          deferred.add(action.fileId);
          console.warn(`Vault Sync: deferring delete_local for ${action.path} — on-disk content changed during the sync window (F5)`);
          return null;
        }
        await this.files.trash(action.path);
        // Tombstone in the registry so the propagated delete survives restarts
        // and isn't re-detected as a local creation on the next reconcile.
        await this.registry.markDeleted(action.path, this.hlc.now());
        converged.add(action.fileId);
        return null;

      case 'conflict': {
        const resolved = await this.onConflict(action);
        // Auto-sync deferral (S5): apply nothing, hold the cursor. Checked before
        // the null/skip branch because the sentinel is a truthy symbol.
        if (resolved === DEFER_CONFLICT) { deferred.add(action.fileId); return null; }
        if (!resolved) return null;
        // The resolution is a fresh decision the CRDT replay can't reproduce, so
        // it must become its own op. Timestamp it *now*: runSync has already
        // advanced the clock past the merged HLC, so this dominates the remote
        // content it supersedes and wins last-writer-wins on peers.
        const hlcTs = this.hlc.now();
        const hash = await hashContent(resolved);
        await this.files.write(action.localPath, resolved);
        await this.contentStore.put(hash, resolved);
        converged.add(action.fileId);
        // Sync v2: when the two conflicting heads are known, re-emit the resolution
        // as a two-parent MERGE NODE — a peer holding either head fast-forwards onto
        // it (its parents ARE those heads) instead of re-conflicting, the structural
        // replacement for the `supersedes` shortcut. The merge id is content-
        // addressed, so two devices that resolve to the same bytes dedup; two that
        // resolve differently keep distinct heads and correctly re-surface.
        if (action.parents && action.parents.length === 2) {
          const id = await mergeVersionId(hash, action.parents);
          await this.registry.adoptRemote(action.fileId, action.localPath, hash, hlcTs, id);
          return { kind: 'merge', fileId: action.fileId, path: action.localPath, contentHash: hash, hlc: hlcTs, parents: action.parents, id };
        }
        // Fallback (create/create collision, or no heads): a `supersedes`-tagged
        // resolution op. `adoptRemote` also drops any *different* live id already at
        // this path so both devices settle on ONE id (F2); for an ordinary conflict
        // the fileId already matches, reducing to update-content + set-ancestor.
        await this.registry.adoptRemote(action.fileId, action.localPath, hash, hlcTs);
        return { kind: 'update', fileId: action.fileId, path: action.localPath, contentHash: hash, hlc: hlcTs, supersedes: action.parentHashes };
      }

      case 'delete_conflict': {
        const decision = await this.onDeleteConflict(action);
        // Auto-sync deferral (S5): apply nothing, hold the cursor for next round.
        if (decision === DEFER_CONFLICT) { deferred.add(action.fileId); return null; }
        // A real decision (restore or keep_deleted) settles the conflict below.
        converged.add(action.fileId);
        // Timestamp the decision *now* so it dominates the delete/edit it
        // supersedes (runSync already advanced the clock past the merged HLC),
        // and tag it with both sides so a peer still holding either adopts the
        // decision instead of independently re-prompting.
        const hlcTs = this.hlc.now();
        const hash = await hashContent(action.content);
        if (decision === 'restore') {
          // state-merge already declined (no_op) to raise a delete_conflict whose
          // surviving bytes are missing (F1), so `action.content` is real — an
          // empty payload is a genuinely-empty file to restore, not a truncation.
          // Keep the file. Re-assert its presence (undeleting our own copy if we
          // were the deleting side) and make the restored content the new ancestor.
          await this.files.write(action.path, action.content);
          await this.contentStore.put(hash, action.content);
          await this.registry.adoptRemote(action.fileId, action.path, hash, hlcTs);
          return { kind: 'update', fileId: action.fileId, path: action.path, contentHash: hash, hlc: hlcTs, supersedes: action.parentHashes };
        }
        // 'keep_deleted' — accept the deletion: remove our copy (if present) and
        // tombstone, then replicate the delete so the modified side converges.
        await this.files.trash(action.path);
        await this.registry.markDeleted(action.path, hlcTs);
        return { kind: 'delete', fileId: action.fileId, path: action.path, contentHash: hash, hlc: hlcTs, supersedes: action.parentHashes };
      }

      case 'binary_conflict': {
        // Binary files can't be merged; the user picked which whole version to
        // keep. Write it, converge identity, and re-emit it as a resolution op —
        // exactly like `delete_conflict`, so a peer still holding either side
        // adopts the decision via `supersedes` instead of re-prompting.
        const decision = await this.onBinaryConflict(action);
        // Auto-sync deferral (S5): apply nothing, hold the cursor for next round.
        if (decision === DEFER_CONFLICT) { deferred.add(action.fileId); return null; }
        converged.add(action.fileId);
        const keepLocal = decision === 'keep_local';
        const content = keepLocal ? action.localContent : action.remoteContent;
        const path = keepLocal ? action.localPath : action.remotePath;
        // Timestamp *now* so the decision dominates the version it supersedes
        // (runSync already advanced the clock past the merged HLC).
        const hlcTs = this.hlc.now();
        const hash = await hashContent(content);
        // The chosen side's bytes are carried in the action (never fabricated), so
        // an empty payload is a legitimately-empty version to keep, not a truncation.
        await this.files.write(path, content);
        await this.contentStore.put(hash, content);
        await this.registry.adoptRemote(action.fileId, path, hash, hlcTs);
        return { kind: 'update', fileId: action.fileId, path, contentHash: hash, hlc: hlcTs, supersedes: action.parentHashes };
      }

      case 'send_remote':
      case 'delete_remote':
      case 'no_op':
        // These are handled by the transport layer, not the applicator
        return null;
    }
  }

  /**
   * F5 drift guard: has this file's on-disk content changed since
   * `buildLocalState` snapshotted it? An edit that landed inside the
   * snapshot→network→apply window is on disk but not yet a durable op, and a
   * destructive merge action (`write_local`/`move_local` source/`delete_local`)
   * would overwrite it. Compare the live bytes at `path` against the snapshot
   * hash the local state recorded for `fileId` (which `buildLocalState` set to
   * the actual disk hash at snapshot time). No snapshot (a brand-new remote-only
   * file) or a vanished file ⇒ no in-window local edit to protect. On any read
   * we keep the safe side: only a confirmed hash mismatch defers.
   */
  private async driftedSinceSnapshot(fileId: string, path: string, local: VaultState): Promise<boolean> {
    const snapshotHash = local.fileEntries.get(fileId)?.contentHash;
    if (snapshotHash === undefined) return false;
    const current = await this.files.read(path);
    if (current === null) return false;
    return (await hashContent(current)) !== snapshotHash;
  }

  private async updateAncestorHashes(
    actions: MergeAction[],
    local: VaultState,
    remote: VaultState,
    deferred: Set<string>,
  ): Promise<void> {
    // The advance *decision* (first-sync / action-type branching, and the
    // send_remote-only-on-first-sync rule whose violation caused the reported
    // data loss) lives in the pure `nextAncestorHash` domain policy. The shell
    // only performs effects: `write_local` must hash freshly written bytes
    // (async I/O the policy can't do), so its branch stays here; everything else
    // asks the policy for the hash to set.
    for (const action of actions) {
      // A deferred file's destructive action was skipped (F5): its ancestor must
      // stay the pre-round base so next round's three-way merge is correct.
      if (deferred.has(action.fileId)) continue;
      if (action.type === 'write_local' || action.type === 'write_merge') {
        // Both write freshly-produced bytes to disk (a merge synthesizes them), so
        // the just-written content becomes the synced ancestor. Hashing is async
        // I/O the pure policy can't do, so this branch stays in the shell.
        const hash = await hashContent(action.content);
        await this.registry.setAncestorHash(action.fileId, hash);
      } else {
        const next = nextAncestorHash(action, local.fileEntries.get(action.fileId));
        if (next !== null) {
          await this.registry.setAncestorHash(action.fileId, next);
        }
      }
    }
  }
}
