// ─────────────────────────────────────────────
//  Diff + Three-Way Merge (bundled, zero deps)
//  Phase 2.2
// ─────────────────────────────────────────────
//
//  Layer 1: Patience diff (LCS-based, anchors on unique lines — better for markdown)
//  Layer 2: Three-way merge using two diffs against a common ancestor

import { ConflictChunk, ConflictResolution, ThreeWayMergeResult } from '../types';

// ─── Layer 1: Patience Diff ──────────────────────────────────────────────────

type DiffOp = { type: 'equal' | 'insert' | 'delete'; lines: string[] };

/**
 * Compute a line-level diff between two arrays of strings.
 * Uses patience diff algorithm — anchors on unique lines for cleaner diffs
 * on structured text like markdown headings and list items.
 */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  diffRecurse(a, 0, a.length, b, 0, b.length, ops);
  return coalesceOps(ops);
}

function diffRecurse(
  a: string[], aLo: number, aHi: number,
  b: string[], bLo: number, bHi: number,
  ops: DiffOp[],
): void {
  // Base cases
  if (aLo === aHi && bLo === bHi) return;

  if (aLo === aHi) {
    ops.push({ type: 'insert', lines: b.slice(bLo, bHi) });
    return;
  }
  if (bLo === bHi) {
    ops.push({ type: 'delete', lines: a.slice(aLo, aHi) });
    return;
  }

  // Find unique-line LCS anchors (patience diff style)
  const anchors = patienceAnchors(a, aLo, aHi, b, bLo, bHi);

  if (anchors.length === 0) {
    // No anchors — fall back to LCS
    const lcs = myersLCS(a, aLo, aHi, b, bLo, bHi);
    emitFromLCS(a, aLo, aHi, b, bLo, bHi, lcs, ops);
    return;
  }

  // Recurse between anchor pairs
  let prevAi = aLo, prevBi = bLo;
  for (const [ai, bi] of anchors) {
    diffRecurse(a, prevAi, ai, b, prevBi, bi, ops);
    ops.push({ type: 'equal', lines: [a[ai]!] });
    prevAi = ai + 1;
    prevBi = bi + 1;
  }
  diffRecurse(a, prevAi, aHi, b, prevBi, bHi, ops);
}

/** Find pairs of matching unique lines (patience algorithm core). */
function patienceAnchors(
  a: string[], aLo: number, aHi: number,
  b: string[], bLo: number, bHi: number,
): Array<[number, number]> {
  // Count occurrences in each range
  const aCount = new Map<string, number[]>();
  const bCount = new Map<string, number[]>();

  for (let i = aLo; i < aHi; i++) {
    const indices = aCount.get(a[i]!) ?? [];
    indices.push(i);
    aCount.set(a[i]!, indices);
  }
  for (let i = bLo; i < bHi; i++) {
    const indices = bCount.get(b[i]!) ?? [];
    indices.push(i);
    bCount.set(b[i]!, indices);
  }

  // Collect unique lines that appear exactly once in both
  const pairs: Array<[number, number]> = [];
  for (const [line, aIdxs] of aCount) {
    const bIdxs = bCount.get(line);
    if (aIdxs.length === 1 && bIdxs && bIdxs.length === 1) {
      pairs.push([aIdxs[0]!, bIdxs[0]!]);
    }
  }

  // Sort by a-index
  pairs.sort((x, y) => x[0] - y[0]);

  // Longest increasing subsequence on b-indices (standard patience sort)
  return longestIncreasingSubsequence(pairs);
}

function longestIncreasingSubsequence(pairs: Array<[number, number]>): Array<[number, number]> {
  if (pairs.length === 0) return [];
  const piles: Array<[number, number]> = [];
  const prev: number[] = new Array<number>(pairs.length).fill(-1);
  const pileTop: number[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const bVal = pairs[i]![1];
    let lo = 0, hi = piles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (piles[pileTop[mid]!]![1] < bVal) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = pileTop[lo - 1]!;
    pileTop[lo] = i;
    if (lo === piles.length) piles.push(pairs[i]!);
    else piles[lo] = pairs[i]!;
  }

  // Reconstruct
  const result: Array<[number, number]> = [];
  let k = pileTop[piles.length - 1]!;
  while (k !== -1) {
    result.unshift(pairs[k]!);
    k = prev[k]!;
  }
  return result;
}

/** Minimal Myers LCS for fallback when no unique anchors exist. */
function myersLCS(
  a: string[], aLo: number, aHi: number,
  b: string[], bLo: number, bHi: number,
): Array<[number, number]> {
  const aSlice = a.slice(aLo, aHi);
  const bSlice = b.slice(bLo, bHi);
  const m = aSlice.length, n = bSlice.length;
  if (m === 0 || n === 0) return [];

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aSlice[i] === bSlice[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lcs: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (aSlice[i] === bSlice[j]) {
      lcs.push([aLo + i, bLo + j]);
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return lcs;
}

function emitFromLCS(
  a: string[], aLo: number, aHi: number,
  b: string[], bLo: number, bHi: number,
  lcs: Array<[number, number]>,
  ops: DiffOp[],
): void {
  let ai = aLo, bi = bLo;
  for (const [la, lb] of lcs) {
    if (ai < la) ops.push({ type: 'delete', lines: a.slice(ai, la) });
    if (bi < lb) ops.push({ type: 'insert', lines: b.slice(bi, lb) });
    ops.push({ type: 'equal', lines: [a[la]!] });
    ai = la + 1;
    bi = lb + 1;
  }
  if (ai < aHi) ops.push({ type: 'delete', lines: a.slice(ai, aHi) });
  if (bi < bHi) ops.push({ type: 'insert', lines: b.slice(bi, bHi) });
}

function coalesceOps(ops: DiffOp[]): DiffOp[] {
  const result: DiffOp[] = [];
  for (const op of ops) {
    if (op.lines.length === 0) continue;
    const last = result[result.length - 1];
    if (last && last.type === op.type) {
      last.lines.push(...op.lines);
    } else {
      result.push({ type: op.type, lines: [...op.lines] });
    }
  }
  return result;
}

// ─── Layer 2: Three-Way Merge ─────────────────────────────────────────────────

/**
 * Perform a three-way merge.
 * ancestor → base text
 * local    → one branch
 * remote   → other branch
 *
 * Non-conflicting changes are applied automatically.
 * Overlapping changes are returned as ConflictChunk objects.
 */
export function threeWayMerge(
  ancestorText: string,
  localText: string,
  remoteText: string,
): ThreeWayMergeResult {
  // Normalize line endings
  const ancestor = normalizeLines(ancestorText);
  const local = normalizeLines(localText);
  const remote = normalizeLines(remoteText);

  // Handle degenerate cases
  if (local.join('\n') === remote.join('\n')) {
    return { merged: local, conflicts: [], hasConflicts: false };
  }
  if (local.join('\n') === ancestor.join('\n')) {
    return { merged: remote, conflicts: [], hasConflicts: false };
  }
  if (remote.join('\n') === ancestor.join('\n')) {
    return { merged: local, conflicts: [], hasConflicts: false };
  }

  const localDiff = diffLines(ancestor, local);
  const remoteDiff = diffLines(ancestor, remote);

  return mergeFromDiffs(ancestor, localDiff, remoteDiff);
}

/**
 * A hunk is a contiguous change against the ancestor spine: ancestor lines
 * [ancStart, ancEnd) are replaced by `lines`. A *pure insertion* is a
 * zero-width hunk (ancStart === ancEnd) that adds `lines` at that gap without
 * removing any ancestor line.
 */
interface Hunk {
  ancStart: number;
  ancEnd: number;
  lines: string[];
}

/**
 * Decompose a diff (ancestor → variant) into hunks against the ancestor spine.
 * Kept ("equal") lines are the gaps between hunks; a delete+insert at the same
 * anchor coalesces into one replacement hunk, and a bare insert becomes a
 * zero-width hunk. This coupling is what lets the merge tell an *append* (pure
 * insert) apart from a *modification* (insert bound to a deletion).
 */
function toHunks(diff: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let ai = 0;
  let cur: Hunk | null = null;
  for (const op of diff) {
    if (op.type === 'equal') {
      if (cur) { hunks.push(cur); cur = null; }
      ai += op.lines.length;
    } else if (op.type === 'delete') {
      if (!cur) cur = { ancStart: ai, ancEnd: ai, lines: [] };
      ai += op.lines.length;
      cur.ancEnd = ai;
    } else {
      // insert — attach to the current change (or open a zero-width one)
      if (!cur) cur = { ancStart: ai, ancEnd: ai, lines: [] };
      cur.lines.push(...op.lines);
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** A zero-width hunk deletes no ancestor line — it is a pure insertion. */
function isInsert(h: Hunk): boolean {
  return h.ancStart === h.ancEnd;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Do two hunks have to be classified jointly?
 *  - their replaced ancestor ranges overlap (both touched the same line), or
 *  - both are pure inserts at the same gap (concurrent appends — unioned, not
 *    conflicted), or
 *  - one is a pure insert landing strictly inside the other's replaced range.
 * Adjacent hunks (one ends where the next begins) do NOT interact — they are
 * independent one-sided edits.
 */
function hunksInteract(a: Hunk, b: Hunk): boolean {
  if (Math.max(a.ancStart, b.ancStart) < Math.min(a.ancEnd, b.ancEnd)) return true;
  if (isInsert(a) && isInsert(b) && a.ancStart === b.ancStart) return true;
  if (isInsert(a) && !isInsert(b) && b.ancStart < a.ancStart && a.ancStart < b.ancEnd) return true;
  if (isInsert(b) && !isInsert(a) && a.ancStart < b.ancStart && b.ancStart < a.ancEnd) return true;
  return false;
}

function mergeFromDiffs(
  ancestor: string[],
  localDiff: DiffOp[],
  remoteDiff: DiffOp[],
): ThreeWayMergeResult {
  const N = ancestor.length;
  const local = toHunks(localDiff);
  const remote = toHunks(remoteDiff);

  const merged: string[] = [];
  const conflicts: ConflictChunk[] = [];
  let li = 0, ri = 0, pos = 0;

  const emitEqual = (from: number, to: number) => {
    for (let k = from; k < to; k++) merged.push(ancestor[k]!);
  };

  while (li < local.length || ri < remote.length) {
    const lh = local[li];
    const rh = remote[ri];
    const lStart = lh ? lh.ancStart : Infinity;
    const rStart = rh ? rh.ancStart : Infinity;

    // Emit the unchanged ancestor lines that precede the next change.
    const nextChange = Math.min(lStart, rStart);
    if (pos < nextChange) {
      emitEqual(pos, nextChange);
      pos = nextChange;
    }

    if (lh && rh && hunksInteract(lh, rh)) {
      if (isInsert(lh) && isInsert(rh) && lh.ancStart === rh.ancStart) {
        // Concurrent appends at the same gap — union (dedup if identical).
        if (sameLines(lh.lines, rh.lines)) merged.push(...lh.lines);
        else merged.push(...lh.lines, ...rh.lines);
      } else if (sameLines(lh.lines, rh.lines)) {
        // Both made the identical change — clean.
        merged.push(...lh.lines);
        pos = Math.max(pos, lh.ancEnd, rh.ancEnd);
      } else {
        // Overlapping, divergent edits — a genuine conflict.
        const ancLines = ancestor.slice(
          Math.min(lh.ancStart, rh.ancStart),
          Math.max(lh.ancEnd, rh.ancEnd),
        );
        const start = merged.length;
        merged.push(...lh.lines);  // local as placeholder in the merged text
        conflicts.push({
          startLine: start,
          endLine: merged.length - 1,
          ancestor: ancLines,
          local: lh.lines,
          remote: rh.lines,
        });
        pos = Math.max(pos, lh.ancEnd, rh.ancEnd);
      }
      li++; ri++;
      continue;
    }

    // Non-interacting: emit the earlier hunk as a one-sided change. At a tie,
    // a pure insert goes first so it lands before the following line's edit.
    let takeLocal: boolean;
    if (lStart !== rStart) takeLocal = lStart < rStart;
    else if (isInsert(lh!) !== isInsert(rh!)) takeLocal = isInsert(lh!);
    else takeLocal = true;

    if (takeLocal) {
      merged.push(...lh!.lines);
      pos = Math.max(pos, lh!.ancEnd);
      li++;
    } else {
      merged.push(...rh!.lines);
      pos = Math.max(pos, rh!.ancEnd);
      ri++;
    }
  }

  // Trailing unchanged ancestor lines.
  if (pos < N) emitEqual(pos, N);

  return { merged, conflicts, hasConflicts: conflicts.length > 0 };
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

// ─── Helpers exported for use in merge engine ─────────────────────────────────

/**
 * Given a raw `ConflictChunk` and the user's `resolution`, produce the
 * replacement lines the resolution selects. The single home for this rule; the
 * conflict modal imports it to build the resolved file content. Because
 * `resolution` is a discriminated union, `'custom'` always carries its text —
 * no fallback needed.
 */
export function resolveConflictChunkLines(
  chunk: ConflictChunk,
  resolution: ConflictResolution,
): string[] {
  switch (resolution.kind) {
    case 'local': return chunk.local;
    case 'remote': return chunk.remote;
    case 'both': return [...chunk.local, ...chunk.remote];
    case 'custom': return resolution.text;
  }
}

// ─── Inline conflict markers (zdiff3-style, sync v2 Step 5) ───────────────────
//
//  A conflict is surfaced NON-BLOCKINGLY: instead of a modal, the conflicting
//  bytes are written to the real path with in-context 3-way markers, clean outside
//  the conflicting hunks. The user edits them away and the next ordinary save
//  becomes the two-parent merge node that resolves it. These markers are a *local*
//  working-copy presentation — they are never pushed to a peer.

/** The seven-character conflict-marker tokens (git/zdiff3 convention). Line
 *  prefixes, so `hasConflictMarkers` can recognise them and the renderer emit them. */
export const CONFLICT_MARK_OURS = '<<<<<<<';
export const CONFLICT_MARK_BASE = '|||||||';
export const CONFLICT_MARK_SEP = '=======';
export const CONFLICT_MARK_THEIRS = '>>>>>>>';

/** Emit the marker block for one conflict chunk in zdiff3 form: ours / base /
 *  theirs. The base section (`|||||||`) is what makes it *zdiff3* rather than plain
 *  diff3 — it shows the common ancestor so the user can see what each side changed. */
function renderMarkerBlock(chunk: ConflictChunk): string[] {
  return [
    `${CONFLICT_MARK_OURS} ours`,
    ...chunk.local,
    `${CONFLICT_MARK_BASE} base`,
    ...chunk.ancestor,
    CONFLICT_MARK_SEP,
    ...chunk.remote,
    `${CONFLICT_MARK_THEIRS} theirs`,
  ];
}

/**
 * Render a {@link ThreeWayMergeResult} to text with inline zdiff3 markers at each
 * conflicting hunk and the auto-merged/clean lines verbatim everywhere else. The
 * applicator uses this on the `conflict` action's already-computed `mergeResult`
 * (which also covers the whole-file fallback where the base bytes were unavailable —
 * a single chunk with an empty ancestor). A result with no conflicts renders to its
 * clean merged text (no markers).
 *
 * `result.conflicts[i]` indexes into `result.merged` (its `local` lines sit at
 * `[startLine, endLine]` as placeholders); we replace each such span with a marker
 * block and pass every other merged line through, so nothing outside a conflicting
 * hunk is disturbed. A zero-width conflict (empty local placeholder, e.g. at EOF)
 * has `endLine < startLine` and consumes no merged line.
 */
export function renderMarkersFromResult(result: ThreeWayMergeResult): string {
  const sorted = [...result.conflicts].sort((a, b) => a.startLine - b.startLine);
  const out: string[] = [];
  let i = 0;
  let ci = 0;
  while (i < result.merged.length || ci < sorted.length) {
    const c = sorted[ci];
    if (c && c.startLine === i) {
      out.push(...renderMarkerBlock(c));
      i += Math.max(0, c.endLine - c.startLine + 1);
      ci++;
      continue;
    }
    if (i < result.merged.length) {
      out.push(result.merged[i]!);
      i++;
    } else {
      break; // no more merged lines, but a stray conflict didn't anchor — bail safely
    }
  }
  return out.join('\n');
}

/**
 * Produce the conflict-marked text for two divergent versions against a common
 * base (the spec's `renderConflictMarkers(base, ours, theirs)`): a thin wrapper that
 * three-way-merges and renders. Clean (non-conflicting) changes are auto-merged; only
 * genuinely overlapping edits get markers. Exported for direct testing; the applicator
 * renders from the already-computed `mergeResult` via {@link renderMarkersFromResult}.
 */
export function renderConflictMarkers(base: string, ours: string, theirs: string): string {
  return renderMarkersFromResult(threeWayMerge(base, ours, theirs));
}

/**
 * Does this text still contain unresolved conflict markers? Used at save time to
 * tell a genuine resolution (markers removed → emit the merge node) from a save that
 * still has markers (a non-blocking notice, no merge yet). Requires BOTH the opening
 * `<<<<<<<` and closing `>>>>>>>` marker lines so a note that merely mentions a run
 * of `<` or `=` characters isn't mistaken for a conflict.
 */
export function hasConflictMarkers(text: string): boolean {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let hasOurs = false;
  let hasTheirs = false;
  for (const line of lines) {
    if (line.startsWith(CONFLICT_MARK_OURS)) hasOurs = true;
    else if (line.startsWith(CONFLICT_MARK_THEIRS)) hasTheirs = true;
    if (hasOurs && hasTheirs) return true;
  }
  return false;
}

// ─── Parsing marked text back into segments (sync v2 Step 6) ──────────────────
//
//  The conflicts panel (Step 6) is the legible counterpart to editing the raw
//  markers by hand: it parses the on-disk marked file into a sequence of clean runs
//  and conflict blocks, lets the user pick a side per block, then writes the
//  resolved (marker-free) text — which is the ordinary Step-5 resolving save. Parsing
//  the *file* (rather than re-deriving the 3-way from the DAG heads) means the panel
//  always shows exactly what is on disk: it needs no retained base bytes, and it
//  honours any hand-edit the user already made inside a block.

/** One piece of a marked file: either a run of clean (non-conflicting) lines or a
 *  single conflict block carrying its three sides (`ours`/`base`/`theirs`). A block
 *  with no `|||||||` section (plain diff3, no base shown) has `base === []`. */
export type ConflictMarkerSegment =
  | { kind: 'clean'; lines: string[] }
  | { kind: 'conflict'; ours: string[]; base: string[]; theirs: string[] };

/**
 * Parse text containing inline zdiff3 markers (as written by
 * {@link renderMarkersFromResult}) into ordered {@link ConflictMarkerSegment}s. The
 * inverse of the renderer: clean lines pass through verbatim and each
 * `<<<<<<< … ||||||| … ======= … >>>>>>>` block becomes one `conflict` segment.
 * Matching is by line *prefix* (the tokens carry `ours`/`base`/`theirs` labels), the
 * same recognition {@link hasConflictMarkers} uses. Defensive against a truncated
 * block (EOF reached mid-conflict): whatever sides were captured are emitted, so a
 * half-deleted marker never swallows the tail of the file.
 */
export function parseConflictMarkers(text: string): ConflictMarkerSegment[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments: ConflictMarkerSegment[] = [];
  let clean: string[] = [];
  const flushClean = () => {
    if (clean.length > 0) { segments.push({ kind: 'clean', lines: clean }); clean = []; }
  };

  let state: 'clean' | 'ours' | 'base' | 'theirs' = 'clean';
  let cur: { ours: string[]; base: string[]; theirs: string[] } | null = null;

  for (const line of lines) {
    if (state === 'clean') {
      if (line.startsWith(CONFLICT_MARK_OURS)) {
        flushClean();
        cur = { ours: [], base: [], theirs: [] };
        state = 'ours';
      } else {
        clean.push(line);
      }
      continue;
    }
    // Inside a conflict block — advance on the section markers, else collect.
    if (line.startsWith(CONFLICT_MARK_BASE)) { state = 'base'; continue; }
    if (line.startsWith(CONFLICT_MARK_SEP)) { state = 'theirs'; continue; }
    if (line.startsWith(CONFLICT_MARK_THEIRS)) {
      segments.push({ kind: 'conflict', ...cur! });
      cur = null;
      state = 'clean';
      continue;
    }
    if (state === 'ours') cur!.ours.push(line);
    else if (state === 'base') cur!.base.push(line);
    else cur!.theirs.push(line);
  }

  // A block that never closed (truncated marker): emit what we captured.
  if (cur) segments.push({ kind: 'conflict', ...cur });
  else flushClean();
  return segments;
}

/** The number of conflict blocks in marked text — how many decisions the panel asks
 *  the user to make for this file. */
export function countMarkerConflicts(text: string): number {
  return parseConflictMarkers(text).filter(s => s.kind === 'conflict').length;
}

/**
 * Resolve marked text to its final (marker-free) form given a decision per conflict
 * block (`resolutions` keyed by the block's ordinal, 0-based; a missing entry
 * defaults to keeping *ours*, matching the modal's old default). Clean runs pass
 * through untouched and each block collapses to the lines its decision selects via
 * the single {@link resolveConflictChunkLines} rule — so the panel, the modal, and
 * the merge engine all agree on what "both"/"local"/"remote"/"custom" mean. The
 * output is an ordinary save the Step-5 path turns into the two-parent merge node.
 */
export function resolveMarkedText(
  text: string,
  resolutions: Map<number, ConflictResolution>,
): string {
  const out: string[] = [];
  let ci = 0;
  for (const seg of parseConflictMarkers(text)) {
    if (seg.kind === 'clean') {
      out.push(...seg.lines);
    } else {
      const resolution = resolutions.get(ci) ?? { kind: 'local' };
      out.push(...resolveConflictChunkLines(
        { startLine: 0, endLine: 0, ancestor: seg.base, local: seg.ours, remote: seg.theirs },
        resolution,
      ));
      ci++;
    }
  }
  return out.join('\n');
}
