import { describe, test, expect } from 'vitest';
import { Ops } from '../src/core/operations';
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

  test('resolveUpdate / resolveDelete carry supersedes and the right type', () => {
    const parents = ['hLocal', 'hRemote'];

    const u = Ops.resolveUpdate('f1', 'a.md', 'hMerged', hlc, parents);
    expect(u.type).toBe('update');
    expect(u.supersedes).toEqual(parents);

    const d = Ops.resolveDelete('f1', 'a.md', 'hOld', hlc, parents);
    expect(d.type).toBe('delete');
    expect(d.supersedes).toEqual(parents);
  });
});
