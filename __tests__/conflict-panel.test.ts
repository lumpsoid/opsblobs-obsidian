// ─────────────────────────────────────────────
//  Sync v2 Step 6 — conflicts panel: the obsidian-free resolution logic
// ─────────────────────────────────────────────
//
//  The panel itself (ConflictsView) is Obsidian glue verified by manual smoke; ALL
//  its decisions live in three pure helpers, tested here:
//    · parseConflictMarkers / resolveMarkedText — parse the on-disk marked file and
//      collapse each block to the chosen side (the compare UX);
//    · listTwoHeadedConflicts — the derived list of files awaiting resolution, with
//      per-head provenance parsed from the version-ids.
//  Plus an end-to-end through the REAL device stack proving that feeding the panel's
//  resolved bytes back as an ordinary save converges two devices (the Step-5 path).

import { describe, test, expect, beforeAll } from 'vitest';
import {
  parseConflictMarkers,
  resolveMarkedText,
  countMarkerConflicts,
  renderConflictMarkers,
  hasConflictMarkers,
} from '../src/merge/diff3';
import { listTwoHeadedConflicts } from '../src/core/conflict-inventory';
import { FileEntry, ConflictResolution } from '../src/types';
import { hlcToString } from '../src/core/hlc';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

// ─── parseConflictMarkers / resolveMarkedText (pure) ──────────────────────────

describe('conflict marker parsing + resolution (Step 6)', () => {
  const MARKED = renderConflictMarkers('1\n2\n3', '1\nB\n3', '1\nA\n3');

  test('a clean file is one clean segment and resolves to itself', () => {
    const clean = 'alpha\nbeta\ngamma\n';
    const segs = parseConflictMarkers(clean);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: 'clean', lines: ['alpha', 'beta', 'gamma', ''] });
    expect(countMarkerConflicts(clean)).toBe(0);
    expect(resolveMarkedText(clean, new Map())).toBe(clean);
  });

  test('a marked file round-trips through the three sides', () => {
    expect(hasConflictMarkers(MARKED)).toBe(true);
    expect(countMarkerConflicts(MARKED)).toBe(1);

    const segs = parseConflictMarkers(MARKED);
    const conflict = segs.find(s => s.kind === 'conflict');
    expect(conflict).toEqual({ kind: 'conflict', ours: ['B'], base: ['2'], theirs: ['A'] });

    // Each side selection collapses the block to that side; markers are gone.
    expect(resolveMarkedText(MARKED, sel(0, 'local'))).toBe('1\nB\n3');
    expect(resolveMarkedText(MARKED, sel(0, 'remote'))).toBe('1\nA\n3');
    expect(resolveMarkedText(MARKED, sel(0, 'both'))).toBe('1\nB\nA\n3');
    for (const kind of ['local', 'remote', 'both'] as const) {
      expect(hasConflictMarkers(resolveMarkedText(MARKED, sel(0, kind)))).toBe(false);
    }
  });

  test('a missing decision defaults to keeping ours (mirrors the modal default)', () => {
    expect(resolveMarkedText(MARKED, new Map())).toBe('1\nB\n3');
  });

  test('multiple blocks are resolved independently by ordinal', () => {
    const text = [
      'top',
      '<<<<<<< ours', 'oneMine', '||||||| base', 'oneBase', '=======', 'oneTheirs', '>>>>>>> theirs',
      'middle',
      '<<<<<<< ours', 'twoMine', '||||||| base', 'twoBase', '=======', 'twoTheirs', '>>>>>>> theirs',
      'bottom',
    ].join('\n');
    expect(countMarkerConflicts(text)).toBe(2);
    const res = new Map<number, ConflictResolution>([[0, { kind: 'local' }], [1, { kind: 'remote' }]]);
    expect(resolveMarkedText(text, res)).toBe('top\noneMine\nmiddle\ntwoTheirs\nbottom');
  });

  test('a block without a base section (plain diff3) parses with empty base', () => {
    const text = ['x', '<<<<<<< ours', 'mine', '=======', 'theirs', '>>>>>>> theirs', 'y'].join('\n');
    const conflict = parseConflictMarkers(text).find(s => s.kind === 'conflict');
    expect(conflict).toEqual({ kind: 'conflict', ours: ['mine'], base: [], theirs: ['theirs'] });
    expect(resolveMarkedText(text, sel(0, 'both'))).toBe('x\nmine\ntheirs\ny');
  });

  test('a truncated (unterminated) block does not swallow silently — captured sides emit', () => {
    const text = ['head', '<<<<<<< ours', 'mine', '=======', 'theirs'].join('\n'); // no closing marker
    const conflict = parseConflictMarkers(text).find(s => s.kind === 'conflict');
    expect(conflict).toEqual({ kind: 'conflict', ours: ['mine'], base: [], theirs: ['theirs'] });
  });

  const sel = (i: number, kind: ConflictResolution['kind']): Map<number, ConflictResolution> =>
    new Map<number, ConflictResolution>([[i, { kind } as ConflictResolution]]);
});

// ─── listTwoHeadedConflicts (pure) ────────────────────────────────────────────

describe('two-headed conflict inventory (Step 6)', () => {
  const entry = (over: Partial<FileEntry>): FileEntry => ({
    id: 'id', path: 'p', contentHash: 'h',
    hlcTimestamp: { wallTime: 0, counter: 0, deviceId: 'd' },
    deleted: false, ...over,
  });

  test('keeps only entries with two open heads, in path order, provenance parsed', () => {
    const headA = hlcToString({ wallTime: 2000, counter: 0, deviceId: 'dev-a' });
    const headB = hlcToString({ wallTime: 3000, counter: 1, deviceId: 'dev-b' });
    const entries: FileEntry[] = [
      entry({ id: 'z', path: 'z.md', conflictParents: [headA, headB] }),
      entry({ id: 'clean', path: 'a.md' }),                                  // no conflict
      entry({ id: 'one', path: 'b.md', conflictParents: [headA] }),         // only one head
      entry({ id: 'a', path: 'a-conflict.md', conflictParents: [headB, headA] }),
    ];

    const items = listTwoHeadedConflicts(entries);
    expect(items.map(i => i.path)).toEqual(['a-conflict.md', 'z.md']); // sorted, single-head dropped

    const z = items.find(i => i.path === 'z.md')!;
    expect(z.heads.map(h => h.versionId)).toEqual([headA, headB]); // order preserved
    expect(z.heads[0]!.hlc).toEqual({ wallTime: 2000, counter: 0, deviceId: 'dev-a' });
    expect(z.heads[1]!.hlc).toEqual({ wallTime: 3000, counter: 1, deviceId: 'dev-b' });
  });

  test('a non-HLC head id (e.g. a merge node) yields null provenance, not a throw', () => {
    const items = listTwoHeadedConflicts([
      entry({ path: 'm.md', conflictParents: ['m-deadbeef', 'also-not-hlc'] }),
    ]);
    expect(items[0]!.heads.every(h => h.hlc === null)).toBe(true);
  });
});

// ─── End-to-end: panel logic drives a real resolution ─────────────────────────

describe('panel resolution converges two devices (Step 6, e2e)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple',
      new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 5, 5, 5]));
  });

  const onDisk = async (d: TestDevice, path = 'note.md'): Promise<string> => {
    const bytes = await d.files.read(path);
    return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
  };

  test('the inventory lists the two-headed file; its resolved bytes clear the conflict and peers converge', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) => new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('note.md', '1\n2\n3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();

    // Concurrent same-line edits → B is left two-headed with markers on disk.
    await A.editFile('note.md', '1\nAAA\n3\n', 2000);
    await client(A).runSync();
    await B.editFile('note.md', '1\nBBB\n3\n', 3000);
    await client(B).runSync();
    expect(hasConflictMarkers(await onDisk(B))).toBe(true);

    // ── The panel's derived list sees exactly this file, with provenance. ──────
    const items = listTwoHeadedConflicts(B.allEntries().values());
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toBe('note.md');
    // heads[0] = ours (this device, dev-b); heads[1] = theirs (dev-a).
    expect(items[0]!.heads[0]!.hlc!.deviceId).toBe('dev-b');
    expect(items[0]!.heads[1]!.hlc!.deviceId).toBe('dev-a');

    // ── Resolve via the panel logic: keep both sides for the single hunk. ──────
    const marked = await onDisk(B);
    expect(countMarkerConflicts(marked)).toBe(1);
    const resolved = resolveMarkedText(marked, new Map([[0, { kind: 'both' }]]));
    expect(hasConflictMarkers(resolved)).toBe(false);

    // Writing the resolved bytes is the ordinary Step-5 resolving save.
    await B.editFile('note.md', resolved, 5000);
    expect(B.entryByPath('note.md')!.conflictParents == null).toBe(true);
    expect(listTwoHeadedConflicts(B.allEntries().values())).toHaveLength(0);
    const mergeOp = B.pendingOps.find(op => op.path === 'note.md')!;
    expect(mergeOp.id.startsWith('m-')).toBe(true);
    expect(mergeOp.parents).toHaveLength(2);

    // B pushes the resolution; A (still holding "AAA") fast-forwards onto it.
    await client(B).runSync();
    await client(A).runSync();
    expect(await onDisk(A)).toBe(await onDisk(B));
    expect(await onDisk(B)).toBe(resolved);
  });
});
