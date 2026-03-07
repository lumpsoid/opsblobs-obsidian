// ─────────────────────────────────────────────
//  Operation Logger
//  Phase 1.4
// ─────────────────────────────────────────────
//
//  Hooks into Obsidian vault events and records operations.
//  Debounces rapid saves so only one operation is recorded per logical edit.

import { App, TFile, normalizePath } from 'obsidian';
import { Operation, OperationType } from '../types';
import { HybridLogicalClock } from './hlc';
import { FileRegistry } from './file-registry';
import { ContentStore, hashContent } from './content-store';

const OPLOG_PATH = '.vault-sync/oplog.json';

export class OperationLogger {
  private pendingOps: Operation[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private eventHandlers: Array<() => void> = [];

  constructor(
    private app: App,
    private deviceId: string,
    private hlc: HybridLogicalClock,
    private registry: FileRegistry,
    private contentStore: ContentStore,
    private debounceMs: number = 1500,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(OPLOG_PATH);
      this.pendingOps = JSON.parse(raw);
    } catch {
      this.pendingOps = [];
    }
  }

  startListening(): void {
    const onCreate = this.app.vault.on('create', file => {
      if (file instanceof TFile) this.handleCreate(file);
    });
    const onModify = this.app.vault.on('modify', file => {
      if (file instanceof TFile) this.handleModify(file);
    });
    const onDelete = this.app.vault.on('delete', file => {
      if (file instanceof TFile) this.handleDelete(file);
    });
    const onRename = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile) this.handleRename(file, oldPath);
    });

    // Store removers so we can clean up on unload
    this.eventHandlers.push(
      () => this.app.vault.offref(onCreate),
      () => this.app.vault.offref(onModify),
      () => this.app.vault.offref(onDelete),
      () => this.app.vault.offref(onRename),
    );
  }

  stopListening(): void {
    for (const remove of this.eventHandlers) remove();
    this.eventHandlers = [];
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  private async handleCreate(file: TFile): Promise<void> {
    if (this.isExcluded(file.path)) return;
    const hlcTs = this.hlc.now();
    const content = await this.readFile(file);
    const hash = await hashContent(content);

    const id = await this.registry.registerFile(file, hlcTs, hash);
    await this.contentStore.put(hash, content);

    await this.recordOp({
      id: this.opId(),
      deviceId: this.deviceId,
      hlcTimestamp: hlcTs,
      fileId: id,
      type: 'create',
      path: file.path,
      contentHash: hash,
    });
  }

  private handleModify(file: TFile): void {
    if (this.isExcluded(file.path)) return;

    // Cancel existing debounce for this file
    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      this.flushModify(file).catch(console.error);
    }, this.debounceMs);

    this.debounceTimers.set(file.path, timer);
  }

  private async flushModify(file: TFile): Promise<void> {
    const entry = this.registry.getByPath(file.path);
    if (!entry) {
      // Untracked file got modified — treat as create
      await this.handleCreate(file);
      return;
    }

    const content = await this.readFile(file);
    const hash = await hashContent(content);

    // Skip if content hasn't actually changed
    if (hash === entry.contentHash) return;

    const hlcTs = this.hlc.now();
    await this.contentStore.put(hash, content);
    await this.registry.updateContentHash(file.path, hash, hlcTs);

    await this.recordOp({
      id: this.opId(),
      deviceId: this.deviceId,
      hlcTimestamp: hlcTs,
      fileId: entry.id,
      type: 'update',
      path: file.path,
      contentHash: hash,
    });
  }

  private async handleDelete(file: TFile): Promise<void> {
    if (this.isExcluded(file.path)) return;
    const entry = this.registry.getByPath(file.path);
    if (!entry) return;

    const hlcTs = this.hlc.now();
    await this.registry.markDeleted(file.path, hlcTs);

    // If there's a pending create for this file, cancel them out
    this.pruneCreateDeletePair(entry.id);

    await this.recordOp({
      id: this.opId(),
      deviceId: this.deviceId,
      hlcTimestamp: hlcTs,
      fileId: entry.id,
      type: 'delete',
      path: file.path,
      contentHash: entry.contentHash,
    });
  }

  private async handleRename(file: TFile, oldPath: string): Promise<void> {
    if (this.isExcluded(file.path) && this.isExcluded(oldPath)) return;
    const entry = this.registry.getByPath(oldPath);
    if (!entry) {
      // Was excluded before rename, now included — treat as create
      await this.handleCreate(file);
      return;
    }

    const hlcTs = this.hlc.now();
    await this.registry.updatePath(oldPath, file.path, hlcTs);

    await this.recordOp({
      id: this.opId(),
      deviceId: this.deviceId,
      hlcTimestamp: hlcTs,
      fileId: entry.id,
      type: 'move',
      path: file.path,
      previousPath: oldPath,
      contentHash: entry.contentHash,
    });
  }

  // ─── Op management ────────────────────────────────────────────────────────

  getPendingOps(): Operation[] {
    return [...this.pendingOps];
  }

  async clearOps(): Promise<void> {
    this.pendingOps = [];
    await this.saveOpLog();
  }

  private async recordOp(op: Operation): Promise<void> {
    this.pendingOps.push(op);
    await this.saveOpLog();
  }

  private async saveOpLog(): Promise<void> {
    const dir = normalizePath('.vault-sync');
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(OPLOG_PATH, JSON.stringify(this.pendingOps, null, 2));
  }

  /**
   * If a file was created then deleted before any sync, remove both ops.
   * They cancel out — remote doesn't know the file ever existed.
   */
  private pruneCreateDeletePair(fileId: string): void {
    const createIdx = this.pendingOps.findIndex(
      op => op.fileId === fileId && op.type === 'create',
    );
    if (createIdx !== -1) {
      // Remove the create and all subsequent ops for this file
      this.pendingOps = this.pendingOps.filter(op => op.fileId !== fileId);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async readFile(file: TFile): Promise<Uint8Array> {
    const arrayBuffer = await this.app.vault.readBinary(file);
    return new Uint8Array(arrayBuffer);
  }

  private isExcluded(path: string): boolean {
    return path.startsWith('.vault-sync/');
  }

  private opId(): string {
    return `${this.deviceId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
