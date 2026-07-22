// ─────────────────────────────────────────────
//  Tests — headVersionId tracking (sync v2, Rework R1a)
// ─────────────────────────────────────────────
//
//  A file's registry entry records its current head version — the op-id of the
//  content version a new local edit descends from. This asserts the head tracks
//  the latest content op (create → update → delete), is NOT advanced by a pure
//  rename, and survives a plugin restart. Drives the real device stack (registry
//  + OperationLogger), never hand-built ops. The head is not yet read for merging
//  (that lands with the op-id DAG rework); these assert the plumbing.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

/** The id of the last pending op (ops are minted in order). */
function lastOpId(d: TestDevice): string {
  const ops = d.pendingOps;
  return ops[ops.length - 1]!.id;
}

describe('headVersionId tracks the latest content version', () => {
  test('create then edit: head follows each op; rename does not advance it', async () => {
    const A = await TestDevice.create('dev-a');

    const id = await A.seedFile('n.md', 'hello\n', 1000);
    const createOpId = lastOpId(A);
    expect(A.entry(id)!.headVersionId).toBe(createOpId);

    await A.editFile('n.md', 'world\n', 2000);
    const updateOpId = lastOpId(A);
    expect(updateOpId).not.toBe(createOpId);
    expect(A.entry(id)!.headVersionId).toBe(updateOpId);

    // A pure rename is not a new content version — the head must not advance.
    await A.renameFile('n.md', 'renamed.md', 3000);
    expect(A.entry(id)!.headVersionId).toBe(updateOpId);
  });

  test('an edit op names the prior head as context (parents still content-hash pre-DAG)', async () => {
    const A = await TestDevice.create('dev-a');
    const id = await A.seedFile('n.md', 'a\n', 1000);
    const headAfterCreate = A.entry(id)!.headVersionId;

    await A.editFile('n.md', 'b\n', 2000);
    // The head advanced to the update op; the previous head is a distinct version.
    expect(A.entry(id)!.headVersionId).not.toBe(headAfterCreate);
    expect(A.entry(id)!.headVersionId).toBe(lastOpId(A));
  });

  test('head survives a plugin restart (persisted on the entry)', async () => {
    const A = await TestDevice.create('dev-a');
    const id = await A.seedFile('n.md', 'hello\n', 1000);
    await A.editFile('n.md', 'world\n', 2000);
    const head = A.entry(id)!.headVersionId;
    expect(head).toBeTruthy();

    const A2 = await A.reload();
    expect(A2.entry(id)!.headVersionId).toBe(head);
  });
});
