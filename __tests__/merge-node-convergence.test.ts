// ─────────────────────────────────────────────
//  Sync v2 — clean merges are real two-parent DAG nodes
// ─────────────────────────────────────────────
//
//  Step 4a. A clean three-way merge of two divergent heads must synthesize a REAL
//  version node in the op-id DAG — not the old *synthetic* head that was never a
//  node. The node:
//    · has a deterministic, content-addressed id (`m-…`), so two devices merging
//      the same pair produce the identical node (dedup on push);
//    · carries the two reconciled heads as `parents` (a two-parent merge node);
//    · is what a peer fast-forwards ONTO — adopting that exact content-addressed
//      id as its head, NOT a re-derived `hlcToString(hlc)` (finding #1);
//    · lets the NEXT edit off the merged file descend from a real DAG node, so its
//      base resolves from graph structure rather than the scalar ancestor. That is
//      the whole reason Step 4 lands before Step 3 (which removes the scalar
//      ancestor): without a real node here, that removal would strand the next
//      edit's base and risk a silent union.
//
//  Drives the genuine ServerSyncClient round against the fake server.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { mergeVersionId } from '../src/core/operations';
import { hashContent } from '../src/core/content-store';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

const onDisk = async (d: TestDevice, path = 'note.md'): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

describe('mergeVersionId (pure): deterministic + commutative', () => {
  test('same content + same parents (any order) → same id; different → different', async () => {
    const a = await mergeVersionId('hashXYZ', ['id_A', 'id_B']);
    const b = await mergeVersionId('hashXYZ', ['id_B', 'id_A']); // parents swapped
    expect(a).toBe(b);                       // commutative: merge(A,B) ≡ merge(B,A)
    expect(a.startsWith('m-')).toBe(true);   // marked as a merge id

    expect(await mergeVersionId('hashOTHER', ['id_A', 'id_B'])).not.toBe(a); // content matters
    expect(await mergeVersionId('hashXYZ', ['id_A', 'id_C'])).not.toBe(a);   // parents matter
  });
});

describe('a clean merge is a real two-parent DAG node the peer fast-forwards onto', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('correct horse battery staple', SALT);
  });

  test('non-overlapping concurrent edits merge into a node; the next edit descends from it', async () => {
    const api = new FakeSyncServer();
    const client = (d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // ── Shared base. ─────────────────────────────────────────────────────────
    const fileId = await A.seedFile('note.md', 'L1\nL2\nL3\n', 1000);
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(B)).toBe('L1\nL2\nL3\n');

    // ── A edits line 1 and syncs first (alone → no conflict). ─────────────────
    await A.editFile('note.md', 'A1\nL2\nL3\n', 2000);
    await client(A).runSync();

    // ── B edits line 3 (non-overlapping) and syncs: a CLEAN three-way merge. ──
    await B.editFile('note.md', 'L1\nL2\nB3\n', 3000);
    await client(B).runSync();

    // B applied a `write_merge` (not a conflict, not a plain write_local), and now
    // holds the merged content with a content-addressed merge head.
    expect(B.applied.some(a => a.type === 'write_merge')).toBe(true);
    expect(B.applied.some(a => a.type === 'conflict')).toBe(false);
    expect(await onDisk(B)).toBe('A1\nL2\nB3\n');

    const mergeId = B.entryByPath('note.md')!.headVersionId!;
    expect(mergeId.startsWith('m-')).toBe(true); // a real merge node, not a synthetic hlc head
    // Its id is exactly the deterministic content-address of (merged bytes, parents).
    const mergedHash = await hashContent(new TextEncoder().encode('A1\nL2\nB3\n'));
    const mergeOp = B.pendingOps.find(op => op.id === mergeId)!;
    expect(mergeOp).toBeDefined();
    expect(mergeOp.parents.length).toBe(2);                       // two-parent node
    expect(await mergeVersionId(mergedHash, mergeOp.parents)).toBe(mergeId);

    // ── B pushes the merge node; A pulls it and FAST-FORWARDS onto it. ────────
    await client(B).runSync();                 // push the pending merge op
    const beforeA = A.applied.length;
    await client(A).runSync();                 // A pulls the merge node
    const aNew = A.applied.slice(beforeA).map(a => a.type);
    expect(aNew).toContain('write_local');     // FF-adopt the descendant merge node
    expect(aNew).not.toContain('conflict');
    expect(await onDisk(A)).toBe('A1\nL2\nB3\n');

    // The peer adopted the EXACT content-addressed merge id as its head — not a
    // re-derived hlcToString(hlc). This is the finding-#1 fix; without it A's head
    // would name a version no DAG node carries and the next edit would lose its base.
    expect(A.entryByPath('note.md')!.headVersionId).toBe(mergeId);

    // Both devices' DAGs carry the identical merge node with the merged bytes.
    for (const d of [A, B]) {
      const dag = await d.versionDagStore.load();
      expect(dag.has(mergeId)).toBe(true);
      expect(dag.contentHashOf(mergeId)).toBe(mergedHash);
    }

    // ── The NEXT edit off the merged file descends from the real merge node. ──
    await A.editFile('note.md', 'A1\nL2\nC3\n', 4000);
    const nextEdit = A.pendingOps.find(op => op.path === 'note.md' && op.contentHash !== mergedHash)!;
    expect(nextEdit.parents).toEqual([mergeId]); // base is the merge node, not a scalar ancestor

    // …and it converges on the peer by fast-forwarding over that same node.
    await client(A).runSync();
    await client(B).runSync();
    expect(await onDisk(A)).toBe('A1\nL2\nC3\n');
    expect(await onDisk(B)).toBe('A1\nL2\nC3\n');
    expect(B.applied.some(a => a.type === 'conflict')).toBe(false); // never a spurious conflict
  });
});
