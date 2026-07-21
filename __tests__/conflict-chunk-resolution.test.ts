// ─────────────────────────────────────────────
//  resolveConflictChunkLines (src/merge/diff3.ts) — the single rule that turns a
//  user's per-chunk conflict choice into replacement lines. The conflict modal is
//  Obsidian-coupled and hard to unit-test, but this pure helper is the actual
//  decision logic behind its "Accept Local/Remote/Both" buttons, so we test it
//  directly (Part 1.3 of the coverage spec).
// ─────────────────────────────────────────────

import { describe, test, expect } from 'vitest';
import { resolveConflictChunkLines } from '../src/merge/diff3';
import { ConflictChunk } from '../src/types';

const chunk: ConflictChunk = {
  startLine: 3,
  endLine: 5,
  ancestor: ['base'],
  local: ['mine-1', 'mine-2'],
  remote: ['theirs-1'],
};

describe('resolveConflictChunkLines', () => {
  test('local keeps the local lines', () => {
    expect(resolveConflictChunkLines(chunk, { kind: 'local' })).toEqual(['mine-1', 'mine-2']);
  });

  test('remote keeps the remote lines', () => {
    expect(resolveConflictChunkLines(chunk, { kind: 'remote' })).toEqual(['theirs-1']);
  });

  test('both concatenates local then remote', () => {
    expect(resolveConflictChunkLines(chunk, { kind: 'both' })).toEqual(['mine-1', 'mine-2', 'theirs-1']);
  });

  test('custom uses the supplied text verbatim', () => {
    expect(resolveConflictChunkLines(chunk, { kind: 'custom', text: ['merged'] })).toEqual(['merged']);
  });

  test('a deleted side (empty lines) is represented as an empty array, not a fallback', () => {
    const deletedRemote: ConflictChunk = { ...chunk, remote: [] };
    expect(resolveConflictChunkLines(deletedRemote, { kind: 'remote' })).toEqual([]);
    expect(resolveConflictChunkLines(deletedRemote, { kind: 'both' })).toEqual(['mine-1', 'mine-2']);
  });
});
