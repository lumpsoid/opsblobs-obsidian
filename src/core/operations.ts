// ─────────────────────────────────────────────
//  Operation factories — the op vocabulary
// ─────────────────────────────────────────────
//
//  The single catalog of the kinds of Operation the system emits and the
//  field-level rules each one carries. The split of concerns:
//
//    · OperationLogger owns *when* an op is emitted — the stateful vault /
//      registry / content-store / HLC orchestration.
//    · This module owns *what shape* it has.
//
//  Every op — a live edit, an offline-capture reconcile, or a re-emitted user
//  resolution — is minted through one of these factories, so the shared fields
//  (format version, id) are stamped in exactly one place and a new op kind or a
//  format-version bump has a single, obvious home.
//
//  Pure and obsidian-free: each factory is a total function of its arguments.

import { HLC, Operation, OP_FORMAT_VERSION } from '../types';
import { hlcToString } from './hlc';

/**
 * Stamp the fields every op shares: the format version and the id. The HLC is
 * already unique per op per device — its counter increments on every `now()` —
 * and totally ordered, so `hlcToString(hlc)` is a collision-free, deterministic
 * op id; no separate wall-clock+random token is needed.
 */
function stamp(fields: Omit<Operation, 'v' | 'id'>): Operation {
  return { v: OP_FORMAT_VERSION, id: hlcToString(fields.hlcTimestamp), ...fields };
}

export const Ops = {
  /** A file first seen by sync. `contentHash` is the SHA-256 of the new bytes;
   *  its blob is uploaded alongside the op. A create is a DAG root, so it has no
   *  parents. */
  create(fileId: string, path: string, contentHash: string, hlc: HLC): Operation {
    return stamp({ hlcTimestamp: hlc, fileId, type: 'create', path, contentHash, parents: [] });
  },

  /** An edit to a tracked file. `contentHash` is the post-edit content; `base` is
   *  the content it was derived from (the pre-edit hash) and becomes the op's sole
   *  parent, so a peer can reconstruct the content DAG and compute the true
   *  three-way base. Omit only when the base is genuinely unknown (⇒ a root). */
  update(fileId: string, path: string, contentHash: string, hlc: HLC, base?: string): Operation {
    return stamp({ hlcTimestamp: hlc, fileId, type: 'update', path, contentHash, parents: base ? [base] : [] });
  },

  /** A tracked file removed. `contentHash` is the now-deleted content — no blob
   *  is uploaded for a delete; the hash only lets a peer match the tombstone to
   *  bytes it may still hold. `base` (the content the deletion was made against)
   *  becomes the tombstone version's parent, for the same DAG reason as
   *  {@link update}. */
  delete(fileId: string, path: string, contentHash: string, hlc: HLC, base?: string): Operation {
    return stamp({ hlcTimestamp: hlc, fileId, type: 'delete', path, contentHash, parents: base ? [base] : [] });
  },

  /** A rename. Content is unchanged, so `contentHash` is the same as before; the
   *  move is just a new `path` for the same `fileId` (identity is the UUID, so
   *  the projection needs no from-path). Content is unchanged, so the move carries
   *  no content parent (it is not a new content version). */
  move(fileId: string, path: string, contentHash: string, hlc: HLC): Operation {
    return stamp({ hlcTimestamp: hlc, fileId, type: 'move', path, contentHash, parents: [] });
  },

  /** A user-resolved content conflict, re-emitted as an op so it replicates like
   *  any edit. `supersedes` names the two conflicting content hashes the
   *  resolution settles — a peer still holding either adopts it instead of
   *  re-prompting (see FileEntry.supersedes). `hlc` must dominate the remote it
   *  supersedes so it wins last-writer-wins. (Step 4 makes this a two-parent merge
   *  node; for now it carries no parents, preserving current behaviour.) */
  resolveUpdate(fileId: string, path: string, contentHash: string, hlc: HLC, supersedes: string[]): Operation {
    return stamp({ hlcTimestamp: hlc, fileId, type: 'update', path, contentHash, parents: [], supersedes });
  },

  /** A delete/modify conflict the user resolved by accepting the deletion. Like
   *  {@link resolveUpdate} but a tombstone; `contentHash` is the superseded
   *  (now-deleted) content. */
  resolveDelete(fileId: string, path: string, contentHash: string, hlc: HLC, supersedes: string[]): Operation {
    return stamp({ hlcTimestamp: hlc, fileId, type: 'delete', path, contentHash, parents: [], supersedes });
  },
};
