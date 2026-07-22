// ─────────────────────────────────────────────
//  Inline conflict markers (sync v2 Step 5) — the pure diff3 rendering + detection
// ─────────────────────────────────────────────
//
//  A text conflict is surfaced NON-BLOCKINGLY as inline zdiff3 markers at the real
//  path; the user edits them away and the next save resolves it. These tests pin the
//  pure rendering (`renderConflictMarkers` / `renderMarkersFromResult`) and the
//  save-time detection (`hasConflictMarkers`) the applicator and op-logger rely on.

import { describe, test, expect } from 'vitest';
import {
  renderConflictMarkers,
  renderMarkersFromResult,
  hasConflictMarkers,
  threeWayMerge,
  CONFLICT_MARK_OURS,
  CONFLICT_MARK_BASE,
  CONFLICT_MARK_SEP,
  CONFLICT_MARK_THEIRS,
} from '../src/merge/diff3';

describe('renderConflictMarkers (zdiff3 inline markers)', () => {
  test('an overlapping edit produces one marker block with ours / base / theirs', () => {
    const base = '1\n2\n3\n';
    const ours = '1\nAAA\n3\n';
    const theirs = '1\nBBB\n3\n';
    const marked = renderConflictMarkers(base, ours, theirs);

    // Clean context (lines 1 and 3) is preserved verbatim, outside the markers.
    const lines = marked.split('\n');
    expect(lines[0]).toBe('1');
    expect(lines[lines.length - 2]).toBe('3'); // trailing '' from the final newline

    // The block carries all three sides in zdiff3 order.
    expect(marked).toContain(`${CONFLICT_MARK_OURS} ours`);
    expect(marked).toContain('AAA');
    expect(marked).toContain(`${CONFLICT_MARK_BASE} base`);
    expect(marked).toContain('2'); // the base line between the markers
    expect(marked).toContain(CONFLICT_MARK_SEP);
    expect(marked).toContain('BBB');
    expect(marked).toContain(`${CONFLICT_MARK_THEIRS} theirs`);

    // ours precedes base precedes sep precedes theirs.
    expect(marked.indexOf('AAA')).toBeLessThan(marked.indexOf(CONFLICT_MARK_BASE));
    expect(marked.indexOf(CONFLICT_MARK_BASE)).toBeLessThan(marked.indexOf(CONFLICT_MARK_SEP));
    expect(marked.indexOf(CONFLICT_MARK_SEP)).toBeLessThan(marked.indexOf('BBB'));
  });

  test('a non-overlapping (clean-mergeable) edit renders no markers', () => {
    // Each side edits a different, non-adjacent line → diff3 merges cleanly.
    const base = '1\n2\n3\n4\n5\n';
    const ours = 'X\n2\n3\n4\n5\n';
    const theirs = '1\n2\n3\n4\nY\n';
    const marked = renderConflictMarkers(base, ours, theirs);
    expect(hasConflictMarkers(marked)).toBe(false);
    expect(marked).toBe('X\n2\n3\n4\nY\n');
  });

  test('renderMarkersFromResult handles a whole-file conflict (empty base)', () => {
    // The applicator's fallback shape: one chunk spanning the whole file, no ancestor.
    const result = {
      merged: ['ours-line'],
      conflicts: [{ startLine: 0, endLine: 0, ancestor: [], local: ['ours-line'], remote: ['theirs-line'] }],
      hasConflicts: true,
    };
    const marked = renderMarkersFromResult(result);
    expect(marked).toContain('ours-line');
    expect(marked).toContain('theirs-line');
    expect(hasConflictMarkers(marked)).toBe(true);
    // Empty base section: the base marker is immediately followed by the separator.
    const lines = marked.split('\n');
    const baseIdx = lines.findIndex(l => l.startsWith(CONFLICT_MARK_BASE));
    expect(lines[baseIdx + 1]).toBe(CONFLICT_MARK_SEP);
  });

  test('rendering a marked file exactly reproduces threeWayMerge conflict hunks', () => {
    // renderMarkersFromResult(threeWayMerge(...)) === renderConflictMarkers(...).
    const base = 'a\nb\nc\n';
    const ours = 'a\nOURS\nc\n';
    const theirs = 'a\nTHEIRS\nc\n';
    expect(renderMarkersFromResult(threeWayMerge(base, ours, theirs)))
      .toBe(renderConflictMarkers(base, ours, theirs));
  });
});

describe('hasConflictMarkers', () => {
  test('true only when both the opening and closing markers are present', () => {
    expect(hasConflictMarkers(`${CONFLICT_MARK_OURS} ours\nx\n${CONFLICT_MARK_SEP}\ny\n${CONFLICT_MARK_THEIRS} theirs`)).toBe(true);
    // An opening marker alone (a partially-edited file) is not yet "resolved", but
    // also not a complete conflict block — require both ends to avoid false positives.
    expect(hasConflictMarkers(`${CONFLICT_MARK_OURS} ours\nx`)).toBe(false);
  });

  test('a note that merely mentions marker-like characters is not a conflict', () => {
    expect(hasConflictMarkers('here is a diff:\n<<< not a marker\n=== nope\n')).toBe(false);
    expect(hasConflictMarkers('a normal note\nwith some ==== rule\n')).toBe(false);
  });

  test('recognises CRLF-normalised marker lines', () => {
    const crlf = `${CONFLICT_MARK_OURS} ours\r\nx\r\n${CONFLICT_MARK_THEIRS} theirs\r\n`;
    expect(hasConflictMarkers(crlf)).toBe(true);
  });
});
