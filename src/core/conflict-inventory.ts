// ─────────────────────────────────────────────
//  Conflict inventory — the two-headed files awaiting resolution (sync v2 Step 6)
// ─────────────────────────────────────────────
//
//  Pure, obsidian-free. Derives the list the conflicts panel renders from the
//  registry's `conflictParents`: every file left *two-headed* by a text conflict
//  (inline markers on disk, Step 5) that the user hasn't resolved yet. Each head is
//  the version-id (op-id) of one conflicting side; because a content op's id IS its
//  HLC string (`hlcToString`), we recover per-head provenance — which device authored
//  it and when — by parsing the id. This is a *derived query* over registry state,
//  not hand-maintained bookkeeping (which Step 7 removes wholesale).

import { FileEntry, HLC } from '../types';
import { hlcFromString } from './hlc';

/** One conflicting head: its version-id and, when the id is a parseable HLC op-id,
 *  the provenance (author device + logical time) it carries. A merge-node id
 *  (`m-…`, content-addressed) doesn't parse — `hlc` is null then. */
export interface ConflictHead {
  versionId: string;
  hlc: HLC | null;
}

/** A file the user still needs to resolve: its identity, current path, and the two
 *  (or more) open heads with provenance. `heads[0]` is the local side at conflict
 *  time (`<<<<<<< ours`), `heads[1]` the remote (`>>>>>>> theirs`) — the order the
 *  applicator recorded in `conflictParents`. */
export interface ConflictListItem {
  fileId: string;
  path: string;
  heads: ConflictHead[];
}

/** Parse a version-id's HLC provenance, or null if it isn't an HLC op-id. */
function headProvenance(versionId: string): HLC | null {
  try {
    return hlcFromString(versionId);
  } catch {
    return null;
  }
}

/**
 * The two-headed files awaiting resolution, in stable path order. Feed it every
 * registry entry (`FileRegistry.getAllEntries().values()`); it keeps only those with
 * `conflictParents` set (≥2 open heads) and attaches per-head provenance. A tombstone
 * never carries `conflictParents`, so deleted entries fall out naturally.
 */
export function listTwoHeadedConflicts(entries: Iterable<FileEntry>): ConflictListItem[] {
  const items: ConflictListItem[] = [];
  for (const entry of entries) {
    const parents = entry.conflictParents;
    if (!parents || parents.length < 2) continue;
    items.push({
      fileId: entry.id,
      path: entry.path,
      heads: parents.map(versionId => ({ versionId, hlc: headProvenance(versionId) })),
    });
  }
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return items;
}
