// ─────────────────────────────────────────────
//  Shared in-memory test doubles for the sync client
// ─────────────────────────────────────────────
//
//  A VaultSyncHost backed by plain Maps that also applies merge actions to its
//  own state, so a simulated device converges across successive sync rounds.
//  Used by both the unit tests (against FakeSyncServer) and the client↔server
//  contract suite (against the real Go server), so the two exercise identical
//  device behaviour.

import { VaultState, FileEntry, MergeAction, Operation, HLC } from '../../src/types';
import { VaultSyncHost } from '../../src/network/server-sync';
import { hlcMax } from '../../src/core/hlc';

/** How a device resolves a text conflict surfaced during merge. Returns the
 *  resolved bytes (as a real user's modal choice would). */
export type ConflictResolver = (action: Extract<MergeAction, { type: 'conflict' }>) => Uint8Array;

/** An HLC that strictly dominates both inputs — what the client's clock holds
 *  after `setCurrent(mergedHlc)` + `now()`, so a resolution wins on peers. */
function dominatingHlc(a: HLC, b: HLC, deviceId: string): HLC {
  const base = hlcMax(a, b);
  return { wallTime: base.wallTime, counter: base.counter + 1, deviceId };
}

export async function sha256Hex(content: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', content as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** An in-memory VaultSyncHost that also applies merge actions to its own state,
 *  so a device converges across successive rounds. */
export class MemoryHost implements VaultSyncHost {
  fileEntries = new Map<string, FileEntry>();
  content = new Map<string, Uint8Array>();   // retained content store (by hash; ancestors etc.)
  pendingOps: Operation[] = [];
  cursor = 0;
  applied: MergeAction[] = [];

  /** Current on-"disk" bytes per fileId, modelling what a device's files
   *  actually hold — kept separate from the hash-keyed content store, exactly as
   *  the vault (files) is separate from the ContentStore in production. When a
   *  fileId has no override the retained content under its registry hash is used.
   *  A divergent override models an edit not yet logged as an op. */
  disk = new Map<string, Uint8Array>();

  /** When set, `conflict` actions are resolved with these bytes and re-emitted
   *  as an op — mirroring SyncApplicator's production behaviour. Unset devices
   *  leave a conflict unresolved (as if the modal was dismissed). */
  resolveConflict?: ConflictResolver;

  constructor(private deviceId: string) {}

  async buildLocalState(): Promise<VaultState> {
    const fileEntries = new Map<string, FileEntry>();
    const contentStore = new Map(this.content); // retained content (ancestors, history)

    for (const [id, entry] of this.fileEntries) {
      let resolved = entry;
      if (!entry.deleted) {
        // Mirror the fixed PluginVaultSyncHost.buildLocalState: read the current
        // file bytes and key them under their *real* hash, never the (possibly
        // stale) registry hash — so a not-yet-logged edit can't alias its bytes
        // over the ancestor and vanish in the merge.
        const bytes = this.disk.get(id) ?? this.content.get(entry.contentHash);
        if (bytes) {
          const hash = await sha256Hex(bytes);
          if (hash !== entry.contentHash) resolved = { ...entry, contentHash: hash };
          contentStore.set(hash, bytes);
        }
      }
      fileEntries.set(id, resolved);
    }

    return {
      deviceId: this.deviceId,
      hlc: { wallTime: 0, counter: 0, deviceId: this.deviceId },
      fileEntries,
      pendingOps: [...this.pendingOps],
      contentStore,
    };
  }

  async applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<void> {
    this.applied.push(...actions);
    for (const a of actions) {
      if (a.type === 'write_local') {
        const hash = await sha256Hex(a.content);
        this.content.set(hash, a.content);
        this.disk.set(a.fileId, a.content);
        this.fileEntries.set(a.fileId, {
          id: a.fileId, path: a.path, contentHash: hash,
          hlcTimestamp: a.hlc, deleted: false, ancestorContentHash: hash,
        });
      } else if (a.type === 'delete_local') {
        const e = this.fileEntries.get(a.fileId);
        if (e) this.fileEntries.set(a.fileId, { ...e, deleted: true });
        this.disk.delete(a.fileId);
      } else if (a.type === 'move_local') {
        // Mirror SyncApplicator.moveLocalFile: the file id is unchanged, only its
        // path moves to the winning side's path.
        const e = this.fileEntries.get(a.fileId);
        if (e) this.fileEntries.set(a.fileId, { ...e, path: a.toPath });
      } else if (a.type === 'conflict' && this.resolveConflict) {
        // Mirror SyncApplicator: resolve, advance to the resolved content, and
        // re-emit it as an op (clearPendingOps already ran this round, so this
        // pending op belongs to the next round and replicates the resolution).
        const resolved = this.resolveConflict(a);
        const hash = await sha256Hex(resolved);
        // The resolution must dominate BOTH conflicting sides — in production the
        // monotonic clock guarantees `hlc.now()` exceeds the device's own prior
        // edit (which `local.hlc` here, hardcoded {0,0}, doesn't reflect). Derive
        // it from the two entries' timestamps so the resolution out-ranks them and
        // wins the latest-by-HLC projection on peers.
        const leTs = local.fileEntries.get(a.fileId)?.hlcTimestamp ?? local.hlc;
        const reTs = remote.fileEntries.get(a.fileId)?.hlcTimestamp ?? remote.hlc;
        const hlc = dominatingHlc(leTs, reTs, this.deviceId);
        this.content.set(hash, resolved);
        this.disk.set(a.fileId, resolved);
        this.fileEntries.set(a.fileId, {
          id: a.fileId, path: a.localPath, contentHash: hash,
          hlcTimestamp: hlc, deleted: false, ancestorContentHash: hash,
        });
        this.pendingOps.push({
          id: `${this.deviceId}-resolve-${a.fileId}-${hash.slice(0, 12)}`,
          deviceId: this.deviceId, hlcTimestamp: hlc, fileId: a.fileId,
          type: 'update', path: a.localPath, contentHash: hash,
          // Mirror SyncApplicator: tag the resolution with the sides it settles
          // so peers holding either adopt it instead of re-prompting.
          supersedes: a.parentHashes,
        });
      }
    }
  }

  async clearPendingOps(): Promise<void> { this.pendingOps = []; }
  async loadCursor(): Promise<number> { return this.cursor; }
  async saveCursor(c: number): Promise<void> { this.cursor = c; }
}

/** Seed a host with one freshly-created file + its pending create op. */
export async function seedFile(
  host: MemoryHost, deviceId: string, fileId: string, path: string, text: string, wall: number,
): Promise<{ hash: string }> {
  const content = new TextEncoder().encode(text);
  const hash = await sha256Hex(content);
  const hlc: HLC = { wallTime: wall, counter: 0, deviceId };
  host.content.set(hash, content);
  host.disk.set(fileId, content);
  host.fileEntries.set(fileId, { id: fileId, path, contentHash: hash, hlcTimestamp: hlc, deleted: false, ancestorContentHash: null });
  host.pendingOps.push({ id: `${deviceId}-op-${fileId}`, deviceId, hlcTimestamp: hlc, fileId, type: 'create', path, contentHash: hash });
  return { hash };
}

/** Edit an already-tracked file: update its content + entry and queue a pending
 *  `update` op (models a user editing a file that is already in sync). The
 *  ancestor hash is left intact — it stays the last mutually-synced base. */
export async function editFile(
  host: MemoryHost, deviceId: string, fileId: string, path: string, text: string, wall: number,
): Promise<{ hash: string }> {
  const content = new TextEncoder().encode(text);
  const hash = await sha256Hex(content);
  const hlc: HLC = { wallTime: wall, counter: 0, deviceId };
  host.content.set(hash, content);
  host.disk.set(fileId, content);
  const entry = host.fileEntries.get(fileId)!;
  host.fileEntries.set(fileId, { ...entry, path, contentHash: hash, hlcTimestamp: hlc });
  host.pendingOps.push({ id: `${deviceId}-edit-${fileId}-${wall}`, deviceId, hlcTimestamp: hlc, fileId, type: 'update', path, contentHash: hash });
  return { hash };
}

/** Delete an already-tracked file: tombstone its entry and queue a pending
 *  `delete` op (models a user deleting a file that is already in sync). Content
 *  is left in the store; a delete op carries no blob. */
export function deleteFile(
  host: MemoryHost, deviceId: string, fileId: string, path: string, wall: number,
): void {
  const hlc: HLC = { wallTime: wall, counter: 0, deviceId };
  const entry = host.fileEntries.get(fileId)!;
  host.fileEntries.set(fileId, { ...entry, deleted: true, hlcTimestamp: hlc });
  host.disk.delete(fileId);
  host.pendingOps.push({ id: `${deviceId}-del-${fileId}-${wall}`, deviceId, hlcTimestamp: hlc, fileId, type: 'delete', path, contentHash: entry.contentHash });
}

/** Rename an already-tracked file: move its path with the content unchanged and
 *  queue a pending `move` op (models a user renaming a file that is in sync). The
 *  content hash and ancestor are untouched — only the path changes. */
export function renameFile(
  host: MemoryHost, deviceId: string, fileId: string, fromPath: string, toPath: string, wall: number,
): void {
  const hlc: HLC = { wallTime: wall, counter: 0, deviceId };
  const entry = host.fileEntries.get(fileId)!;
  host.fileEntries.set(fileId, { ...entry, path: toPath, hlcTimestamp: hlc });
  host.pendingOps.push({ id: `${deviceId}-mv-${fileId}-${wall}`, deviceId, hlcTimestamp: hlc, fileId, type: 'move', path: toPath, contentHash: entry.contentHash, previousPath: fromPath });
}
