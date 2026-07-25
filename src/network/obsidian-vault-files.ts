// ─────────────────────────────────────────────
//  ObsidianVaultFiles — live VaultFiles implementation
// ─────────────────────────────────────────────
//
//  The one place `normalizePath` / `TFile` / the vault file APIs live. Bodies
//  lifted from `SyncApplicator`'s former `writeLocalFile`/`moveLocalFile`/
//  `deleteLocalFile`/`ensureDir` helpers, plus the file reads/listing the host
//  and operation logger will migrate to in later phases.

import { App, TFile, normalizePath } from 'obsidian';
import { VaultFiles, VaultFileRef } from '../ports/vault-files';

export class ObsidianVaultFiles implements VaultFiles {
  // Dirs already ensured this session — skips the `adapter.exists` stat that `write`
  // otherwise pays per file. A bulk apply (first pull of an 8k-note vault) touches
  // every file, so an unmemoized `ensureDir` fired ~8k redundant dir stats; this
  // collapses them to one per distinct dir (apply-path-pack-writes-spec §2.3, mirroring
  // ContentStore.packDirEnsured). Never cleared within a session — dirs we created
  // don't get un-created under us mid-run.
  private ensuredDirs: Set<string> = new Set();

  constructor(private app: App) {}

  list(): VaultFileRef[] {
    // `TFile.stat` is already loaded on every file in the index, so carrying its
    // mtime/size costs no extra syscall — it feeds the offline-capture stat gate (O1).
    return this.app.vault.getFiles().map(f => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) return null;
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async write(path: string, content: Uint8Array): Promise<void> {
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

  async move(fromPath: string, toPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(fromPath));
    if (file) {
      await this.app.fileManager.renameFile(file, normalizePath(toPath));
    }
  }

  async trash(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file) {
      await this.app.vault.trash(file, true);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (this.ensuredDirs.has(dirPath)) return;
    if (!(await this.app.vault.adapter.exists(dirPath))) {
      await this.app.vault.adapter.mkdir(dirPath);
    }
    this.ensuredDirs.add(dirPath);
  }
}
