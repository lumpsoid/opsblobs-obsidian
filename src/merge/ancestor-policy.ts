// ─────────────────────────────────────────────
//  Ancestor-advance policy (pure domain rule)
// ─────────────────────────────────────────────
//
//  The most correctness-critical CRDT invariant in the codebase (subject of the
//  recent data-loss fixes): given a merge action and the local file entry, what
//  should the file's "ancestor" (last-synced common base) hash become?
//
//  This is a pure decision over plain values — no App, no registry, no I/O — so
//  it can be locked with a plain-values unit test. The effect (calling
//  `setAncestorHash`) and the byte-hashing for `write_local` stay in the shell.

import { FileEntry, MergeAction } from '../types';

/**
 * The ancestor hash to advance to, or `null` for "leave unchanged".
 *
 * Handles the `no_op` and `send_remote` cases, whose target hash is the entry's
 * already-known `contentHash`. `write_local` is intentionally NOT handled here:
 * its target is the hash of freshly written bytes, which is async I/O the shell
 * performs (`hashContent`) — so this returns `null` for it and the shell sets the
 * ancestor itself.
 *
 * Rules (preserve exactly — see updateAncestorHashes' comment for the why):
 *   - only a live (present, non-deleted) entry can advance;
 *   - `no_op` → advance to the entry's contentHash (both sides already hold it);
 *   - `send_remote` → advance ONLY on first sync (ancestor is `null`); never
 *     otherwise, because pushing our own edit is not a peer acknowledgement and
 *     advancing there is the reported data-loss bug;
 *   - anything else → leave unchanged.
 */
export function nextAncestorHash(action: MergeAction, localEntry: FileEntry | undefined): string | null {
  if (action.type !== 'no_op' && action.type !== 'send_remote') return null;
  if (!localEntry || localEntry.deleted) return null;
  const isFirstSync = localEntry.ancestorContentHash === null;
  if (action.type === 'no_op' || isFirstSync) return localEntry.contentHash;
  return null;
}
