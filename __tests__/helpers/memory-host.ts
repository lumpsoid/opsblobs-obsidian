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
  content = new Map<string, Uint8Array>();
  pendingOps: Operation[] = [];
  cursor = 0;
  applied: MergeAction[] = [];

  /** When set, `conflict` actions are resolved with these bytes and re-emitted
   *  as an op — mirroring SyncApplicator's production behaviour. Unset devices
   *  leave a conflict unresolved (as if the modal was dismissed). */
  resolveConflict?: ConflictResolver;

  constructor(private deviceId: string) {}

  async buildLocalState(): Promise<VaultState> {
    return {
      deviceId: this.deviceId,
      hlc: { wallTime: 0, counter: 0, deviceId: this.deviceId },
      fileEntries: new Map(this.fileEntries),
      pendingOps: [...this.pendingOps],
      contentStore: new Map(this.content),
    };
  }

  async applyMerge(actions: MergeAction[], local: VaultState, remote: VaultState): Promise<void> {
    this.applied.push(...actions);
    for (const a of actions) {
      if (a.type === 'write_local') {
        const hash = await sha256Hex(a.content);
        this.content.set(hash, a.content);
        this.fileEntries.set(a.fileId, {
          id: a.fileId, path: a.path, contentHash: hash,
          hlcTimestamp: a.hlc, deleted: false, ancestorContentHash: hash,
        });
      } else if (a.type === 'delete_local') {
        const e = this.fileEntries.get(a.fileId);
        if (e) this.fileEntries.set(a.fileId, { ...e, deleted: true });
      } else if (a.type === 'conflict' && this.resolveConflict) {
        // Mirror SyncApplicator: resolve, advance to the resolved content, and
        // re-emit it as an op (clearPendingOps already ran this round, so this
        // pending op belongs to the next round and replicates the resolution).
        const resolved = this.resolveConflict(a);
        const hash = await sha256Hex(resolved);
        const hlc = dominatingHlc(local.hlc, remote.hlc, this.deviceId);
        this.content.set(hash, resolved);
        this.fileEntries.set(a.fileId, {
          id: a.fileId, path: a.localPath, contentHash: hash,
          hlcTimestamp: hlc, deleted: false, ancestorContentHash: hash,
        });
        this.pendingOps.push({
          id: `${this.deviceId}-resolve-${a.fileId}-${hash.slice(0, 12)}`,
          deviceId: this.deviceId, hlcTimestamp: hlc, fileId: a.fileId,
          type: 'update', path: a.localPath, contentHash: hash,
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
  const entry = host.fileEntries.get(fileId)!;
  host.fileEntries.set(fileId, { ...entry, path, contentHash: hash, hlcTimestamp: hlc });
  host.pendingOps.push({ id: `${deviceId}-edit-${fileId}-${wall}`, deviceId, hlcTimestamp: hlc, fileId, type: 'update', path, contentHash: hash });
  return { hash };
}
