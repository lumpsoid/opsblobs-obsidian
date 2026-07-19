// ─────────────────────────────────────────────
//  VaultFiles port  (pure — must not import 'obsidian')
// ─────────────────────────────────────────────
//
//  The narrow surface the sync stack needs from the vault's note files:
//  create/modify/move/trash/read/list/exists. `ObsidianVaultFiles` is the live
//  implementation (holds `App`); a fake `Map`-backed implementation drives the
//  real device stack in tests.

export interface VaultFileRef {
  path: string;
}

export interface VaultFiles {
  /** All note files currently in the vault (was `vault.getFiles()`). */
  list(): VaultFileRef[];
  /** File bytes, or null if the path is absent / not a file (was `readBinary`). */
  read(path: string): Promise<Uint8Array | null>;
  /** Create-or-modify the file, ensuring its parent directory exists. */
  write(path: string, content: Uint8Array): Promise<void>;
  /** Move/rename a file (was `fileManager.renameFile`); no-op if absent. */
  move(fromPath: string, toPath: string): Promise<void>;
  /** Move the file to trash (was `vault.trash(file, true)`); no-op if absent. */
  trash(path: string): Promise<void>;
  /** Whether a file exists at the path. */
  exists(path: string): Promise<boolean>;
}
