// ─────────────────────────────────────────────
//  Sync Applicator
//  Applies merge actions to the actual vault
// ─────────────────────────────────────────────

import { App, TFile, normalizePath } from 'obsidian';
import { HLC, MergeAction, VaultState } from '../types';
import { FileRegistry } from '../core/file-registry';
import { ContentStore, hashContent } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { HybridLogicalClock } from '../core/hlc';

export type ConflictHandler = (action: Extract<MergeAction, { type: 'conflict' }>) => Promise<Uint8Array | null>;
export type DeleteConflictHandler = (action: Extract<MergeAction, { type: 'delete_conflict' }>) => Promise<'keep_deleted' | 'restore'>;

/** A user-resolved conflict that must be re-emitted as an op so it replicates. */
interface PendingResolution {
  fileId: string;
  path: string;
  contentHash: string;
  hlc: HLC;
  supersedes: string[];
}

export class SyncApplicator {
  constructor(
    private app: App,
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
      await this.opLogger.recordResolvedUpdate(r.fileId, r.path, r.contentHash, r.hlc, r.supersedes);
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
        await this.writeLocalFile(action.path, action.content);
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
        await this.moveLocalFile(action.fromPath, action.toPath);
        return null;

      case 'delete_local':
        await this.deleteLocalFile(action.path);
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
        await this.writeLocalFile(action.localPath, resolved);
        await this.contentStore.put(hash, resolved);
        // Advance the registry to the resolved content (mirrors write_local's
        // echo-suppression) and record it as the new synced ancestor — this
        // resolution is the base future three-way merges align against.
        await this.registry.updateContentHash(action.localPath, hash, hlcTs);
        await this.registry.setAncestorHash(action.fileId, hash);
        // Tag the resolution with the two sides it settles so peers still
        // holding either version adopt it instead of re-prompting.
        return { fileId: action.fileId, path: action.localPath, contentHash: hash, hlc: hlcTs, supersedes: action.parentHashes };
      }

      case 'delete_conflict': {
        const decision = await this.onDeleteConflict(action);
        if (decision === 'restore') {
          await this.writeLocalFile(action.path, action.content);
          await this.contentStore.put(await hashContent(action.content), action.content);
        }
        // 'keep_deleted' — do nothing
        return null;
      }

      case 'send_remote':
      case 'delete_remote':
      case 'no_op':
        // These are handled by the transport layer, not the applicator
        return null;
    }
  }

  private async writeLocalFile(path: string, content: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    // Ensure parent directory exists
    const parts = normalized.split('/');
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join('/');
      await this.ensureDir(dir);
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, content.buffer);
    } else {
      await this.app.vault.createBinary(normalized, content.buffer);
    }
  }

  private async moveLocalFile(fromPath: string, toPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(fromPath));
    if (file) {
      await this.app.fileManager.renameFile(file, normalizePath(toPath));
    }
  }

  private async deleteLocalFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file) {
      await this.app.vault.trash(file, true);
    }
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(dirPath))) {
      await this.app.vault.adapter.mkdir(dirPath);
    }
  }

  private async updateAncestorHashes(
    actions: MergeAction[],
    local: VaultState,
    remote: VaultState,
  ): Promise<void> {
    for (const action of actions) {
      if (action.type === 'write_local') {
        const hash = await hashContent(action.content);
        await this.registry.setAncestorHash(action.fileId, hash);
      } else if (action.type === 'no_op' || action.type === 'send_remote') {
        const entry = local.fileEntries.get(action.fileId);
        if (entry && !entry.deleted) {
          // `send_remote` must only *establish* a missing ancestor — the first
          // ever sync of a never-synced file, where a null ancestor means no
          // peer holds a divergent copy, so the current content is a safe common
          // base. It must NOT advance an existing ancestor: pushing our own edit
          // to the server is not a peer acknowledgement, and a peer that edited
          // the same file concurrently still diverged from the *previous* base.
          // Advancing here would make our next merge treat our un-acknowledged
          // edit as the base, see "local unchanged", and silently adopt the
          // peer's version — the reported data-loss bug. `no_op` means both
          // sides already hold this content, so advancing is always safe.
          const isFirstSync = entry.ancestorContentHash === null;
          if (action.type === 'no_op' || isFirstSync) {
            await this.registry.setAncestorHash(action.fileId, entry.contentHash);
          }
        }
      }
    }
  }
}
