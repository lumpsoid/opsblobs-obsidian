// ─────────────────────────────────────────────
//  Tests — SyncStateStore (S2 observable sync state)
// ─────────────────────────────────────────────
//
//  Round-trips through the fake MetadataStore (the same port prod uses), and
//  covers the guarantees the status surface relies on: a corrupt file loads as
//  empty (never throws), and setRound/setError/clearError persist. `deferred` is now
//  F5-drift only; delete/binary conflicts are `conflicts` descriptors, and the user's
//  `pendingDecisions` self-heal to the live conflict set each round (§3 "full inline").

import { describe, test, expect } from 'vitest';
import { SyncStateStore } from '../src/network/sync-state-store';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';

const STATE_PATH = '.vault-sync/sync-state.json';

describe('SyncStateStore', () => {
  test('absent file loads as empty state', async () => {
    const store = new SyncStateStore(new FakeMetadataStore());
    const state = await store.load();
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
    expect(state.deferred).toEqual([]);
    expect(state.lastSync).toBeNull();
  });

  test('setRound records the summary and replaces deferred / conflicts / stranded', async () => {
    const meta = new FakeMetadataStore();
    const store = new SyncStateStore(meta);
    await store.load();

    await store.setRound(
      { at: 5000, pushed: 3, pulled: 2, conflicts: 1 },
      [{ fileId: 'f1', path: 'a.md', at: 5000 }],           // drift only
      [{ contentHash: 'deadbeef', at: 5000 }],
      [{ fileId: 'f2', path: 'b.png', kind: 'binary', at: 5000 }],  // delete/binary conflict
    );
    expect(store.get().lastSync).toEqual({ at: 5000, pushed: 3, pulled: 2, conflicts: 1 });
    expect(store.get().deferred.map(d => d.path)).toEqual(['a.md']);
    expect(store.get().conflicts.map(c => c.path)).toEqual(['b.png']);
    expect(store.get().stranded.map(s => s.contentHash)).toContain('deadbeef');

    // A subsequent round replaces (not appends) the transient lists.
    await store.setRound({ at: 6000, pushed: 0, pulled: 0, conflicts: 0 }, [], [], []);
    expect(store.get().deferred).toEqual([]);
    expect(store.get().conflicts).toEqual([]);
    expect(store.get().stranded).toEqual([]);

    const reloaded = await new SyncStateStore(meta).load();
    expect(reloaded.lastSync!.at).toBe(6000);
  });

  test('a pending decision is consumed via getDecision and self-heals when its conflict is gone', async () => {
    const meta = new FakeMetadataStore();
    const store = new SyncStateStore(meta);
    await store.load();

    await store.recordDecision('f2', { kind: 'binary', decision: 'keep_local' });
    expect(store.getDecision('f2')).toEqual({ kind: 'binary', decision: 'keep_local' });

    // The conflict is still present this round → the decision survives (round consumes it).
    await store.setRound({ at: 5000, pushed: 0, pulled: 1, conflicts: 1 }, [], [],
      [{ fileId: 'f2', path: 'b.png', kind: 'binary', at: 5000 }]);
    expect(store.getDecision('f2')).toBeDefined();

    // The conflict resolved (no longer deferred) → the stale decision is pruned.
    await store.setRound({ at: 6000, pushed: 1, pulled: 0, conflicts: 0 }, [], [], []);
    expect(store.getDecision('f2')).toBeUndefined();

    // Persisted across a reload.
    await store.recordDecision('f3', { kind: 'delete', decision: 'restore' });
    const reloaded = new SyncStateStore(meta);
    await reloaded.load();
    expect(reloaded.getDecision('f3')).toEqual({ kind: 'delete', decision: 'restore' });
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
