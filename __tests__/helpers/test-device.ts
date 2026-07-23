// ─────────────────────────────────────────────
//  TestDevice — the REAL device stack wired over fakes
// ─────────────────────────────────────────────
//
//  Instead of re-implementing the merge-application logic in a test double, this
//  wires the production classes (FileRegistry, ContentStore,
//  OperationLogger, SyncApplicator, PluginVaultSyncHost, CursorStore) over the
//  in-memory fakes (FakeVaultFiles/MetadataStore/VaultWatcher) plus a settable
//  wall clock, so a test drives the genuine sync device deterministically.
//
//  The user-action helpers (seedFile/editFile/deleteFile/renameFile) exercise
//  the real OperationLogger path — id assignment, hashing, op emission — through
//  synthetic vault events, so tests never hand-build ops or ids.

import { FileEntry, Operation, MergeAction, HLC, SyncSettings, DEFAULT_SETTINGS } from '../../src/types';
import { HybridLogicalClock } from '../../src/core/hlc';
import { FileRegistry } from '../../src/core/file-registry';
import { ContentStore } from '../../src/core/content-store';
import { OperationLogger } from '../../src/core/operation-logger';
import { SyncApplicator, DeferConflict } from '../../src/network/sync-applicator';
import { PluginVaultSyncHost } from '../../src/network/vault-sync-host';
import { CursorStore } from '../../src/network/cursor-store';
import { VersionDagStore } from '../../src/network/version-dag-store';
import { HlcStore } from '../../src/network/hlc-store';
import { FakeVaultFiles } from './fakes/vault-files';
import { FakeMetadataStore } from './fakes/metadata-store';
import { FakeVaultWatcher } from './fakes/vault-watcher';

/** Construction knobs. Omitted → a fresh, empty device (the common case). `reload`
 *  passes the surviving `files`/`metadata` + the persisted HLC to model a restart. */
export interface TestDeviceOptions {
  /** Reuse an existing vault (persisted bytes survive a restart). */
  files?: FakeVaultFiles;
  /** Reuse existing `.vault-sync/*` metadata (registry/oplog/cursor/HLC survive). */
  metadata?: FakeMetadataStore;
  /** Seed the HLC from persisted logical time so it can't regress across a restart. */
  seedHlc?: HLC;
  /** Restore the wall clock so time continues from where the prior instance left off. */
  wall?: number;
}

/** How a device resolves a delete/modify(-or-rename) conflict. */
export type DeleteConflictResolver =
  (action: Extract<MergeAction, { type: 'delete_conflict' }>) => 'keep_deleted' | 'keep_modified' | DeferConflict;

/** How a device resolves a concurrent binary-file conflict (whole-version pick). */
export type BinaryConflictResolver =
  (action: Extract<MergeAction, { type: 'binary_conflict' }>) => 'keep_local' | 'keep_remote' | DeferConflict;

export class TestDevice {
  readonly files: FakeVaultFiles;
  readonly metadata: FakeMetadataStore;
  /** A restart gets a FRESH watcher (the prior instance's is defunct); the vault
   *  bytes + metadata are what actually survive. */
  readonly watcher = new FakeVaultWatcher();

  /** Settable wall clock feeding the real HLC — a user action "at wall = n"
   *  reproduces the exact HLC scenarios the suite relies on. */
  private clock = { wall: 0 };
  setWall(n: number): void { this.clock.wall = n; }

  readonly hlc: HybridLogicalClock;
  readonly registry: FileRegistry;
  readonly contentStore: ContentStore;
  readonly opLogger: OperationLogger;
  readonly applicator: SyncApplicator;
  readonly cursorStore: CursorStore;
  /** The persisted content version-DAG store (sync v2), over the same fakes as the
   *  rest of the stack — a test can `load()` it to assert accumulated parent edges. */
  readonly versionDagStore: VersionDagStore;
  /** Persists logical time per-op (mirrors production), so a `reload()` can seed
   *  the HLC from disk and logical time never regresses across the restart (F7). */
  readonly hlcStore: HlcStore;

  /** The VaultSyncHost handed to a ServerSyncClient — the production wiring. */
  readonly host: PluginVaultSyncHost;

  /** Non-blocking notices the op-logger surfaced (e.g. "still has conflict markers",
   *  sync v2 Step 5) — captured so a test can assert the user was told. */
  readonly notices: string[] = [];

  /** When set, `delete_conflict` actions use this decision (default:
   *  'keep_deleted') — a device's stand-in for the delete-conflict modal. */
  resolveDeleteConflict?: DeleteConflictResolver;

  /** When set, `binary_conflict` actions use this decision (default:
   *  'keep_local') — a device's stand-in for the binary-conflict modal. */
  resolveBinaryConflict?: BinaryConflictResolver;

  /** Every merge action applied across all rounds, in order — the real merge's
   *  decisions (conflict / write_local / delete_local / …), captured so a test
   *  can assert which decision the genuine `mergeVaultStates` produced. */
  readonly applied: MergeAction[] = [];

  constructor(private deviceId: string, opts: TestDeviceOptions = {}) {
    // Reuse the caller's fakes on a reload (persisted state survives) or start fresh.
    this.files = opts.files ?? new FakeVaultFiles();
    this.metadata = opts.metadata ?? new FakeMetadataStore();
    if (opts.wall !== undefined) this.clock.wall = opts.wall;

    const settings: SyncSettings = { ...DEFAULT_SETTINGS, deviceId };
    const getSettings = () => settings;

    // Seed from the persisted HLC (F7) exactly as main.ts::onload does.
    this.hlc = new HybridLogicalClock(deviceId, opts.seedHlc, () => this.clock.wall);
    this.hlcStore = new HlcStore(this.metadata);
    this.registry = new FileRegistry(this.metadata, this.files, deviceId, getSettings);
    this.contentStore = new ContentStore(this.metadata);
    this.opLogger = new OperationLogger(
      this.files,
      this.watcher,
      this.metadata,
      this.hlc,
      this.registry,
      this.contentStore,
      getSettings,
      0, // debounceMs 0 — a modify's op is available right after flush()
      this.hlcStore, // persist HLC per-op so reload() can restore logical time
      // Capture the non-blocking "still has conflict markers" notice (Step 5).
      { info: (m: string) => this.notices.push(m), error: () => {}, setupError: () => {} },
    );
    this.applicator = new SyncApplicator(
      this.files,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.hlc,
      async a => this.resolveDeleteConflict?.(a) ?? 'keep_deleted',
      async a => this.resolveBinaryConflict?.(a) ?? 'keep_local',
    );
    this.cursorStore = new CursorStore(this.metadata);
    this.versionDagStore = new VersionDagStore(this.metadata);
    this.host = new PluginVaultSyncHost(
      this.files,
      deviceId,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.applicator,
      this.hlc,
      this.cursorStore,
      this.versionDagStore,
    );

    // Record the merge actions each round applies, delegating to the real host.
    // The actions are the genuine output of `mergeVaultStates`, so tests assert
    // real merge decisions without the host having to expose an internal log.
    const applyMerge = this.host.applyMerge.bind(this.host);
    this.host.applyMerge = async (actions, local, remote) => {
      this.applied.push(...actions);
      return applyMerge(actions, local, remote);
    };
  }

  /** Construct and initialise a device in one step (async ctor sugar). */
  static async create(deviceId: string, opts: TestDeviceOptions = {}): Promise<TestDevice> {
    const device = new TestDevice(deviceId, opts);
    await device.init();
    return device;
  }

  /**
   * Model a plugin restart / crash-recovery: build a NEW device stack over the
   * SAME vault bytes + `.vault-sync/*` metadata as this one, seeded from the
   * persisted HLC. Everything durable (registry, oplog, cursor, sync-state, logical
   * time) survives; all in-memory-only state is dropped — so a test can assert that
   * a round which crashed mid-flight recovers from what actually reached disk.
   *
   * The returned device is the live one; `this` is defunct after a reload (its
   * watcher still references stale handlers — don't drive it further).
   */
  async reload(): Promise<TestDevice> {
    const persistedHlc = await this.hlcStore.load();
    return TestDevice.create(this.deviceId, {
      files: this.files,
      metadata: this.metadata,
      seedHlc: persistedHlc ?? undefined,
      wall: this.clock.wall,
    });
  }

  /** Bring the stores online — loading any persisted registry/oplog (empty on a
   *  fresh device, restored on a reload) — and start listening for vault events.
   *  Mirrors the load sequence in main.ts::onload. */
  async init(): Promise<void> {
    await this.contentStore.init();
    await this.registry.load();
    await this.opLogger.load();
    this.opLogger.startListening();
  }

  // ─── Read accessors the suite needs ─────────────────────────────────────────

  entry(id: string): FileEntry | undefined {
    return this.registry.getById(id);
  }

  entryByPath(path: string): FileEntry | undefined {
    return this.registry.getByPath(path);
  }

  /** All live (non-deleted) registry entries — thin read over the real registry. */
  activeEntries(): FileEntry[] {
    return this.registry.getActiveEntries();
  }

  /** Every registry entry (including tombstones), keyed by file id. */
  allEntries(): Map<string, FileEntry> {
    return this.registry.getAllEntries();
  }

  async content(hash: string): Promise<Uint8Array | null> {
    return this.contentStore.get(hash);
  }

  get pendingOps(): Operation[] {
    return this.opLogger.getPendingOps();
  }

  async cursor(): Promise<number> {
    return this.cursorStore.load();
  }

  // ─── User-action helpers (drive the real OperationLogger path) ───────────────

  /** Create a new file and let the real create-handler assign its id + op. */
  async seedFile(path: string, text: string, wall: number): Promise<string> {
    this.setWall(wall);
    await this.files.write(path, new TextEncoder().encode(text));
    await this.watcher.emitCreate(path);
    return this.registry.getByPath(path)!.id;
  }

  /** Edit an already-tracked file; flush so its update op exists immediately. */
  async editFile(path: string, text: string, wall: number): Promise<void> {
    this.setWall(wall);
    await this.files.write(path, new TextEncoder().encode(text));
    this.watcher.emitModify(path);
    await this.opLogger.flush();
  }

  /** Delete an already-tracked file (real delete-handler tombstones + ops it). */
  async deleteFile(path: string, wall: number): Promise<void> {
    this.setWall(wall);
    await this.files.trash(path);
    await this.watcher.emitDelete(path);
  }

  /** Create a new binary file (raw bytes — include a null byte to trip the
   *  merge's binary sniff) and let the real create-handler assign its id + op. */
  async seedBinary(path: string, bytes: Uint8Array, wall: number): Promise<string> {
    this.setWall(wall);
    await this.files.write(path, bytes);
    await this.watcher.emitCreate(path);
    return this.registry.getByPath(path)!.id;
  }

  /** Edit an already-tracked binary file; flush so its update op exists now. */
  async editBinary(path: string, bytes: Uint8Array, wall: number): Promise<void> {
    this.setWall(wall);
    await this.files.write(path, bytes);
    this.watcher.emitModify(path);
    await this.opLogger.flush();
  }

  /** Rename an already-tracked file (real rename-handler moves + ops it). */
  async renameFile(from: string, to: string, wall: number): Promise<void> {
    this.setWall(wall);
    await this.files.move(from, to);
    await this.watcher.emitRename(to, from);
  }

  /** Rename a tracked file AND change its content in one logical step (H5) —
   *  a move op followed by an update op at the new path, both via the real
   *  handlers. Models a user renaming a note and editing it before syncing. */
  async renameAndEdit(from: string, to: string, text: string, wall: number): Promise<void> {
    this.setWall(wall);
    await this.files.move(from, to);
    await this.watcher.emitRename(to, from);
    await this.files.write(to, new TextEncoder().encode(text));
    this.watcher.emitModify(to);
    await this.opLogger.flush();
  }

  /** Place a file in the vault WITHOUT emitting a create event or registering it —
   *  models a file that existed before the plugin's listeners attached (no `create`
   *  fires for pre-existing files). Exercise the cold-start path by then calling
   *  `opLogger.captureOfflineChanges()` (H10). Contrast with `seedFile`. */
  async seedExistingFile(path: string, text: string): Promise<void> {
    await this.files.write(path, new TextEncoder().encode(text));
  }
}
