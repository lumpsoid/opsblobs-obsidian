// ─────────────────────────────────────────────
//  Tests — SyncStateStore (S2 observable sync state)
// ─────────────────────────────────────────────
//
//  Round-trips through the fake MetadataStore (the same port prod uses), and
//  covers the guarantees the status surface relies on: a corrupt file loads as
//  empty (never throws), recordConflict dedupes by fileId, clearConflict removes,
//  and setRound/setError/clearError persist.

import { describe, test, expect } from 'vitest';
import { SyncStateStore } from '../src/network/sync-state-store';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const STATE_PATH = '.vault-sync/sync-state.json';

describe('SyncStateStore', () => {
  test('absent file loads as empty state', async () => {
    const store = new SyncStateStore(new FakeMetadataStore());
    const state = await store.load();
    expect(state.outstandingConflicts).toEqual([]);
    expect(state.deferred).toEqual([]);
    expect(state.stranded).toEqual([]);
    expect(state.lastError).toBeNull();
    expect(state.lastSync).toBeNull();
  });

  test('corrupt file loads as empty state (never throws)', async () => {
    const meta = new FakeMetadataStore();
    meta.set(STATE_PATH, '{ this is not valid json');
    const store = new SyncStateStore(meta);
    const state = await store.load();
    expect(state.outstandingConflicts).toEqual([]);
    expect(state.lastSync).toBeNull();
  });

  test('recordConflict persists and dedupes by fileId', async () => {
    const meta = new FakeMetadataStore();
    const store = new SyncStateStore(meta);
    await store.load();

    await store.recordConflict({ fileId: 'f1', path: 'a.md', kind: 'content', firstSeen: 100 });
    await store.recordConflict({ fileId: 'f1', path: 'a.md', kind: 'content', firstSeen: 200 }); // dup
    await store.recordConflict({ fileId: 'f2', path: 'b.md', kind: 'binary', firstSeen: 300 });

    expect(store.get().outstandingConflicts).toHaveLength(2);
    // The first-seen time of f1 is not overwritten by the re-record.
    expect(store.get().outstandingConflicts.find(c => c.fileId === 'f1')!.firstSeen).toBe(100);

    // Survives a reload through the store (persisted).
    const reloaded = await new SyncStateStore(meta).load();
    expect(reloaded.outstandingConflicts).toHaveLength(2);
  });

  test('clearConflict removes only the named file', async () => {
    const store = new SyncStateStore(new FakeMetadataStore());
    await store.load();
    await store.recordConflict({ fileId: 'f1', path: 'a.md', kind: 'content', firstSeen: 1 });
    await store.recordConflict({ fileId: 'f2', path: 'b.md', kind: 'content', firstSeen: 2 });

    await store.clearConflict('f1');
    expect(store.get().outstandingConflicts.map(c => c.fileId)).toEqual(['f2']);
    // Clearing an absent id is a harmless no-op.
    await store.clearConflict('nope');
    expect(store.get().outstandingConflicts).toHaveLength(1);
  });

  test('setRound records the summary and replaces deferred/stranded', async () => {
    const meta = new FakeMetadataStore();
    const store = new SyncStateStore(meta);
    await store.load();

    await store.setRound(
      { at: 5000, pushed: 3, pulled: 2, conflicts: 1 },
      [{ fileId: 'f1', path: 'a.md', reason: 'drift', at: 5000 }],
      [{ contentHash: 'deadbeef', at: 5000 }],
    );
    expect(store.get().lastSync).toEqual({ at: 5000, pushed: 3, pulled: 2, conflicts: 1 });
    expect(store.get().deferred).toHaveLength(1);
    expect(store.get().stranded.map(s => s.contentHash)).toContain('deadbeef');

    // A subsequent round replaces (not appends) the transient lists.
    await store.setRound({ at: 6000, pushed: 0, pulled: 0, conflicts: 0 }, [], []);
    expect(store.get().deferred).toEqual([]);
    expect(store.get().stranded).toEqual([]);

    const reloaded = await new SyncStateStore(meta).load();
    expect(reloaded.lastSync!.at).toBe(6000);
  });

  test('setError / clearError round-trip', async () => {
    const store = new SyncStateStore(new FakeMetadataStore());
    await store.load();
    await store.setError('boom', 9000);
    expect(store.get().lastError).toEqual({ message: 'boom', at: 9000 });
    await store.clearError();
    expect(store.get().lastError).toBeNull();
  });
});
