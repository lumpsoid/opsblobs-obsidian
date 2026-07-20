// ─────────────────────────────────────────────
//  Operation Logger
//  Phase 1.4
// ─────────────────────────────────────────────
//
//  Observes vault change events (via a VaultWatcher port) and records
//  operations. Debounces rapid saves so only one operation is recorded per
//  logical edit. Reads file bytes through a VaultFiles port and persists the
//  oplog through a MetadataStore port — obsidian-free.

import { HLC, Operation, SyncSettings } from '../types';
import { HybridLogicalClock } from './hlc';
import { Ops } from './operations';
import { FileRegistry } from './file-registry';
import { ContentStore, hashContent } from './content-store';
import { isExcluded } from './exclusion-policy';
import { VaultFiles } from '../ports/vault-files';
import { VaultWatcher } from '../ports/vault-watcher';
import { MetadataStore } from '../ports/metadata-store';

/** Minimal HLC persistence surface (satisfied by `network/HlcStore`). Typed
 *  structurally so `core/` needn't depend on `network/`. */
export interface HlcPersister {
  save(hlc: HLC): Promise<void>;
}

const OPLOG_DIR = '.vault-sync';
const OPLOG_PATH = '.vault-sync/oplog.json';

export class OperationLogger {
  private pendingOps: Operation[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private files: VaultFiles,
    private watcher: VaultWatcher,
    private metadata: MetadataStore,
    private hlc: HybridLogicalClock,
    private registry: FileRegistry,
    private contentStore: ContentStore,
    private getSettings: () => SyncSettings,
    private debounceMs: number = 1500,
    // Persists the HLC alongside the oplog (F7). Every op is stamped with
    // `hlc.now()` and saved via `saveOpLog`, so piggybacking the HLC write there
    // means logical time is durable the instant it is issued — a crash + wall
    // regression can't rewind below an emitted timestamp. Optional so tests /
    // callers that don't need persistence omit it.
    private hlcStore?: HlcPersister,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const raw = await this.metadata.read(OPLOG_PATH);
    this.pendingOps = raw === null ? [] : (JSON.parse(raw) as Operation[]);
  }

  /**
   * Emit ops for changes that happened while we weren't listening — above all,
   * the *first* enable on a vault that already contains files. No `create` event
   * ever fires for pre-existing files (they were there before listeners
   * attached), so without this pass their content never becomes an op and never
   * reaches the server. This diffs the live vault against the registry and
   * records the missing create/update/delete ops.
   *
   * Idempotent: a file whose current content already matches its registry entry
   * produces nothing, so running it on every load never duplicates ops. Call it
   * after `load()` and *before* `startListening()` — it mutates the registry and
   * content store but never the vault, so it fires no vault events of its own.
   */
  async captureOfflineChanges(): Promise<void> {
    let changed = false;
    const onDisk = new Set<string>();

    // ── Live files: untracked → create, content drifted → update ─────────────
    for (const ref of this.files.list()) {
      const path = ref.path;
      if (this.isExcluded(path)) continue;
      onDisk.add(path);

      const content = await this.files.read(path);
      if (content === null) continue;
      const hash = await hashContent(content);
      const entry = this.registry.getByPath(path);

      if (entry && entry.contentHash === hash) continue; // already captured/synced

      await this.contentStore.put(hash, content);
      const hlcTs = this.hlc.now();

      if (!entry) {
        const id = await this.registry.registerFile({ path }, hlcTs, hash);
        this.pendingOps.push(Ops.create(id, path, hash, hlcTs));
      } else {
        // A drifted hash means either a placeholder from an older op-less
        // reconcile ('') or an edit made while the plugin was off. Either way
        // the op carries the current content, so peers converge; `create` when
        // it was never really captured, `update` otherwise.
        await this.registry.updateContentHash(path, hash, hlcTs);
        this.pendingOps.push(
          entry.contentHash === ''
            ? Ops.create(entry.id, path, hash, hlcTs)
            : Ops.update(entry.id, path, hash, hlcTs),
        );
      }
      changed = true;
    }

    // ── Registry entries whose file vanished while offline → delete ──────────
    for (const entry of this.registry.getActiveEntries()) {
      if (this.isExcluded(entry.path) || onDisk.has(entry.path)) continue;
      const hlcTs = this.hlc.now();
      await this.registry.markDeleted(entry.path, hlcTs);
      this.pendingOps.push(Ops.delete(entry.id, entry.path, entry.contentHash, hlcTs));
      changed = true;
    }

    if (changed) await this.saveOpLog();
  }

  startListening(): void {
    this.watcher.start({
      // Return the handler promise so a test-driven watcher can await the async
      // create/delete/rename path deterministically. `handleModify` stays void:
      // it only arms a debounce timer, and `flush()` awaits the eventual work.
      onCreate: path => this.handleCreate(path),
      onModify: path => this.handleModify(path),
      onDelete: path => this.handleDelete(path),
      onRename: (path, oldPath) => this.handleRename(path, oldPath),
    });
  }

  stopListening(): void {
    this.watcher.stop();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /**
   * Immediately record any *debounced* modify that is still waiting out its
   * timer, instead of letting the delay elapse. Call this before a sync: an
   * edit made moments before the user hits sync would otherwise still be sitting
   * in the debounce window, so its op wouldn't exist yet — and the sync would
   * then merge a file whose registry hash is stale and silently drop the edit.
   * Flushing first guarantees the edit is captured as an op (and the registry
   * updated) before the local state is built.
   */
  async flush(): Promise<void> {
    const paths = [...this.debounceTimers.keys()];
    for (const path of paths) {
      const timer = this.debounceTimers.get(path);
      if (timer) clearTimeout(timer);
      this.debounceTimers.delete(path);
      await this.flushModify(path);
    }
  }

  /**
   * Re-capture a file whose on-disk bytes changed *during* a sync round but were
   * never logged as an op (F5): the applicator declined a destructive merge
   * action because the file drifted since `buildLocalState` snapshotted it, so
   * that in-window edit must be turned into a durable pending op here — the
   * debounce timer can't be trusted (it may have been cleared by
   * `stopListening`/`clearOps`, or its hash-equality guard may suppress it after
   * the file was briefly overwritten). Reads the current bytes and records an
   * `update` (the same work a debounced modify does). Call *after* the apply's
   * `clearOps` + `startListening` so the op survives the round.
   */
  async recaptureLocalEdit(path: string): Promise<void> {
    await this.flushModify(path);
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  private async handleCreate(path: string): Promise<void> {
    if (this.isExcluded(path)) return;
    const hlcTs = this.hlc.now();
    const content = await this.files.read(path);
    if (content === null) return;
    const hash = await hashContent(content);

    const id = await this.registry.registerFile({ path }, hlcTs, hash);
    await this.contentStore.put(hash, content);

    await this.recordOp(Ops.create(id, path, hash, hlcTs));
  }

  private handleModify(path: string): void {
    if (this.isExcluded(path)) return;

    // Cancel existing debounce for this file
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      this.flushModify(path).catch(console.error);
    }, this.debounceMs);

    this.debounceTimers.set(path, timer);
  }

  private async flushModify(path: string): Promise<void> {
    const entry = this.registry.getByPath(path);
    if (!entry) {
      // Untracked file got modified — treat as create
      await this.handleCreate(path);
      return;
    }

    const content = await this.files.read(path);
    if (content === null) return;
    const hash = await hashContent(content);

    // Skip if content hasn't actually changed
    if (hash === entry.contentHash) return;

    const hlcTs = this.hlc.now();
    await this.contentStore.put(hash, content);
    await this.registry.updateContentHash(path, hash, hlcTs);

    await this.recordOp(Ops.update(entry.id, path, hash, hlcTs));
  }

  private async handleDelete(path: string): Promise<void> {
    if (this.isExcluded(path)) return;
    const entry = this.registry.getByPath(path);
    if (!entry) return;

    const hlcTs = this.hlc.now();
    await this.registry.markDeleted(path, hlcTs);

    // If there's a pending create for this file, cancel them out
    this.pruneCreateDeletePair(entry.id);

    await this.recordOp(Ops.delete(entry.id, path, entry.contentHash, hlcTs));
  }

  private async handleRename(path: string, oldPath: string): Promise<void> {
    if (this.isExcluded(path) && this.isExcluded(oldPath)) return;
    const entry = this.registry.getByPath(oldPath);
    if (!entry) {
      // Was excluded before rename, now included — treat as create
      await this.handleCreate(path);
      return;
    }

    const hlcTs = this.hlc.now();
    await this.registry.updatePath(oldPath, path, hlcTs);

    await this.recordOp(Ops.move(entry.id, path, entry.contentHash, hlcTs));
  }

  // ─── Op management ────────────────────────────────────────────────────────

  getPendingOps(): Operation[] {
    return [...this.pendingOps];
  }

  async clearOps(): Promise<void> {
    this.pendingOps = [];
    await this.saveOpLog();
  }

  /**
   * Record an `update` op for content produced by sync itself — specifically a
   * user-resolved merge conflict. Ordinary edits are captured through vault
   * events, but a conflict is resolved *while listeners are paused* and the
   * pending log is then cleared, so the resolution would otherwise never become
   * an op and never reach peers (they'd keep their own version and diverge).
   *
   * Call this *after* the applicator has cleared the already-pushed pending ops,
   * so the resolution survives as a fresh pending op for the next round. The
   * caller supplies an HLC that dominates the remote content being superseded,
   * so the resolution wins last-writer-wins when peers pull it.
   */
  async recordResolvedUpdate(fileId: string, path: string, contentHash: string, hlcTs: HLC, supersedes: string[]): Promise<void> {
    await this.recordOp(Ops.resolveUpdate(fileId, path, contentHash, hlcTs, supersedes));
  }

  /**
   * Record a `delete` op for a delete/modify conflict the user resolved by
   * *accepting the deletion*. Like {@link recordResolvedUpdate}, this is produced
   * while listeners are paused and after the pending log is cleared, so it must
   * be re-emitted explicitly. `supersedes` names the two conflicting sides so a
   * peer still holding the modified version adopts the deletion instead of
   * re-prompting. `contentHash` is the superseded (now-deleted) content.
   */
  async recordResolvedDelete(fileId: string, path: string, contentHash: string, hlcTs: HLC, supersedes: string[]): Promise<void> {
    await this.recordOp(Ops.resolveDelete(fileId, path, contentHash, hlcTs, supersedes));
  }

  private async recordOp(op: Operation): Promise<void> {
    this.pendingOps.push(op);
    await this.saveOpLog();
  }

  private async saveOpLog(): Promise<void> {
    if (!(await this.metadata.exists(OPLOG_DIR))) {
      await this.metadata.mkdir(OPLOG_DIR);
    }
    await this.metadata.write(OPLOG_PATH, JSON.stringify(this.pendingOps, null, 2));
    // Persist the current logical time whenever we persist ops (F7). This is the
    // per-op cadence; `main.ts` additionally persists after each sync round and
    // on unload, so time issued outside op-recording (merge/setCurrent) is durable.
    await this.hlcStore?.save(this.hlc.getCurrent());
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

  private isExcluded(path: string): boolean {
    return isExcluded(path, this.getSettings());
  }
}
