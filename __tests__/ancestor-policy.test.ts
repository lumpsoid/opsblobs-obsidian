// ─────────────────────────────────────────────
//  Tests — Ancestor-advance policy (pure, plain values)
// ─────────────────────────────────────────────
//
//  Locks the most correctness-critical CRDT invariant in the codebase, including
//  the send_remote-only-on-first-sync rule whose violation caused the reported
//  data loss. No App, no registry, no mocks — just plain values.

import { describe, test, expect } from 'vitest';
import { nextAncestorHash } from '../src/merge/ancestor-policy';
import { FileEntry, HLC, MergeAction } from '../src/types';

const hlc: HLC = { wallTime: 1000, counter: 0, deviceId: 'dev' };

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  id: 'f1',
  path: 'note.md',
  contentHash: 'HASH_CONTENT',
  hlcTimestamp: hlc,
  deleted: false,
  ancestorContentHash: null,
  ...over,
});

const noOp: MergeAction = { type: 'no_op', fileId: 'f1' };
const sendRemote: MergeAction = {
  type: 'send_remote', fileId: 'f1', path: 'note.md', content: new Uint8Array(), hlc,
};

describe('ancestor-policy · nextAncestorHash', () => {
  // ── send_remote: the data-loss regression ──────────────────────────────────
  test('send_remote with a NON-null ancestor returns null (never re-advances)', () => {
    // Pushing our own edit is not a peer acknowledgement — advancing here is the
    // reported data-loss bug.
    expect(nextAncestorHash(sendRemote, entry({ ancestorContentHash: 'OLD_BASE' }))).toBeNull();
  });

  test('send_remote with a null ancestor returns entry.contentHash (first sync only)', () => {
    expect(nextAncestorHash(sendRemote, entry({ ancestorContentHash: null }))).toBe('HASH_CONTENT');
  });

  // ── no_op: both sides already hold the content, so advancing is always safe ─
  test('no_op returns entry.contentHash even when an ancestor already exists', () => {
    expect(nextAncestorHash(noOp, entry({ ancestorContentHash: 'OLD_BASE' }))).toBe('HASH_CONTENT');
  });

  test('no_op returns entry.contentHash on first sync too', () => {
    expect(nextAncestorHash(noOp, entry({ ancestorContentHash: null }))).toBe('HASH_CONTENT');
  });

  // ── live-entry guard ────────────────────────────────────────────────────────
  test('a deleted entry never advances (no_op)', () => {
    expect(nextAncestorHash(noOp, entry({ deleted: true }))).toBeNull();
  });

  test('a deleted entry never advances (send_remote first sync)', () => {
    expect(nextAncestorHash(sendRemote, entry({ deleted: true, ancestorContentHash: null }))).toBeNull();
  });

  test('a missing entry never advances', () => {
    expect(nextAncestorHash(noOp, undefined)).toBeNull();
    expect(nextAncestorHash(sendRemote, undefined)).toBeNull();
  });

  // ── other action types: never handled here (shell owns write_local hashing) ─
  test('write_local returns null (its hash is computed in the shell)', () => {
    const writeLocal: MergeAction = {
      type: 'write_local', fileId: 'f1', path: 'note.md', content: new Uint8Array(), hlc,
    };
    expect(nextAncestorHash(writeLocal, entry())).toBeNull();
  });

  test('unrelated actions leave the ancestor unchanged', () => {
    const del: MergeAction = { type: 'delete_local', fileId: 'f1', path: 'note.md' };
    expect(nextAncestorHash(del, entry())).toBeNull();
  });
});
