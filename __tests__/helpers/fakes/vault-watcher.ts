// ─────────────────────────────────────────────
//  FakeVaultWatcher — in-memory VaultWatcher for tests
// ─────────────────────────────────────────────
//
//  Records the handlers passed to `start` and exposes `emitCreate/Modify/
//  Delete/Rename` so a test can drive the real `OperationLogger` through
//  synthetic vault events. Emits are no-ops before `start` and after `stop`.

import { VaultWatcher, VaultChangeHandlers } from '../../../src/ports/vault-watcher';

export class FakeVaultWatcher implements VaultWatcher {
  private handlers: VaultChangeHandlers | null = null;

  start(handlers: VaultChangeHandlers): void {
    this.handlers = handlers;
  }

  stop(): void {
    this.handlers = null;
  }

  async emitCreate(path: string): Promise<void> {
    await this.handlers?.onCreate(path);
  }

  emitModify(path: string): void {
    // Modify is debounced (handler only arms a timer); tests await it via flush().
    void this.handlers?.onModify(path);
  }

  async emitDelete(path: string): Promise<void> {
    await this.handlers?.onDelete(path);
  }

  async emitRename(path: string, oldPath: string): Promise<void> {
    await this.handlers?.onRename(path, oldPath);
  }
}
