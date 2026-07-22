import { describe, test, expect } from 'vitest';
import { Ops, mergeVersionId } from '../src/core/operations';
import { hlcToString } from '../src/core/hlc';
import { HLC } from '../src/types';

// Executable catalog of the op vocabulary: the shape + field-level invariants of
// every kind OperationLogger can emit. Guards against a factory drifting from the
// rules its doc-comment promises.

const hlc: HLC = { wallTime: 1000, counter: 2, deviceId: 'dev-a' };

describe('Ops — operation factories', () => {
  test('create / update / delete / move stamp version, HLC-derived id, and type', () => {
    const cases = [
      { kind: 'create', op: Ops.create('f1', 'a.md', 'h1', hlc) },
      { kind: 'update', op: Ops.update('f1', 'a.md', 'h2', hlc) },
      { kind: 'delete', op: Ops.delete('f1', 'a.md', 'h3', hlc) },
      { kind: 'move', op: Ops.move('f1', 'b.md', 'h1', hlc) },
    ] as const;

    for (const { kind, op } of cases) {
      expect(op.v).toBe(1);                       // stamped format version
      expect(op.id).toBe(hlcToString(hlc));       // id derived from the HLC
      expect(op.type).toBe(kind);
      expect(op.fileId).toBe('f1');
      expect(op.hlcTimestamp).toEqual(hlc);
      expect('supersedes' in op).toBe(false);     // only resolutions carry it
    }
  });

  test('contentHash reflects the arg (delete carries the now-deleted hash)', () => {
    expect(Ops.create('f1', 'a.md', 'h1', hlc).contentHash).toBe('h1');
    expect(Ops.delete('f1', 'a.md', 'h3', hlc).contentHash).toBe('h3');
    expect(Ops.move('f1', 'b.md', 'h1', hlc).path).toBe('b.md');
  });

  test('parent links: create is a root; update/delete/move carry the prior head', () => {
    expect(Ops.create('f1', 'a.md', 'h1', hlc).parents).toEqual([]);           // a DAG root
    expect(Ops.update('f1', 'a.md', 'h2', hlc, 'vHead').parents).toEqual(['vHead']);
    expect(Ops.delete('f1', 'a.md', 'h3', hlc, 'vHead').parents).toEqual(['vHead']);
    // A move is not a new content version but carries the content head it renamed,
    // so a peer projects the renamed file's head as that version (keeping the DAG
    // connected across a rename) rather than the move op's id.
    expect(Ops.move('f1', 'b.md', 'h1', hlc, 'vHead').parents).toEqual(['vHead']);
    expect(Ops.move('f1', 'b.md', 'h1', hlc).parents).toEqual([]);             // unknown head ⇒ root
  });

  test('merge / mergeDelete are two-parent nodes carrying a content-addressed id (sync v2)', async () => {
    const parents = ['vLocal', 'vRemote'];

    // A resolved content conflict / clean merge → an `update` merge node whose id is
    // the deterministic content-addressed mergeVersionId and whose parents are the
    // two reconciled heads (peers fast-forward onto it).
    const id = await mergeVersionId('hMerged', parents);
    const u = Ops.merge('f1', 'a.md', 'hMerged', hlc, parents, id);
    expect(u.type).toBe('update');
    expect(u.parents).toEqual(parents);
    expect(u.id).toBe(id);
    expect(id.startsWith('m-')).toBe(true);

    // A kept-deleted resolution → a `delete` (tombstone) merge node of the same shape.
    const delId = await mergeVersionId('hOld', parents);
    const d = Ops.mergeDelete('f1', 'a.md', 'hOld', hlc, parents, delId);
    expect(d.type).toBe('delete');
    expect(d.parents).toEqual(parents);
    expect(d.id).toBe(delId);
  });
});
