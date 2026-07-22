// ─────────────────────────────────────────────
//  Tests — HLC, Diff3, State Merge
// ─────────────────────────────────────────────

import { describe, test, expect, vi } from 'vitest';
import { HybridLogicalClock, hlcCompare, hlcToString, hlcFromString } from '../src/core/hlc';
import { diffLines, threeWayMerge } from '../src/merge/diff3';
import { mergeVaultStates } from '../src/merge/state-merge';
import { VersionDag } from '../src/core/version-dag';
import { VaultState, FileEntry } from '../src/types';

// ─── HLC Tests ────────────────────────────────────────────────────────────────

describe('HybridLogicalClock', () => {
  test('now() is monotonically increasing', () => {
    const clock = new HybridLogicalClock('device-a');
    const times = Array.from({ length: 100 }, () => clock.now());
    for (let i = 1; i < times.length; i++) {
      expect(hlcCompare(times[i]!, times[i - 1]!)).toBeGreaterThan(0);
    }
  });

  test('merge advances local clock past remote', () => {
    const clockA = new HybridLogicalClock('device-a');
    const clockB = new HybridLogicalClock('device-b');

    const t1 = clockA.now();
    // Simulate time passing on B
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    const t2 = clockB.now();
    vi.restoreAllMocks();

    const merged = clockA.merge(t2);
    expect(hlcCompare(merged, t2)).toBeGreaterThan(0);
    expect(hlcCompare(merged, t1)).toBeGreaterThan(0);
  });

  test('compare is total ordering (no ties except equal clocks)', () => {
    const clocks = ['a', 'b', 'c'].map(id => new HybridLogicalClock(id));
    const times = clocks.map(c => c.now());

    for (const a of times) {
      for (const b of times) {
        const ab = hlcCompare(a, b);
        const ba = hlcCompare(b, a);
        // Anti-symmetry
        if (a === b) expect(ab).toBe(0);
        else expect(ab).toBe(-ba);
      }
    }
  });

  test('serialization round-trips', () => {
    const clock = new HybridLogicalClock('device-xyz-123');
    const t = clock.now();
    const serialized = hlcToString(t);
    const deserialized = hlcFromString(serialized);
    expect(deserialized.wallTime).toBe(t.wallTime);
    expect(deserialized.counter).toBe(t.counter);
    expect(deserialized.deviceId).toBe(t.deviceId);
  });

  test('hlcFromString throws on too-few parts', () => {
    expect(() => hlcFromString('123-456')).toThrow(/Invalid HLC string/);
  });

  test('hlcFromString throws on non-numeric wallTime/counter', () => {
    expect(() => hlcFromString('abc-456-device')).toThrow(/Invalid HLC string/);
    expect(() => hlcFromString('123-xyz-device')).toThrow(/Invalid HLC string/);
  });

  test('commutativity: merge(A, merge(B, C)) == merge(B, merge(A, C))', () => {
    const clocks = ['a', 'b', 'c'].map(id => new HybridLogicalClock(id));
    const merged = clocks.map(c => c.now());
    const ta = merged[0]!, tb = merged[1]!;

    const clockX = new HybridLogicalClock('x');
    clockX.merge(ta);
    const r1 = clockX.merge(tb);

    const clockY = new HybridLogicalClock('x');
    clockY.merge(tb);
    const r2 = clockY.merge(ta);

    // Both should advance past both ta and tb
    expect(hlcCompare(r1, ta)).toBeGreaterThan(0);
    expect(hlcCompare(r1, tb)).toBeGreaterThan(0);
    expect(hlcCompare(r2, ta)).toBeGreaterThan(0);
    expect(hlcCompare(r2, tb)).toBeGreaterThan(0);
  });
});

// ─── Diff3 Tests ──────────────────────────────────────────────────────────────

describe('diffLines', () => {
  test('equal files produce no changes', () => {
    const lines = ['a', 'b', 'c'];
    const ops = diffLines(lines, lines);
    expect(ops.every(op => op.type === 'equal')).toBe(true);
  });

  test('detect insertions', () => {
    const a = ['line 1', 'line 3'];
    const b = ['line 1', 'line 2', 'line 3'];
    const ops = diffLines(a, b);
    const insert = ops.find(op => op.type === 'insert');
    expect(insert?.lines).toContain('line 2');
  });

  test('detect deletions', () => {
    const a = ['line 1', 'line 2', 'line 3'];
    const b = ['line 1', 'line 3'];
    const ops = diffLines(a, b);
    const del = ops.find(op => op.type === 'delete');
    expect(del?.lines).toContain('line 2');
  });

  test('handles empty arrays', () => {
    expect(diffLines([], ['a', 'b'])).toEqual([{ type: 'insert', lines: ['a', 'b'] }]);
    expect(diffLines(['a', 'b'], [])).toEqual([{ type: 'delete', lines: ['a', 'b'] }]);
    expect(diffLines([], [])).toEqual([]);
  });
});

describe('threeWayMerge', () => {
  test('non-conflicting appends from both sides merge cleanly', () => {
    const ancestor = 'line 1\nline 2\nline 3';
    const local = 'line 1\nline 2\nline 3\nlocal addition';
    const remote = 'remote addition\nline 1\nline 2\nline 3';

    const result = threeWayMerge(ancestor, local, remote);
    expect(result.hasConflicts).toBe(false);
    const text = result.merged.join('\n');
    expect(text).toContain('local addition');
    expect(text).toContain('remote addition');
    expect(text).toContain('line 1');
  });

  test('identical changes on both sides — no conflict', () => {
    const ancestor = 'hello\nworld';
    const local = 'hello\nuniverse';
    const remote = 'hello\nuniverse';

    const result = threeWayMerge(ancestor, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged.join('\n')).toBe('hello\nuniverse');
  });

  test('local-only change is accepted', () => {
    const ancestor = 'a\nb\nc';
    const local = 'a\nB\nc';
    const remote = 'a\nb\nc';

    const result = threeWayMerge(ancestor, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toContain('B');
  });

  test('remote-only change is accepted', () => {
    const ancestor = 'a\nb\nc';
    const local = 'a\nb\nc';
    const remote = 'a\nb\nC';

    const result = threeWayMerge(ancestor, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toContain('C');
  });

  test('overlapping edits produce a conflict', () => {
    const ancestor = 'a\nb\nc';
    const local = 'a\nB_local\nc';
    const remote = 'a\nB_remote\nc';

    const result = threeWayMerge(ancestor, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.local).toContain('B_local');
    expect(result.conflicts[0]!.remote).toContain('B_remote');
  });

  test('grocery store scenario: three devices append different items', () => {
    const ancestor = '# Grocery List\n- Milk';
    const deviceA = '# Grocery List\n- Milk\n- Bread';
    const deviceB = '# Grocery List\n- Milk\n- Eggs';

    // Merge A and B
    const abMerge = threeWayMerge(ancestor, deviceA, deviceB);
    expect(abMerge.hasConflicts).toBe(false);
    const abText = abMerge.merged.join('\n');
    expect(abText).toContain('Bread');
    expect(abText).toContain('Eggs');

    // Merge result with device C
    const deviceC = '# Grocery List\n- Milk\n- Butter';
    const abcMerge = threeWayMerge(ancestor, abText, deviceC);
    expect(abcMerge.hasConflicts).toBe(false);
    const abcText = abcMerge.merged.join('\n');
    expect(abcText).toContain('Bread');
    expect(abcText).toContain('Eggs');
    expect(abcText).toContain('Butter');
  });

  test('CRLF and LF are normalized (no spurious conflicts)', () => {
    const ancestor = 'a\r\nb\r\nc';
    const local = 'a\r\nB\r\nc';
    const remote = 'a\nb\nC';

    const result = threeWayMerge(ancestor, local, remote);
    expect(result.hasConflicts).toBe(false);
  });

  test('empty ancestor falls back gracefully', () => {
    const result = threeWayMerge('', 'local content', 'remote content');
    // No ancestor = pure conflict, but shouldn't crash
    expect(result.merged).toBeDefined();
  });
});

// ─── State Merge Tests ────────────────────────────────────────────────────────

function makeState(deviceId: string, files: Array<Partial<FileEntry> & { id: string }>): VaultState {
  const clock = new HybridLogicalClock(deviceId);
  const hlc = clock.now();
  const fileEntries = new Map<string, FileEntry>();
  const contentStore = new Map<string, Uint8Array>();

  for (const f of files) {
    const entry: FileEntry = {
      id: f.id,
      path: f.path ?? `${f.id}.md`,
      contentHash: f.contentHash ?? `hash-${f.id}`,
      hlcTimestamp: f.hlcTimestamp ?? hlc,
      deleted: f.deleted ?? false,
      headVersionId: f.headVersionId ?? null,
      lastSyncedPath: f.lastSyncedPath,
    };
    fileEntries.set(f.id, entry);
    if (!entry.deleted) {
      contentStore.set(entry.contentHash, new TextEncoder().encode(`Content of ${f.id}`));
    }
  }

  return { deviceId, hlc, fileEntries, pendingOps: [], contentStore };
}

/** Build a version DAG (sync v2) from `[versionId, parents, contentHash]` triples,
 *  so a merge test can supply the true three-way base (LCA over op-ids) the merge
 *  now derives from graph structure instead of a scalar ancestor. All nodes share
 *  one fileId (`file1`) — the tests operate on a single file. */
function dagOf(versions: Array<[string, string[], string]>): VersionDag {
  const dag = new VersionDag();
  for (const [id, parents, contentHash] of versions) dag.addVersion(id, parents, contentHash, 'file1');
  return dag;
}

describe('mergeVaultStates', () => {
  test('file only on remote → write_local', () => {
    const local = makeState('A', []);
    const remote = makeState('B', [{ id: 'file1' }]);

    const { actions } = mergeVaultStates(local, remote);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'write_local', fileId: 'file1' }));
  });

  test('file only on local → send_remote', () => {
    const local = makeState('A', [{ id: 'file1' }]);
    const remote = makeState('B', []);

    const { actions } = mergeVaultStates(local, remote);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'send_remote', fileId: 'file1' }));
  });

  test('same file, same hash → no_op', () => {
    const shared = [{ id: 'file1', contentHash: 'abc123' }];
    const local = makeState('A', shared);
    const remote = makeState('B', shared);

    const { actions } = mergeVaultStates(local, remote);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'no_op', fileId: 'file1' }));
  });

  test('both deleted → no_op', () => {
    const shared = [{ id: 'file1', deleted: true }];
    const local = makeState('A', shared);
    const remote = makeState('B', shared);

    const { actions } = mergeVaultStates(local, remote);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'no_op', fileId: 'file1' }));
  });

  test('local deleted, remote unchanged since base → delete_remote', () => {
    // Remote still holds the common base content (its head IS the base), so local's
    // deletion is clean over the DAG and should propagate to remote. Lineage:
    // v-base ("shared") ← v-del (local's deletion). Remote head is v-base itself.
    const clockA = new HybridLogicalClock('A');
    const clockB = new HybridLogicalClock('B');
    const dag = dagOf([['v-base', [], 'shared'], ['v-del', ['v-base'], 'shared']]);
    const local = makeState('A', [{ id: 'file1', deleted: true, contentHash: 'shared', headVersionId: 'v-del', hlcTimestamp: clockA.now() }]);
    const remote = makeState('B', [
      { id: 'file1', contentHash: 'shared', headVersionId: 'v-base', hlcTimestamp: clockB.now() },
    ]);

    const { actions } = mergeVaultStates(local, remote, dag);
    expect(actions).toContainEqual(
      expect.objectContaining({ type: 'delete_remote', fileId: 'file1' }),
    );
  });

  test('remote deleted, local unchanged since base → delete_local', () => {
    const clockA = new HybridLogicalClock('A');
    const clockB = new HybridLogicalClock('B');
    const dag = dagOf([['v-base', [], 'shared'], ['v-del', ['v-base'], 'shared']]);
    const local = makeState('A', [
      { id: 'file1', contentHash: 'shared', headVersionId: 'v-base', hlcTimestamp: clockA.now() },
    ]);
    const remote = makeState('B', [{ id: 'file1', deleted: true, contentHash: 'shared', headVersionId: 'v-del', hlcTimestamp: clockB.now() }]);

    const { actions } = mergeVaultStates(local, remote, dag);
    expect(actions).toContainEqual(
      expect.objectContaining({ type: 'delete_local', fileId: 'file1' }),
    );
  });

  test('remote deleted, local edited since base → delete_conflict', () => {
    // Local diverged from the base (its head is a distinct edit off v-base), so the
    // delete is not clean — must ask. Lineage: v-base ("shared") ← v-edit ("edited")
    // and v-base ← v-del (remote's deletion).
    const clockA = new HybridLogicalClock('A');
    const clockB = new HybridLogicalClock('B');
    const dag = dagOf([['v-base', [], 'shared'], ['v-edit', ['v-base'], 'edited'], ['v-del', ['v-base'], 'shared']]);
    const local = makeState('A', [
      { id: 'file1', contentHash: 'edited', headVersionId: 'v-edit', hlcTimestamp: clockA.now() },
    ]);
    const remote = makeState('B', [{ id: 'file1', deleted: true, contentHash: 'shared', headVersionId: 'v-del', hlcTimestamp: clockB.now() }]);

    const { actions } = mergeVaultStates(local, remote, dag);
    expect(actions).toContainEqual(
      expect.objectContaining({ type: 'delete_conflict', fileId: 'file1', side: 'remote_deleted' }),
    );
  });

  test('local deleted, remote modified → delete_conflict', () => {
    const clockA = new HybridLogicalClock('A');
    const clockB = new HybridLogicalClock('B');
    const dag = dagOf([['v-base', [], 'shared'], ['v-del', ['v-base'], 'shared'], ['v-mod', ['v-base'], 'new-hash']]);
    const local = makeState('A', [{ id: 'file1', deleted: true, contentHash: 'shared', headVersionId: 'v-del', hlcTimestamp: clockA.now() }]);
    const remote = makeState('B', [{ id: 'file1', contentHash: 'new-hash', headVersionId: 'v-mod', hlcTimestamp: clockB.now() }]);

    const { actions } = mergeVaultStates(local, remote, dag);
    expect(actions).toContainEqual(
      expect.objectContaining({ type: 'delete_conflict', fileId: 'file1', side: 'local_deleted' }),
    );
  });

  // ── F1: never fabricate empty content when the winner's bytes are missing ──
  test('both modified, remote wins by HLC but remote content missing → no_op (never write empty)', () => {
    // Both sides edited file1; remote wins last-writer-wins, but its winning
    // blob is transiently absent from its content store (e.g. fetchRemoteBlobs
    // skipped it). Writing must be declined, not fabricated as zero bytes.
    const local = makeState('A', [
      { id: 'file1', contentHash: 'local-hash', hlcTimestamp: { wallTime: 1000, counter: 0, deviceId: 'A' } },
    ]);
    const remote = makeState('B', [
      { id: 'file1', contentHash: 'remote-hash', hlcTimestamp: { wallTime: 2000, counter: 0, deviceId: 'B' } },
    ]);
    remote.contentStore.delete('remote-hash'); // winning side's bytes unavailable

    const { actions } = mergeVaultStates(local, remote);
    const action = actions.find(a => a.fileId === 'file1')!;
    expect(action.type).toBe('no_op');
    // Must NOT fabricate an empty write_local that truncates the local file.
    expect(actions).not.toContainEqual(
      expect.objectContaining({ type: 'write_local', fileId: 'file1' }),
    );
  });

  test('local deleted / remote modified but surviving content missing → no_op (no empty delete_conflict)', () => {
    // A delete/modify conflict where the surviving (remote) side's bytes are
    // absent: emitting a delete_conflict carrying empty content would restore an
    // empty file. Decline instead.
    const local = makeState('A', [
      { id: 'file1', deleted: true, hlcTimestamp: { wallTime: 1000, counter: 0, deviceId: 'A' } },
    ]);
    const remote = makeState('B', [
      { id: 'file1', contentHash: 'remote-hash', hlcTimestamp: { wallTime: 2000, counter: 0, deviceId: 'B' } },
    ]);
    remote.contentStore.delete('remote-hash'); // surviving side's bytes unavailable

    const { actions } = mergeVaultStates(local, remote);
    const action = actions.find(a => a.fileId === 'file1')!;
    expect(action.type).toBe('no_op');
    expect(actions).not.toContainEqual(
      expect.objectContaining({ type: 'delete_conflict', fileId: 'file1' }),
    );
  });

  test('remote deleted / local modified but surviving content missing → no_op (no empty delete_conflict)', () => {
    // Symmetric delete/modify conflict: the surviving (local) side's bytes are
    // absent, so the delete_conflict would carry empty content. Decline instead.
    const local = makeState('A', [
      { id: 'file1', contentHash: 'local-hash', hlcTimestamp: { wallTime: 2000, counter: 0, deviceId: 'A' } },
    ]);
    const remote = makeState('B', [
      { id: 'file1', deleted: true, hlcTimestamp: { wallTime: 1000, counter: 0, deviceId: 'B' } },
    ]);
    local.contentStore.delete('local-hash'); // surviving side's bytes unavailable

    const { actions } = mergeVaultStates(local, remote);
    const action = actions.find(a => a.fileId === 'file1')!;
    expect(action.type).toBe('no_op');
    expect(actions).not.toContainEqual(
      expect.objectContaining({ type: 'delete_conflict', fileId: 'file1' }),
    );
  });

  // ── F6: a known-but-missing ancestor must not union both full versions ──
  test('both modified, ancestor recorded but its bytes missing → conflict (never union both versions)', () => {
    // Both sides edited file1 and both current contents are present, but the
    // recorded ancestor's bytes are held by neither store (GC'd / never fetched).
    // An empty-string stand-in for a *known* ancestor makes diff3 treat both full
    // versions as inserts at gap 0 and unions them — silently duplicating the
    // whole file. That must surface as a conflict instead.
    // A leading blank line (ubiquitous in markdown) survives as the empty
    // ancestor's phantom line, so each side's real edit becomes a *pure insert*
    // at the same gap — exactly the diff3 union trap for a known-but-missing base.
    const localText = '\nAAA local only line 1\nAAA local only line 2';
    const remoteText = '\nBBB remote only line 1\nBBB remote only line 2';
    // The DAG names a real common base (v-base, content 'base') the two heads
    // descend from — a *known* base — but its bytes are held by neither store.
    const dag = dagOf([['v-base', [], 'base'], ['v-local', ['v-base'], 'local-hash'], ['v-remote', ['v-base'], 'remote-hash']]);
    const local = makeState('A', [
      { id: 'file1', contentHash: 'local-hash', headVersionId: 'v-local', hlcTimestamp: { wallTime: 1000, counter: 0, deviceId: 'A' } },
    ]);
    const remote = makeState('B', [
      { id: 'file1', contentHash: 'remote-hash', headVersionId: 'v-remote', hlcTimestamp: { wallTime: 2000, counter: 0, deviceId: 'B' } },
    ]);
    // Distinct, present current content on each side...
    local.contentStore.set('local-hash', new TextEncoder().encode(localText));
    remote.contentStore.set('remote-hash', new TextEncoder().encode(remoteText));
    // ...but the known base's bytes are unavailable in both stores.
    expect(local.contentStore.has('base')).toBe(false);
    expect(remote.contentStore.has('base')).toBe(false);

    const { actions } = mergeVaultStates(local, remote, dag);
    const action = actions.find(a => a.fileId === 'file1')!;
    expect(action.type).toBe('conflict');
    // Must NOT emit a write_local whose merged content concatenates BOTH versions.
    const writes = actions.filter(a => a.type === 'write_local' && a.fileId === 'file1');
    for (const w of writes) {
      const text = new TextDecoder().decode((w as { content: Uint8Array }).content);
      expect(text.includes('AAA local only line 1') && text.includes('BBB remote only line 1')).toBe(false);
    }
  });

  test('commutativity: merge(A,B).type == merge(B,A).type', () => {
    const stateA = makeState('A', [{ id: 'f1' }, { id: 'f2' }]);
    const stateB = makeState('B', [{ id: 'f2', contentHash: 'different' }, { id: 'f3' }]);

    const ab = mergeVaultStates(stateA, stateB);
    const ba = mergeVaultStates(stateB, stateA);

    // Same set of fileIds should be touched
    const abIds = new Set(ab.actions.map(a => a.fileId));
    const baIds = new Set(ba.actions.map(a => a.fileId));
    expect(abIds).toEqual(baIds);
  });
});
