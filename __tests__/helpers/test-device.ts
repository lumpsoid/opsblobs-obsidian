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

import { FileEntry, Operation, MergeAction, SyncSettings, DEFAULT_SETTINGS } from '../../src/types';
import { HybridLogicalClock } from '../../src/core/hlc';
import { FileRegistry } from '../../src/core/file-registry';
import { ContentStore } from '../../src/core/content-store';
import { OperationLogger } from '../../src/core/operation-logger';
import { SyncApplicator } from '../../src/network/sync-applicator';
import { PluginVaultSyncHost } from '../../src/network/vault-sync-host';
import { CursorStore } from '../../src/network/cursor-store';
import { FakeVaultFiles } from './fakes/vault-files';
import { FakeMetadataStore } from './fakes/metadata-store';
import { FakeVaultWatcher } from './fakes/vault-watcher';

/** How a device resolves a text conflict surfaced during merge — returns the
 *  resolved bytes (a real user's modal choice), or null to skip it. */
export type ConflictResolver =
  (action: Extract<MergeAction, { type: 'conflict' }>) => Uint8Array | null;

/** How a device resolves a delete/modify(-or-rename) conflict. */
export type DeleteConflictResolver =
  (action: Extract<MergeAction, { type: 'delete_conflict' }>) => 'keep_deleted' | 'restore';

/** How a device resolves a concurrent binary-file conflict (whole-version pick). */
export type BinaryConflictResolver =
  (action: Extract<MergeAction, { type: 'binary_conflict' }>) => 'keep_local' | 'keep_remote';

export class TestDevice {
  readonly files = new FakeVaultFiles();
  readonly metadata = new FakeMetadataStore();
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

  /** The VaultSyncHost handed to a ServerSyncClient — the production wiring. */
  readonly host: PluginVaultSyncHost;

  /** When set, `conflict` actions are resolved with these bytes (default: skip,
   *  returning null) — a device's stand-in for the user's merge modal. */
  resolveConflict?: ConflictResolver;

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

  constructor(private deviceId: string) {
    const settings: SyncSettings = { ...DEFAULT_SETTINGS, deviceId };
    const getSettings = () => settings;

    this.hlc = new HybridLogicalClock(deviceId, undefined, () => this.clock.wall);
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
    );
    this.applicator = new SyncApplicator(
      this.files,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.hlc,
      async a => this.resolveConflict?.(a) ?? null,
      async a => this.resolveDeleteConflict?.(a) ?? 'keep_deleted',
      async a => this.resolveBinaryConflict?.(a) ?? 'keep_local',
    );
    this.cursorStore = new CursorStore(this.metadata);
    this.host = new PluginVaultSyncHost(
      this.files,
      deviceId,
      this.registry,
      this.contentStore,
      this.opLogger,
      this.applicator,
      this.hlc,
      this.cursorStore,
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
  static async create(deviceId: string): Promise<TestDevice> {
    const device = new TestDevice(deviceId);
    await device.init();
    return device;
  }

  /** Bring the content store online and start listening for vault events. */
  async init(): Promise<void> {
    await this.contentStore.init();
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
}
