// ─────────────────────────────────────────────
//  Sync Applicator
//  Applies merge actions to the actual vault
// ─────────────────────────────────────────────

import { App, normalizePath } from 'obsidian';
import { MergeAction, VaultState } from '../types';
import { FileRegistry } from '../core/file-registry';
import { ContentStore, hashContent } from '../core/content-store';
import { OperationLogger } from '../core/operation-logger';
import { HybridLogicalClock } from '../core/hlc';

export type ConflictHandler = (action: Extract<MergeAction, { type: 'conflict' }>) => Promise<Uint8Array | null>;
export type DeleteConflictHandler = (action: Extract<MergeAction, { type: 'delete_conflict' }>) => Promise<'keep_deleted' | 'restore'>;

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

    try {
      for (const action of actions) {
        await this.applyAction(action, localState, remoteState);
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
  }

  private async applyAction(
    action: MergeAction,
    local: VaultState,
    remote: VaultState,
  ): Promise<void> {
    switch (action.type) {
      case 'write_local': {
        const hash = await hashContent(action.content);
        await this.writeLocalFile(action.path, action.content);
        await this.contentStore.put(hash, action.content);
        // Keep the registry in sync so that if a vault modify event fires for
        // this write after we resume listening, flushModify's hash-equality
        // guard ("skip if content hasn't changed") will correctly suppress it.
        await this.registry.updateContentHash(action.path, hash, action.hlc);
        break;
      }

      case 'move_local':
        await this.moveLocalFile(action.fromPath, action.toPath);
        break;

      case 'delete_local':
        await this.deleteLocalFile(action.path);
        break;

      case 'conflict': {
        const resolved = await this.onConflict(action);
        if (resolved) {
          await this.writeLocalFile(action.localPath, resolved);
          await this.contentStore.put(await hashContent(resolved), resolved);
        }
        break;
      }

      case 'delete_conflict': {
        const decision = await this.onDeleteConflict(action);
        if (decision === 'restore') {
          await this.writeLocalFile(action.path, action.content);
          await this.contentStore.put(await hashContent(action.content), action.content);
        }
        // 'keep_deleted' — do nothing
        break;
      }

      case 'send_remote':
      case 'delete_remote':
      case 'no_op':
        // These are handled by the transport layer, not the applicator
        break;
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
    if (existing) {
      await this.app.vault.modifyBinary(existing as any, content.buffer);
    } else {
      await this.app.vault.createBinary(normalized, content.buffer);
    }
  }

  private async moveLocalFile(fromPath: string, toPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(fromPath));
    if (file) {
      await this.app.fileManager.renameFile(file as any, normalizePath(toPath));
    }
  }

  private async deleteLocalFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file) {
      await this.app.vault.trash(file as any, true);
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
          await this.registry.setAncestorHash(action.fileId, entry.contentHash);
        }
      }
    }
  }
}
