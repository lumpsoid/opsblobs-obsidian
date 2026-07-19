// ─────────────────────────────────────────────
//  ObsidianVaultWatcher — live VaultWatcher implementation
// ─────────────────────────────────────────────
//
//  The one place the vault event wiring and the `instanceof TFile` filter live.
//  `start` subscribes to `vault.on('create'|'modify'|'delete'|'rename')`,
//  forwarding each `TFile`'s `path` (and the oldPath for rename) to the
//  handlers; `stop` offrefs every subscription.

import { App, TFile } from 'obsidian';
import { VaultWatcher, VaultChangeHandlers } from '../ports/vault-watcher';

export class ObsidianVaultWatcher implements VaultWatcher {
  private removers: Array<() => void> = [];

  constructor(private app: App) {}

  start(handlers: VaultChangeHandlers): void {
    const onCreate = this.app.vault.on('create', file => {
      if (file instanceof TFile) void handlers.onCreate(file.path);
    });
    const onModify = this.app.vault.on('modify', file => {
      if (file instanceof TFile) void handlers.onModify(file.path);
    });
    const onDelete = this.app.vault.on('delete', file => {
      if (file instanceof TFile) void handlers.onDelete(file.path);
    });
    const onRename = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile) void handlers.onRename(file.path, oldPath);
    });

    this.removers.push(
      () => this.app.vault.offref(onCreate),
      () => this.app.vault.offref(onModify),
      () => this.app.vault.offref(onDelete),
      () => this.app.vault.offref(onRename),
    );
  }

  stop(): void {
    for (const remove of this.removers) remove();
    this.removers = [];
  }
}
