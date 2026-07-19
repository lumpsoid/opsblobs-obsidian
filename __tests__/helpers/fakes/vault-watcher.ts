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

  emitCreate(path: string): void {
    this.handlers?.onCreate(path);
  }

  emitModify(path: string): void {
    this.handlers?.onModify(path);
  }

  emitDelete(path: string): void {
    this.handlers?.onDelete(path);
  }

  emitRename(path: string, oldPath: string): void {
    this.handlers?.onRename(path, oldPath);
  }
}
