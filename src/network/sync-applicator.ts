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
import { renderMarkersFromResult } from '../merge/diff3';
import { HybridLogicalClock } from '../core/hlc';

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

export type DeleteConflictHandler = (action: Extract<MergeAction, { type: 'delete_conflict' }>) => Promise<'keep_deleted' | 'keep_modified' | DeferConflict>;
export type BinaryConflictHandler = (action: Extract<MergeAction, { type: 'binary_conflict' }>) => Promise<'keep_local' | 'keep_remote' | DeferConflict>;

/** A clean merge or user-resolved conflict that must be re-emitted as an op so it
 *  replicates (sync v2). Every one is a two-parent MERGE NODE: `parents` are the two
 *  reconciled version-ids and `id` is the precomputed deterministic merge id (the
 *  applicator hashed the merged bytes to derive it). `deleted` picks the op type —
 *  a tombstone merge node (keep-deleted resolution) when true, an `update` merge
 *  node (content/restore/binary resolution, clean merge) otherwise — so a peer
 *  holding either conflicting head fast-forwards onto the decision. */
interface PendingResolution {
  fileId: string;
  path: string;
  contentHash: string;
  hlc: HLC;
  parents: string[];
  id: string;
  deleted?: boolean;
}

export class SyncApplicator {
  constructor(
    private files: VaultFiles,
    private registry: FileRegistry,
    private contentStore: ContentStore,
    private opLogger: OperationLogger,
    private hlc: HybridLogicalClock,
    public onDeleteConflict: DeleteConflictHandler,
    public onBinaryConflict: BinaryConflictHandler,
  ) {}

  /**
   * Apply the round's merge actions to the vault. Returns two sets of fileIds:
   *  · `deferred` — a destructive action was *skipped* because the file drifted on
   *    disk since the snapshot (F5) or an auto-round deferred a conflict (S5); the
   *    caller holds the cursor so those remote ops re-pull and re-merge next round.
   *  · `deferredConflicts` — the subset of `deferred` that is an auto-deferred
   *    delete/binary *conflict* (needs a manual sync to resolve), as opposed to F5
   *    drift (which retries automatically). The plugin tags these `reason:'conflict'`
   *    in the observable state so the badge/status reflects them — the derived
   *    replacement for the old hand-maintained outstanding-conflict set (Step 7).
   */
  async applyActions(
    actions: MergeAction[],
    localState: VaultState,
    remoteState: VaultState,
  ): Promise<{ deferred: Set<string>; deferredConflicts: Set<string> }> {
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
    // The subset of `deferred` that is an auto-deferred delete/binary conflict
    // (not F5 drift) — surfaced with reason 'conflict' by the plugin (Step 7).
    const deferredConflicts = new Set<string>();

    try {
      for (const action of actions) {
        const resolved = await this.applyAction(action, localState, remoteState, deferred, deferredConflicts);
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

    // Advance each synced file's last-synced path (but never for a deferred one:
    // its destructive action was skipped, so its synced state must stay the
    // pre-round base for next round's merge).
    await this.updateSyncedPaths(actions, localState, deferred);

    // Persist the resolution ops now that the already-pushed pending log is
    // clear — they become pending for the next round and replicate the manual
    // resolution to peers as two-parent merge nodes. The registry was already
    // updated to the resolved hash during apply, so the resumed modify listener
    // suppresses the echo. `deleted` picks the tombstone vs update merge variant.
    for (const r of resolutions) {
      if (r.deleted) {
        await this.opLogger.recordMergeDelete(r.fileId, r.path, r.contentHash, r.hlc, r.parents, r.id);
      } else {
        await this.opLogger.recordMergeOp(r.fileId, r.path, r.contentHash, r.hlc, r.parents, r.id);
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

    return { deferred, deferredConflicts };
  }

  private async applyAction(
    action: MergeAction,
    local: VaultState,
    remote: VaultState,
    deferred: Set<string>,
    deferredConflicts: Set<string>,
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
        // Re-emit the merge node as a pending op (after clearOps) so it replicates.
        return { fileId: action.fileId, path: action.path, contentHash: hash, hlc: hlcTs, parents: action.parents, id };
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
        return null;

      case 'conflict': {
        // Sync v2 Step 5: a text conflict is surfaced NON-BLOCKINGLY as inline
        // zdiff3 markers at the real path — no modal, no cursor hold. Both heads stay
        // open (the file becomes *two-headed*); the next ordinary save that removes
        // the markers becomes a two-parent merge node (parents = the two heads at
        // conflict time), which peers fast-forward onto. See operation-logger's
        // `flushModify` two-headed branch and state-merge's `resolveContentConflict`.
        //
        // Guard the same F5 drift the destructive actions do: if the file changed on
        // disk during the sync window, don't overwrite that edit with markers — defer,
        // hold the cursor, and re-merge next round against the re-captured edit.
        const localEntry = local.fileEntries.get(action.fileId);
        const currentPath = localEntry && !localEntry.deleted ? localEntry.path : action.localPath;
        if (await this.driftedSinceSnapshot(action.fileId, currentPath, local)) {
          deferred.add(action.fileId);
          console.warn(`Vault Sync: deferring conflict markers for ${currentPath} — on-disk content changed during the sync window (F5)`);
          return null;
        }
        const marked = new TextEncoder().encode(renderMarkersFromResult(action.mergeResult));
        const hash = await hashContent(marked);
        await this.files.write(action.localPath, marked);
        await this.contentStore.put(hash, marked);
        // Record the file two-headed: the markers' hash + the two conflicting heads,
        // so the resolving save re-emits `parents: [A, B]`. The file is now a derived
        // two-headed conflict (Step 7) — the panel/badge pick it up from the registry;
        // it is NOT deferred (the markers were written, the cursor advances).
        await this.registry.markConflicted(action.localPath, hash, this.hlc.now(), action.parents ?? []);
        return null;
      }

      case 'delete_conflict': {
        const decision = await this.onDeleteConflict(action);
        // Auto-sync deferral (S5): apply nothing, hold the cursor for next round, and
        // tag it a conflict so the plugin surfaces it (reason 'conflict') as needing a
        // manual sync — the derived replacement for the old outstanding badge (Step 7).
        if (decision === DEFER_CONFLICT) { deferred.add(action.fileId); deferredConflicts.add(action.fileId); return null; }
        // A real decision (keep_modified or keep_deleted) settles the conflict below.
        // Timestamp the decision *now* so it dominates the delete/edit it reconciles
        // (runSync already advanced the clock past the merged HLC). It is re-emitted
        // as a two-parent merge node so a peer holding either side fast-forwards
        // onto the decision instead of independently re-prompting.
        const hlcTs = this.hlc.now();
        const hash = await hashContent(action.content);
        if (decision === 'keep_modified') {
          // state-merge already declined (no_op) to raise a delete_conflict whose
          // surviving bytes are missing (F1), so `action.content` is real — an
          // empty payload is a genuinely-empty file to restore, not a truncation.
          // Keep the file: re-assert its presence (undeleting our own copy if we
          // were the deleting side) as an `update` merge node.
          await this.files.write(action.path, action.content);
          await this.contentStore.put(hash, action.content);
          return this.mintMergeResolution(action.fileId, action.path, hash, hlcTs, action.parents);
        }
        // 'keep_deleted' — accept the deletion: remove our copy (if present) and
        // tombstone, then replicate the delete as a *tombstone* merge node so the
        // modified side converges.
        await this.files.trash(action.path);
        await this.registry.markDeleted(action.path, hlcTs);
        return this.mintMergeResolution(action.fileId, action.path, hash, hlcTs, action.parents, /* deleted */ true);
      }

      case 'binary_conflict': {
        // Binary files can't be merged; the user picked which whole version to
        // keep. Write it, converge identity, and re-emit it as a two-parent merge
        // node — exactly like `delete_conflict`, so a peer still holding either side
        // fast-forwards onto the decision instead of re-prompting.
        const decision = await this.onBinaryConflict(action);
        // Auto-sync deferral (S5): apply nothing, hold the cursor, tag it a conflict
        // (reason 'conflict') so the plugin surfaces it as needing a manual sync (Step 7).
        if (decision === DEFER_CONFLICT) { deferred.add(action.fileId); deferredConflicts.add(action.fileId); return null; }
        const keepLocal = decision === 'keep_local';
        const content = keepLocal ? action.localContent : action.remoteContent;
        const path = keepLocal ? action.localPath : action.remotePath;
        // Timestamp *now* so the decision dominates the version it reconciles
        // (runSync already advanced the clock past the merged HLC).
        const hlcTs = this.hlc.now();
        const hash = await hashContent(content);
        // The chosen side's bytes are carried in the action (never fabricated), so
        // an empty payload is a legitimately-empty version to keep, not a truncation.
        await this.files.write(path, content);
        await this.contentStore.put(hash, content);
        return this.mintMergeResolution(action.fileId, path, hash, hlcTs, action.parents);
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

  /**
   * Mint a two-parent merge node for a clean merge or user resolution (sync v2):
   * derive its deterministic content-addressed id from the resolved bytes + parents,
   * adopt the file's identity + head onto it (skipped for a tombstone, which the
   * caller has already trashed + markDeleted), and return the PendingResolution the
   * caller re-emits as a replicating op after `clearOps`. Two devices that resolve
   * to the same bytes compute the same id and dedup on push.
   */
  private async mintMergeResolution(
    fileId: string, path: string, contentHash: string, hlc: HLC, parents: string[] | undefined, deleted = false,
  ): Promise<PendingResolution> {
    const p = parents ?? [];
    const id = await mergeVersionId(contentHash, p);
    // A live resolution adopts the merge node as the file's identity + head; a
    // tombstone has no live entry to adopt (recordMergeDelete sets its head).
    if (!deleted) {
      await this.registry.adoptRemote(fileId, path, contentHash, hlc, id);
    }
    return { fileId, path, contentHash, hlc, parents: p, id, deleted };
  }

  /**
   * After a round, record each in-sync file's current path as its last-synced path
   * (sync v2). A `write_local`/`write_merge`/resolution already did this via
   * `adoptRemote`; this handles the non-writing outcomes:
   *   · `no_op` — the file is already in sync at its current path.
   *   · `send_remote` — we pushed our copy, so it is now synced at its path; but only
   *     on the FIRST sync (no last-synced path yet). A later push is not a peer
   *     acknowledgement, so advancing the synced path there could mask a concurrent
   *     rename — mirrors the send_remote data-loss rule the old ancestor policy held.
   * Never for a deferred file (its destructive action was skipped) or a deleted one.
   */
  private async updateSyncedPaths(
    actions: MergeAction[],
    local: VaultState,
    deferred: Set<string>,
  ): Promise<void> {
    for (const action of actions) {
      if (deferred.has(action.fileId)) continue;
      if (action.type !== 'no_op' && action.type !== 'send_remote') continue;
      const entry = local.fileEntries.get(action.fileId);
      if (!entry || entry.deleted) continue;
      const isFirstSync = entry.lastSyncedPath == null;
      if (action.type === 'no_op' || isFirstSync) {
        await this.registry.setSyncedPath(action.fileId);
      }
    }
  }
}
