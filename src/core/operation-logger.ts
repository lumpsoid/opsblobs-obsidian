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
import { Ops, mergeVersionId } from './operations';
import { FileRegistry } from './file-registry';
import { ContentStore, hashContent } from './content-store';
import { isExcluded } from './exclusion-policy';
import { hasConflictMarkers } from '../merge/diff3';
import { VaultFiles } from '../ports/vault-files';
import { VaultWatcher } from '../ports/vault-watcher';
import { MetadataStore } from '../ports/metadata-store';
import { Notifier } from '../ports/notifier';

/** Minimal HLC persistence surface (satisfied by `network/HlcStore`). Typed
 *  structurally so `core/` needn't depend on `network/`. */
export interface HlcPersister {
  save(hlc: HLC): Promise<void>;
}

const OPLOG_DIR = '.vault-sync';
const OPLOG_PATH = '.vault-sync/oplog.json';

/** How often `captureOfflineChanges` fires its optional progress callback (every N
 *  files scanned) — perf diagnostics only. */
const CAPTURE_PROGRESS_EVERY = 100;

/** How often `captureOfflineChanges` persists the oplog mid-pass (every N emitted
 *  ops). A large first-enable capture runs for minutes on mobile and can be killed
 *  mid-way (OOM at the memory cliff); checkpointing bounds the un-journalled ops an
 *  interrupted pass can lose to <N (instead of the whole capture) and keeps the live
 *  pending count fresh. Bytes-per-checkpoint grow with the pending set, so this
 *  trades a bounded write cost for durability — kept modest to stay mobile-friendly. */
const CAPTURE_CHECKPOINT_EVERY = 200;

export class OperationLogger {
  private pendingOps: Operation[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Notified whenever the pending oplog is persisted — i.e. an op was
   *  recorded, cleared, or cancelled. Lets the UI reflect "changes to sync"
   *  the instant a (debounced) edit lands, without polling. */
  private changeListener: (() => void) | null = null;

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
    // Surfaces a non-blocking notice when a save on a two-headed (conflict-marked)
    // file still contains conflict markers (sync v2 Step 5). Optional — omitted by
    // callers that don't need it; the resolution logic works without it.
    private notifier?: Notifier,
  ) {}

  /** Subscribe to pending-oplog changes. At most one listener; the latest wins.
   *  Fires *after* the log is persisted, so `getPendingOps()` is already current
   *  when the callback runs. `load()` sets the log without notifying (there is
   *  no observer yet at load time). */
  onChange(listener: () => void): void {
    this.changeListener = listener;
  }

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
  /**
   * @param onProgress Optional scan-progress callback (perf diagnostics, Layer 3):
   *  invoked every {@link CAPTURE_PROGRESS_EVERY} files with `(scanned, total)`. On a
   *  large vault this pass is O(F·B) hashing + up to O(F²) registry rewrites, so it can
   *  run for many minutes on mobile; the callback surfaces liveness + the throughput
   *  curve even when it hasn't finished (a phase timed only on completion reports
   *  nothing). Inert when omitted — no work is done in the hot path beyond a modulo.
   */
  async captureOfflineChanges(onProgress?: (scanned: number, total: number) => void): Promise<void> {
    let changed = false;
    let sinceCheckpoint = 0;
    const onDisk = new Set<string>();

    // Batch the registry writes. Without this each file re-serialized the WHOLE
    // registry (registerFile + setHeadVersion each save()), so the pass was O(F²) —
    // ~4 ms/file climbing to a GC cliff on a mobile vault of a few thousand files.
    // Suspended here, the registry is persisted only at the checkpoints below, so the
    // per-file cost is flat. `resumeSaves` runs in `finally` so an early throw (an
    // interrupted capture) can't leave autosave wedged off.
    this.registry.suspendSaves();
    try {
    // ── Live files: untracked → create, content drifted → update ─────────────
    const live = this.files.list();
    const total = live.length;
    let scanned = 0;
    for (const ref of live) {
      if (onProgress && ++scanned % CAPTURE_PROGRESS_EVERY === 0) onProgress(scanned, total);
      const path = ref.path;
      if (this.isExcluded(path)) continue;
      onDisk.add(path);

      const entry = this.registry.getByPath(path);

      // ── O1 stat gate ─────────────────────────────────────────────────────────
      // A tracked file whose on-disk mtime AND size are unchanged since we last
      // hashed it cannot have changed content — so skip the read, the hash, and the
      // content-store put entirely. This is what turns the drift scan that runs
      // before EVERY sync from O(F) into O(touched): the headline win.
      //
      // TRADE-OFF (docs/capture-optimization-spec.md §3): `mtime + size` is a
      // heuristic. An *offline* edit that leaves BOTH the size and the mtime
      // bit-for-bit unchanged would be missed here and never sync. This is the exact
      // fast-path rsync/git/Obsidian-sync rely on, and it is safe because every
      // *online* edit is caught by the `modify` event independent of this gate — the
      // gate only decides whether to re-hash on a cold pass. **Rebuild sync
      // metadata** forces a full re-hash for anyone who suspects a missed edit.
      if (entry && entry.mtime === ref.mtime && entry.size === ref.size) continue;

      const content = await this.files.read(path);
      if (content === null) continue;
      const hash = await hashContent(content);

      if (entry && entry.contentHash === hash) {
        // Content is unchanged but the stat drifted (a sync wrote this file, or the
        // entry predates the gate / was adopted from a peer without a local stat).
        // Record the fresh stat so the gate elides this file next pass — no op,
        // nothing changed. Self-heals a stale/absent mtime in a single re-hash.
        if (entry.mtime !== ref.mtime || entry.size !== ref.size) {
          await this.registry.recordStat(path, ref.mtime, ref.size);
        }
        continue;
      }

      await this.contentStore.put(hash, content);
      const hlcTs = this.hlc.now();

      if (!entry) {
        const id = await this.registry.registerFile(path, hlcTs, hash, ref);
        const op = Ops.create(id, path, hash, hlcTs);
        this.pendingOps.push(op);
        await this.registry.setHeadVersion(id, op.id);
      } else {
        // A drifted hash means either a placeholder from an older op-less
        // reconcile ('') or an edit made while the plugin was off. Either way
        // the op carries the current content, so peers converge; `create` when
        // it was never really captured (no prior content), `update` otherwise.
        // The update's causal parent is the file's current HEAD VERSION (op-id),
        // captured before setHeadVersion advances it — NOT the prior content hash.
        const wasPlaceholder = entry.contentHash === '';
        const parentVersion = entry.headVersionId ?? undefined;
        await this.registry.updateContentHash(path, hash, hlcTs, ref);
        const op = wasPlaceholder
          ? Ops.create(entry.id, path, hash, hlcTs)
          : Ops.update(entry.id, path, hash, hlcTs, parentVersion);
        this.pendingOps.push(op);
        await this.registry.setHeadVersion(entry.id, op.id);
      }
      changed = true;

      // Crash-safety + memory checkpoint (every N emitted ops). Persist the batched
      // registry FIRST, then the oplog, so on-disk the registry is never behind the
      // oplog — a crash in the gap strands files (registry ahead; recoverable via
      // rebaseline), never orphans ops (oplog ahead, referencing unregistered files).
      // Without this, an interrupted capture on a large mobile vault (OOM at the GC
      // cliff) left the registry marking files "captured" while their ops were never
      // journalled — they skip re-capture on the `entry.contentHash === hash` guard
      // and never sync. Bounds that loss to <N and keeps the live pending count fresh.
      // Then drop the in-memory content cache: every blob is already on disk
      // (contentStore.put), so a later read re-loads it — this keeps the pass from
      // accumulating the whole vault's content in RAM.
      if (++sinceCheckpoint >= CAPTURE_CHECKPOINT_EVERY) {
        await this.registry.flush();
        await this.saveOpLog();
        this.contentStore.clearMemCache();
        sinceCheckpoint = 0;
      }
    }
    // Final tick so the last (sub-batch) files register in the progress log.
    if (onProgress && total > 0) onProgress(total, total);

    // ── Registry entries whose file vanished while offline → delete ──────────
    // Guard against a phantom mass-delete. `files.list()` can come back empty
    // (Obsidian's `getFiles()` is not reliably populated during the cold-start
    // window, before the vault index fills in). If we trusted that empty listing,
    // EVERY tracked file would look "vanished while offline" and we'd emit a
    // delete op for the whole vault and push it to every peer — a catastrophic
    // silent divergence (a peer then trashes real data, or it resurfaces as a
    // delete/modify conflict). An empty listing while the registry still holds
    // active, non-excluded entries means the listing is untrustworthy, not the
    // vault genuinely emptied: skip the deletion pass entirely. A real offline
    // delete re-propagates on a later capture once the listing is reliable —
    // deferring a delete is always safe, emitting a phantom one is not (G13: for
    // a data-safety tool, bias against the destructive false positive). main.ts
    // also defers this call to `onLayoutReady` to keep the listing populated.
    const activeEntries = this.registry
      .getActiveEntries()
      .filter(entry => !this.isExcluded(entry.path));
    if (onDisk.size === 0 && activeEntries.length > 0) {
      console.warn(
        `[vault-sync] captureOfflineChanges: vault listing came back empty while ` +
          `${activeEntries.length} file(s) are still tracked — treating the listing ` +
          `as not-yet-ready and skipping delete detection this pass (phantom-delete guard).`,
      );
    } else {
      for (const entry of activeEntries) {
        if (onDisk.has(entry.path)) continue;
        const hlcTs = this.hlc.now();
        await this.registry.markDeleted(entry.path, hlcTs);
        // A never-captured placeholder ('' hash) was never synced to any peer, so
        // its deletion is a local-only tombstone — emitting a delete op would leak
        // the '' sentinel and reference content no peer holds (audit G).
        if (entry.contentHash === '') continue;
        const op = Ops.delete(entry.id, entry.path, entry.contentHash, hlcTs, entry.headVersionId ?? undefined);
        this.pendingOps.push(op);
        await this.registry.setHeadVersion(entry.id, op.id);
        changed = true;
      }
    }

    // Successful end: persist the tail (registry first, then oplog — same ordering
    // as the checkpoint). On an early throw we skip this and fall to the `finally`,
    // leaving disk at the last checkpoint (registry and oplog consistent there).
    await this.registry.flush();
    if (changed) await this.saveOpLog();
    } finally {
      this.registry.resumeSaves();
    }
  }

  /**
   * Re-baseline this device to the server (S4): emit a pending op carrying the
   * *current* content of EVERY live, non-excluded file — even one whose registry
   * hash already matches. This is the deliberate difference from
   * {@link captureOfflineChanges}, which skips unchanged files: a baseline must
   * (re)assert every file so a server that has lost or never received them is
   * fully reconstructed from this client. The user has confirmed this device is
   * authoritative, so its version wins the merge on peers (last-writer-wins by the
   * fresh HLC each op is stamped with).
   *
   * Non-destructive: reads the vault, never writes it. Idempotent at the registry
   * level — `registerFile` returns the existing id rather than minting a duplicate,
   * and `updateContentHash` is a no-op when nothing drifted. Tombstoned (deleted)
   * entries are intentionally not re-emitted; a baseline asserts what exists now.
   * Run it, then a normal sync round uploads the blobs + appends the ops (the
   * append is idempotent by `clientOpId`, so a retried round can't duplicate).
   */
  async captureAllAsBaseline(): Promise<void> {
    let changed = false;

    for (const ref of this.files.list()) {
      const path = ref.path;
      if (this.isExcluded(path)) continue;

      const content = await this.files.read(path);
      if (content === null) continue;
      const hash = await hashContent(content);
      await this.contentStore.put(hash, content);

      const entry = this.registry.getByPath(path);
      const hlcTs = this.hlc.now();

      if (!entry) {
        const id = await this.registry.registerFile(path, hlcTs, hash, ref);
        const op = Ops.create(id, path, hash, hlcTs);
        this.pendingOps.push(op);
        await this.registry.setHeadVersion(id, op.id);
      } else {
        // Capture whether this was a never-synced placeholder *before* correcting
        // the registry (updateContentHash mutates the entry object in place), so
        // we still emit a `create` — not an `update` referencing content no peer
        // holds — for a file that was only ever a reconcile placeholder (audit G).
        const wasPlaceholder = entry.contentHash === '';
        const parentVersion = entry.headVersionId ?? undefined; // the update's causal parent = current head version
        if (entry.contentHash !== hash) {
          await this.registry.updateContentHash(path, hash, hlcTs, ref);
        }
        const op = wasPlaceholder
          ? Ops.create(entry.id, path, hash, hlcTs)
          : Ops.update(entry.id, path, hash, hlcTs, parentVersion);
        this.pendingOps.push(op);
        // A baseline re-asserts the head even when content was unchanged: the op
        // is a fresh version and its id becomes this file's head.
        await this.registry.setHeadVersion(entry.id, op.id);
      }
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

    // No stat is threaded from the live create event (the watcher forwards a bare
    // path), so the entry's gate cache is left absent — the next capture re-hashes
    // this one file once and self-heals it. Cheap: a just-created file is a
    // "touched" file the O(touched) budget already accounts for.
    const id = await this.registry.registerFile(path, hlcTs, hash);
    await this.contentStore.put(hash, content);

    const op = Ops.create(id, path, hash, hlcTs);
    await this.recordOp(op);
    await this.registry.setHeadVersion(id, op.id);
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

    // ── Resolving a two-headed (conflict-marked) file (sync v2 Step 5) ──────────
    // A text conflict was written to this path as inline zdiff3 markers, leaving the
    // file two-headed (`conflictParents` = the two open heads). This save is the
    // user's resolution attempt:
    //   · still contains markers → not resolved yet; track the new bytes so we don't
    //     reprocess, surface a non-blocking notice, and emit NO op (stay two-headed).
    //   · markers gone → resolved; re-emit as a two-parent MERGE NODE whose parents
    //     are exactly the two heads at conflict time, so peers holding either side
    //     fast-forward onto it. Clears the two-headed marker.
    if (entry.conflictParents && entry.conflictParents.length >= 2) {
      const hlcTs = this.hlc.now();
      await this.contentStore.put(hash, content);
      await this.registry.updateContentHash(path, hash, hlcTs);
      if (hasConflictMarkers(new TextDecoder().decode(content))) {
        this.notifier?.info(`${path} still has conflict markers — resolve them and save to finish syncing`);
        return;
      }
      const parents = entry.conflictParents;
      const id = await mergeVersionId(hash, parents);
      const op = Ops.merge(entry.id, path, hash, hlcTs, parents, id);
      await this.recordOp(op);
      await this.registry.setHeadVersion(entry.id, id);
      await this.registry.clearConflict(entry.id);
      return;
    }

    // This update's causal parent is the file's current HEAD VERSION (op-id),
    // captured before setHeadVersion advances it — so a peer can reconstruct the
    // op-id DAG and fast-forward a sequential edit rather than three-way-merge
    // against a stale ancestor. NB: the parent is a version-id, not the prior
    // content hash (content recurs; a content-hash DAG cycles — decisions §3).
    const parentVersion = entry.headVersionId ?? undefined;
    const hlcTs = this.hlc.now();
    await this.contentStore.put(hash, content);
    await this.registry.updateContentHash(path, hash, hlcTs);

    const op = Ops.update(entry.id, path, hash, hlcTs, parentVersion);
    await this.recordOp(op);
    await this.registry.setHeadVersion(entry.id, op.id);
  }

  private async handleDelete(path: string): Promise<void> {
    if (this.isExcluded(path)) return;
    const entry = this.registry.getByPath(path);
    if (!entry) return;

    const hlcTs = this.hlc.now();
    await this.registry.markDeleted(path, hlcTs);

    // A never-captured placeholder ('' hash) was never synced — its delete is a
    // local-only tombstone; emitting an op would leak the '' sentinel (audit G).
    if (entry.contentHash === '') return;

    // A file created then deleted before any sync never reached a peer, so the
    // pair fully cancels: prune the un-synced create and emit NO delete op (a
    // tombstone op would reference a contentHash whose blob was never uploaded —
    // a phantom, audit-G-adjacent leak). The registry tombstone above still
    // stands. Persist the pruned log ourselves, since we skip `recordOp`.
    if (this.pruneCreateDeletePair(entry.id)) {
      await this.saveOpLog();
      return;
    }

    const op = Ops.delete(entry.id, path, entry.contentHash, hlcTs, entry.headVersionId ?? undefined);
    await this.recordOp(op);
    await this.registry.setHeadVersion(entry.id, op.id);
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

    // A never-captured placeholder ('' hash) has no synced content, so a move op
    // would carry the '' sentinel and propagate a phantom. Capture the file's
    // real content at its new path instead (emits a proper content op) (audit G).
    if (entry.contentHash === '') {
      await this.flushModify(path);
      return;
    }

    // Carry the current content head as the move's parent so a peer that projects
    // this renamed-but-unedited file reads its head as that content version (not
    // the move op id), keeping the DAG connected across the rename. The move does
    // not advance the head (it is not a new content version), so no setHeadVersion.
    await this.recordOp(Ops.move(entry.id, path, entry.contentHash, hlcTs, entry.headVersionId ?? undefined));
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
   * Record a clean-merge / resolution node as a pending op so it replicates (sync
   * v2). A clean three-way merge or a user-resolved conflict is produced *while
   * listeners are paused* and after the pending log is cleared, so it would
   * otherwise never become an op and never reach peers (they'd keep their own
   * version and diverge) — re-emit it here to survive as a pending op for the next
   * round's push. `parents` are the two reconciled version-ids and `id` is the
   * precomputed deterministic merge id (the applicator hashed the merged bytes to
   * derive it, and already set the head to it via `adoptRemote`; setting it again
   * here keeps this method self-contained and correct if called without that prior
   * step). The caller supplies an HLC that dominates the remote content being
   * reconciled, so the resolution wins last-writer-wins when peers pull it.
   */
  async recordMergeOp(fileId: string, path: string, contentHash: string, hlcTs: HLC, parents: string[], id: string): Promise<void> {
    const op = Ops.merge(fileId, path, contentHash, hlcTs, parents, id);
    await this.recordOp(op);
    await this.registry.setHeadVersion(fileId, id);
  }

  /**
   * Record a *tombstone* merge node — a delete/modify conflict the user resolved by
   * accepting the deletion (sync v2). The delete counterpart of {@link recordMergeOp}:
   * a two-parent `delete` op peers fast-forward onto instead of re-prompting.
   * Produced while listeners are paused and after the pending log is cleared, so it
   * must be re-emitted explicitly. `contentHash` is the now-deleted content.
   */
  async recordMergeDelete(fileId: string, path: string, contentHash: string, hlcTs: HLC, parents: string[], id: string): Promise<void> {
    const op = Ops.mergeDelete(fileId, path, contentHash, hlcTs, parents, id);
    await this.recordOp(op);
    await this.registry.setHeadVersion(fileId, id);
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
    // Notify observers that the pending set may have changed (UI status). Kept
    // last so the persisted state is durable before anyone reacts to it.
    this.changeListener?.();
  }

  /**
   * If a file was created then deleted before any sync, remove the create (and any
   * subsequent pending ops for it). They cancel out — remote never learned the file
   * existed. Returns whether a pending create was found and pruned, so the caller
   * knows to emit no delete op for the fully-cancelled pair.
   */
  private pruneCreateDeletePair(fileId: string): boolean {
    const hasPendingCreate = this.pendingOps.some(
      op => op.fileId === fileId && op.type === 'create',
    );
    if (!hasPendingCreate) return false;
    // Remove the create and all subsequent ops for this file.
    this.pendingOps = this.pendingOps.filter(op => op.fileId !== fileId);
    return true;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private isExcluded(path: string): boolean {
    return isExcluded(path, this.getSettings());
  }
}
