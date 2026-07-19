// ─────────────────────────────────────────────
//  Sync Applicator
//  Applies merge actions to the actual vault
// ─────────────────────────────────────────────

import { HLC, MergeAction, VaultState } from '../types';
import { VaultFiles } from '../ports/vault-files';
import { FileRegistry } from '../core/file-registry';
import { ContentStore, hashContent } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { HybridLogicalClock } from '../core/hlc';
import { nextAncestorHash } from '../merge/ancestor-policy';

export type ConflictHandler = (action: Extract<MergeAction, { type: 'conflict' }>) => Promise<Uint8Array | null>;
export type DeleteConflictHandler = (action: Extract<MergeAction, { type: 'delete_conflict' }>) => Promise<'keep_deleted' | 'restore'>;

/** A user-resolved conflict that must be re-emitted as an op so it replicates.
 *  `kind` is the op it becomes: an `update` (content conflict, or a delete
 *  conflict resolved by restoring the file) or a `delete` (delete conflict
 *  resolved by accepting the deletion). `supersedes` names the sides it settles
 *  so peers holding either adopt the decision instead of re-prompting. */
interface PendingResolution {
  kind: 'update' | 'delete';
  fileId: string;
  path: string;
  contentHash: string;
  hlc: HLC;
  supersedes: string[];
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
  ) {}

  async applyActions(
    actions: MergeAction[],
    localState: VaultState,
    remoteState: VaultState,
  ): Promise<void> {
    // Pause op logging while we apply sync changes (we don't want to re-log them)
    this.opLogger.stopListening();

    // User-resolved conflicts are re-emitted as ops (below) so peers learn the
    // resolution instead of diverging. Collected here and recorded only *after*
    // clearOps, which would otherwise wipe them.
    const resolutions: PendingResolution[] = [];

    try {
      for (const action of actions) {
        const resolved = await this.applyAction(action, localState, remoteState);
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

    // Update ancestor hashes for all synced files
    await this.updateAncestorHashes(actions, localState, remoteState);

    // Persist the resolution ops now that the already-pushed pending log is
    // clear — they become pending for the next round and replicate the manual
    // resolution to peers. The registry was already updated to the resolved
    // hash during apply, so the resumed modify listener suppresses the echo.
    for (const r of resolutions) {
      if (r.kind === 'delete') {
        await this.opLogger.recordResolvedDelete(r.fileId, r.path, r.contentHash, r.hlc, r.supersedes);
      } else {
        await this.opLogger.recordResolvedUpdate(r.fileId, r.path, r.contentHash, r.hlc, r.supersedes);
      }
    }
  }

  private async applyAction(
    action: MergeAction,
    local: VaultState,
    remote: VaultState,
  ): Promise<PendingResolution | null> {
    switch (action.type) {
      case 'write_local': {
        const hash = await hashContent(action.content);
        if (await this.wouldTruncateNonEmpty(action.path, action.content)) {
          console.warn(`Vault Sync: skipping write_local for ${action.path} — refusing to truncate a non-empty file with empty content`);
          return null;
        }
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
        await this.registry.adoptRemote(action.fileId, action.path, hash, action.hlc);
        return null;
      }

      case 'move_local':
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
        await this.files.trash(action.path);
        // Tombstone in the registry so the propagated delete survives restarts
        // and isn't re-detected as a local creation on the next reconcile.
        await this.registry.markDeleted(action.path, this.hlc.now());
        return null;

      case 'conflict': {
        const resolved = await this.onConflict(action);
        if (!resolved) return null;
        // The resolution is a fresh decision the CRDT replay can't reproduce, so
        // it must become its own op. Timestamp it *now*: runSync has already
        // advanced the clock past the merged HLC, so this dominates the remote
        // content it supersedes and wins last-writer-wins on peers.
        const hlcTs = this.hlc.now();
        const hash = await hashContent(resolved);
        await this.files.write(action.localPath, resolved);
        await this.contentStore.put(hash, resolved);
        // Advance the registry to the resolved content (mirrors write_local's
        // echo-suppression) and record it as the new synced ancestor — this
        // resolution is the base future three-way merges align against.
        await this.registry.updateContentHash(action.localPath, hash, hlcTs);
        await this.registry.setAncestorHash(action.fileId, hash);
        // Tag the resolution with the two sides it settles so peers still
        // holding either version adopt it instead of re-prompting.
        return { kind: 'update', fileId: action.fileId, path: action.localPath, contentHash: hash, hlc: hlcTs, supersedes: action.parentHashes };
      }

      case 'delete_conflict': {
        const decision = await this.onDeleteConflict(action);
        // Timestamp the decision *now* so it dominates the delete/edit it
        // supersedes (runSync already advanced the clock past the merged HLC),
        // and tag it with both sides so a peer still holding either adopts the
        // decision instead of independently re-prompting.
        const hlcTs = this.hlc.now();
        const hash = await hashContent(action.content);
        if (decision === 'restore') {
          if (await this.wouldTruncateNonEmpty(action.path, action.content)) {
            console.warn(`Vault Sync: skipping delete_conflict restore for ${action.path} — refusing to overwrite a non-empty file with empty content`);
            return null;
          }
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

      case 'send_remote':
      case 'delete_remote':
      case 'no_op':
        // These are handled by the transport layer, not the applicator
        return null;
    }
  }

  /**
   * Defense-in-depth for F1: a destructive write must never *truncate* a file —
   * i.e. replace existing non-empty bytes with an empty buffer. State-merge
   * already declines to emit a write/restore when the winning side's bytes are
   * missing; this is the backstop if an empty buffer nonetheless reaches the
   * applicator. It targets the real hazard (silent truncation of a non-empty
   * file) rather than "any empty content": writing empty over an already-empty
   * or absent file is harmless, and — crucially — a peer's genuinely-empty file
   * must still be created here on first sync (its empty-hash blob isn't in this
   * device's persistent store yet), so we gate on the *current on-disk* content,
   * not the content store. The read only happens for the rare empty-buffer case.
   */
  private async wouldTruncateNonEmpty(path: string, content: Uint8Array): Promise<boolean> {
    if (content.length > 0) return false;
    const current = await this.files.read(path);
    return current !== null && current.length > 0;
  }

  private async updateAncestorHashes(
    actions: MergeAction[],
    local: VaultState,
    remote: VaultState,
  ): Promise<void> {
    // The advance *decision* (first-sync / action-type branching, and the
    // send_remote-only-on-first-sync rule whose violation caused the reported
    // data loss) lives in the pure `nextAncestorHash` domain policy. The shell
    // only performs effects: `write_local` must hash freshly written bytes
    // (async I/O the policy can't do), so its branch stays here; everything else
    // asks the policy for the hash to set.
    for (const action of actions) {
      if (action.type === 'write_local') {
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
