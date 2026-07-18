// ─────────────────────────────────────────────
//  Diff + Three-Way Merge (bundled, zero deps)
//  Phase 2.2
// ─────────────────────────────────────────────
//
//  Layer 1: Patience diff (LCS-based, anchors on unique lines — better for markdown)
//  Layer 2: Three-way merge using two diffs against a common ancestor

import { ConflictChunk, ThreeWayMergeResult } from '../types';

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
  const prev: number[] = new Array(pairs.length).fill(-1);
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
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
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

type Region =
  | { type: 'equal'; lines: string[] }
  | { type: 'local'; lines: string[] }
  | { type: 'remote'; lines: string[] }
  | { type: 'conflict'; local: string[]; remote: string[]; ancestor: string[] };

function mergeFromDiffs(
  ancestor: string[],
  localDiff: DiffOp[],
  remoteDiff: DiffOp[],
): ThreeWayMergeResult {
  // Build a sequence of regions from the ancestor's perspective
  const regions: Region[] = [];

  // Flatten diffs into aligned chunks using ancestor as spine
  const localChunks = expandDiff(ancestor, localDiff);
  const remoteChunks = expandDiff(ancestor, remoteDiff);

  // Walk ancestor positions, emitting regions
  let li = 0, ri = 0;

  while (li < localChunks.length || ri < remoteChunks.length) {
    const lc = localChunks[li];
    const rc = remoteChunks[ri];

    if (!lc && !rc) break;

    // Both at same ancestor position — equal on both sides
    if (lc?.anchorIdx === rc?.anchorIdx && lc?.type === 'keep' && rc?.type === 'keep') {
      appendRegion(regions, { type: 'equal', lines: [lc.line] });
      li++; ri++;
      continue;
    }

    // Collect run of inserts from local
    const localInserts: string[] = [];
    while (li < localChunks.length && localChunks[li]!.type === 'insert') {
      localInserts.push(localChunks[li]!.line);
      li++;
    }

    // Collect run of inserts from remote
    const remoteInserts: string[] = [];
    while (ri < remoteChunks.length && remoteChunks[ri]!.type === 'insert') {
      remoteInserts.push(remoteChunks[ri]!.line);
      ri++;
    }

    if (localInserts.length > 0 && remoteInserts.length > 0) {
      // Both inserted — true conflict if different content
      if (JSON.stringify(localInserts) !== JSON.stringify(remoteInserts)) {
        regions.push({ type: 'conflict', local: localInserts, remote: remoteInserts, ancestor: [] });
      } else {
        appendRegion(regions, { type: 'equal', lines: localInserts });
      }
    } else if (localInserts.length > 0) {
      appendRegion(regions, { type: 'local', lines: localInserts });
    } else if (remoteInserts.length > 0) {
      appendRegion(regions, { type: 'remote', lines: remoteInserts });
    }

    // Now handle deletions and keeps at the current ancestor position
    const lKeep = localChunks[li];
    const rKeep = remoteChunks[ri];

    if (!lKeep && !rKeep) break;

    if (lKeep?.anchorIdx !== rKeep?.anchorIdx) break; // alignment issue, bail

    if (lKeep?.type === 'keep' && rKeep?.type === 'keep') {
      appendRegion(regions, { type: 'equal', lines: [lKeep.line] });
      li++; ri++;
    } else if (lKeep?.type === 'delete' && rKeep?.type === 'delete') {
      // Both deleted — no conflict
      li++; ri++;
    } else if (lKeep?.type === 'delete' && rKeep?.type === 'keep') {
      // Local deleted, remote kept — local wins (it's an explicit deletion)
      // Actually this IS a conflict: remote wants to keep, local deleted
      regions.push({ type: 'conflict', local: [], remote: [rKeep.line], ancestor: [lKeep.line] });
      li++; ri++;
    } else if (lKeep?.type === 'keep' && rKeep?.type === 'delete') {
      regions.push({ type: 'conflict', local: [lKeep.line], remote: [], ancestor: [rKeep.line] });
      li++; ri++;
    }
  }

  // Merge adjacent conflicts
  const mergedRegions = mergeAdjacentConflicts(regions);

  // Build output
  const merged: string[] = [];
  const conflicts: ConflictChunk[] = [];
  let lineOffset = 0;

  for (const region of mergedRegions) {
    if (region.type === 'equal') {
      merged.push(...region.lines);
      lineOffset += region.lines.length;
    } else if (region.type === 'local') {
      merged.push(...region.lines);
      lineOffset += region.lines.length;
    } else if (region.type === 'remote') {
      merged.push(...region.lines);
      lineOffset += region.lines.length;
    } else {
      // Conflict — use local as placeholder
      const start = lineOffset;
      merged.push(...region.local);
      const end = lineOffset + region.local.length - 1;
      lineOffset += region.local.length;
      conflicts.push({
        startLine: start,
        endLine: end,
        ancestor: region.ancestor,
        local: region.local,
        remote: region.remote,
      });
    }
  }

  return { merged, conflicts, hasConflicts: conflicts.length > 0 };
}

interface ExpandedLine {
  type: 'keep' | 'delete' | 'insert';
  line: string;
  anchorIdx: number;  // index in ancestor (for inserts, the preceding anchor idx)
}

function expandDiff(ancestor: string[], diff: DiffOp[]): ExpandedLine[] {
  const result: ExpandedLine[] = [];
  let ai = 0;
  for (const op of diff) {
    if (op.type === 'equal') {
      for (const line of op.lines) {
        result.push({ type: 'keep', line, anchorIdx: ai });
        ai++;
      }
    } else if (op.type === 'delete') {
      for (const line of op.lines) {
        result.push({ type: 'delete', line, anchorIdx: ai });
        ai++;
      }
    } else {
      // insert: associate with preceding ancestor position
      for (const line of op.lines) {
        result.push({ type: 'insert', line, anchorIdx: ai });
      }
    }
  }
  return result;
}

function appendRegion(regions: Region[], region: Region): void {
  const last = regions[regions.length - 1];
  if (last && last.type === region.type && region.type !== 'conflict') {
    (last as any).lines.push(...(region as any).lines);
  } else {
    regions.push(region);
  }
}

function mergeAdjacentConflicts(regions: Region[]): Region[] {
  const result: Region[] = [];
  for (const r of regions) {
    const last = result[result.length - 1];
    if (last?.type === 'conflict' && r.type === 'conflict') {
      last.local.push(...r.local);
      last.remote.push(...r.remote);
      last.ancestor.push(...r.ancestor);
    } else {
      result.push(r);
    }
  }
  return result;
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

// ─── Helpers exported for use in merge engine ─────────────────────────────────

export function applyConflictResolutions(
  mergeResult: ThreeWayMergeResult,
  resolutions: Map<number, ConflictChunk>,
): string {
  const lines = [...mergeResult.merged];
  // Apply resolutions in reverse order to preserve line indices
  const sorted = Array.from(resolutions.entries()).sort((a, b) => b[0] - a[0]);
  for (const [idx, chunk] of sorted) {
    const resolved = getResolutionLines(chunk);
    lines.splice(chunk.startLine, chunk.local.length, ...resolved);
  }
  return lines.join('\n');
}

function getResolutionLines(chunk: ConflictChunk): string[] {
  switch (chunk.resolution) {
    case 'local': return chunk.local;
    case 'remote': return chunk.remote;
    case 'both': return [...chunk.local, ...chunk.remote];
    case 'custom': return chunk.customText ?? chunk.local;
    default: return chunk.local;
  }
}
