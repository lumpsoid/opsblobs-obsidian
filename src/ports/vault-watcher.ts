// ─────────────────────────────────────────────
//  VaultWatcher port  (pure — must not import 'obsidian')
// ─────────────────────────────────────────────
//
//  The narrow surface the `OperationLogger` needs to observe vault change
//  events: create/modify/delete/rename, each forwarded as a plain path.
//  `ObsidianVaultWatcher` is the live implementation (holds `App`, applies the
//  `instanceof TFile` filter, and offrefs on stop); a fake implementation
//  emits synthetic events to drive the real device stack in tests.

export interface VaultChangeHandlers {
  onCreate(path: string): void | Promise<void>;
  onModify(path: string): void | Promise<void>;
  onDelete(path: string): void | Promise<void>;
  onRename(path: string, oldPath: string): void | Promise<void>;
}

export interface VaultWatcher {
  /** Subscribe to vault change events. */
  start(handlers: VaultChangeHandlers): void;
  /** Unsubscribe all handlers. */
  stop(): void;
}
