// ─────────────────────────────────────────────
//  Version DAG — the content causal graph (sync v2)
// ─────────────────────────────────────────────
//
//  Pure, obsidian-free. Records the causal parent links of every content version
//  this device has authored or pulled (versionId → parent versionIds, per fileId),
//  so the merge can compute the true three-way base (LCA) from structure rather
//  than a locally-tracked scalar ancestor — which cannot testify to what a peer's
//  edit was based on.
//
//  A version's identity is the OP-ID (`op.id`, an HLC string), NOT its content
//  hash: content recurs (empty → "3" → empty, undo, a checkbox toggle), and a
//  content-hash-keyed DAG then forms a CYCLE that breaks LCA and re-introduces the
//  spurious-conflict bug. Op-ids are unique and HLC-monotonic (a parent's HLC is
//  strictly below its child's), so the DAG is acyclic by construction — Git's
//  hash(tree+parents) trick, using the op-id we already mint. The content hash is
//  kept only as the blob address: each node carries its `contentHash` so the
//  three-way merge can fetch the base's bytes. Nodes are tiny (ids + a hash), so
//  the graph is retained even after the content-store GCs the bytes. See
//  docs/sync-v2-decisions.md §3.

export interface VersionNode {
  parents: Set<string>;
  /** The blob address of this version's content — decoupled from causal identity
   *  (which is the op-id key). The merge fetches the base's bytes by this. */
  contentHash: string;
  fileId: string;
}

/** Returned by {@link VersionDag.mergeBase} when two heads have more than one
 *  incomparable common ancestor (an ambiguous criss-cross). The caller must not
 *  pick a base — surface a conflict instead of guessing. */
export const MULTIPLE_BASES = 'MULTIPLE' as const;
export type MergeBaseResult = string | null | typeof MULTIPLE_BASES;

export class VersionDag {
  private nodes = new Map<string, VersionNode>();

  /**
   * Record a version (keyed by its op-id `versionId`) and its causal parents (the
   * parent version-ids). Idempotent — re-recording the same version unions the
   * parent set (so seeing an op twice, or a merge node's second parent learned
   * later, never loses an edge) and fills in a `contentHash`/`fileId` that a
   * parent-only stub recorded earlier may still be missing. A self-parent
   * (`parent === versionId`) is ignored defensively so a malformed op can't create
   * a 1-cycle (though op-ids are HLC-monotonic, so this can't arise in practice).
   *
   * Returns whether this call actually mutated the graph (a new node, a
   * newly-learned parent, or a backfilled hash/fileId) — the incremental
   * persistence layer journals only genuinely-new edges, so re-recording an op we
   * already hold (our own ops re-pull every round) writes nothing.
   */
  addVersion(versionId: string, parents: string[], contentHash: string, fileId: string): boolean {
    let changed = false;
    let node = this.nodes.get(versionId);
    if (!node) {
      node = { parents: new Set<string>(), contentHash, fileId };
      this.nodes.set(versionId, node);
      changed = true;
    } else {
      // A node may have been created as a parent reference before its own edge was
      // recorded; backfill its blob address / fileId once the real op arrives.
      if (!node.contentHash && contentHash) { node.contentHash = contentHash; changed = true; }
      if (!node.fileId && fileId) { node.fileId = fileId; changed = true; }
    }
    for (const p of parents) {
      if (p !== versionId && !node.parents.has(p)) { node.parents.add(p); changed = true; }
    }
    return changed;
  }

  has(versionId: string): boolean {
    return this.nodes.has(versionId);
  }

  /** The number of recorded nodes. `0` means the graph is empty — which, on a
   *  device that has already consumed server ops (cursor > 0), is the signature of
   *  a lost/corrupt `version-dag.json` (which loads as an empty DAG), signalling a
   *  rebuild-from-log rather than a fresh device. */
  size(): number {
    return this.nodes.size;
  }

  /**
   * The open *leaves* of a file — the versions of `fileId` that no other node
   * descends from (nothing lists them as a parent). One leaf ⇒ converged; two or
   * more ⇒ divergence (concurrent heads that were never united into a merge node).
   * Used by the multi-head reconciliation sweep (server-sync) to find concurrent
   * remote heads the HLC-max projection collapsed and left un-reconciled, so the
   * puller folds them itself rather than waiting on the peer that merged them. A
   * parent-only stub (no own edge recorded yet) carries `fileId === ''`, so it is
   * never mis-reported as a leaf of a real file.
   */
  leaves(fileId: string): string[] {
    const hasChild = new Set<string>();
    for (const node of this.nodes.values()) {
      for (const p of node.parents) hasChild.add(p);
    }
    const out: string[] = [];
    for (const [id, node] of this.nodes) {
      if (node.fileId === fileId && !hasChild.has(id)) out.push(id);
    }
    return out;
  }

  /**
   * True when `versionId` is a *merge node* — a reconciliation of two (or more)
   * heads, i.e. it has ≥2 causal parents. Distinguishes a user-resolved conflict
   * (restore/keep-deleted/binary pick, or a clean/text merge) from a plain linear
   * edit, so the delete/create-collision branches auto-adopt only genuine
   * resolutions (a peer settled the conflict) rather than any descendant (sync v2,
   * the structural replacement for the retired `supersedes` tag). An unknown
   * version — present only as an as-yet-unrecorded parent reference — reads as not
   * a merge node.
   */
  isMergeNode(versionId: string): boolean {
    return (this.nodes.get(versionId)?.parents.size ?? 0) >= 2;
  }

  /** The content hash (blob address) of a version, or `undefined` if unknown —
   *  the merge fetches the three-way base's bytes by this. A version present only
   *  as an as-yet-unrecorded parent reference has no content hash. */
  contentHashOf(versionId: string): string | undefined {
    return this.nodes.get(versionId)?.contentHash || undefined;
  }

  /**
   * True when `maybeAncestor` is `descendant` itself or is reachable by walking
   * `descendant`'s parents transitively. Cycle-safe (visited set).
   */
  isAncestor(maybeAncestor: string, descendant: string): boolean {
    if (maybeAncestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = this.nodes.get(cur);
      if (!node) continue;
      for (const p of node.parents) {
        if (p === maybeAncestor) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /**
   * The lowest common ancestor of two versions: the single deepest hash that is an
   * ancestor of both. Returns `null` when they share no ancestor, or
   * {@link MULTIPLE_BASES} when there is more than one incomparable common ancestor
   * (criss-cross) — an ambiguity the caller must resolve as a conflict, never guess.
   * Deterministic (independent of argument order and iteration order).
   */
  mergeBase(a: string, b: string): MergeBaseResult {
    const ancA = this.ancestors(a);
    const ancB = this.ancestors(b);
    const common = new Set<string>();
    for (const h of ancA) if (ancB.has(h)) common.add(h);
    if (common.size === 0) return null;
    // The LCA(s) are the *maximal* common ancestors — those not a proper ancestor of
    // any other common ancestor. Exactly one → the merge base; ≥2 incomparable →
    // ambiguous (criss-cross).
    //
    // Computed in ONE multi-source upward walk, not the former O(common²·(V+E))
    // pairwise `isAncestor` scan (which was the B2b merge-round cliff — its cost grew
    // ~2·depth per call, see docs/mobile-perf-baseline-spec.md). Walk up from every
    // common node's PARENTS, marking each node reached: a common node so marked is a
    // proper ancestor of some other common node, hence NOT maximal. Touches each edge
    // once → O(V+E), and issues zero `isAncestor` calls. Correct independent of node
    // ordering (a set-membership question), so `mergeBase(a,b) === mergeBase(b,a)` —
    // determinism preserved. Cycle-safe via the `dominated` visited set.
    const dominated = new Set<string>();
    const stack: string[] = [];
    for (const c of common) {
      const node = this.nodes.get(c);
      if (node) for (const p of node.parents) stack.push(p);
    }
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (dominated.has(cur)) continue;
      dominated.add(cur);
      const node = this.nodes.get(cur);
      if (node) for (const p of node.parents) stack.push(p);
    }
    let base: string | null = null;
    let count = 0;
    for (const c of common) {
      if (dominated.has(c)) continue;   // c is an ancestor of another common node
      base = c;
      if (++count > 1) return MULTIPLE_BASES;
    }
    return count === 1 ? base : MULTIPLE_BASES;
  }

  /**
   * The content hashes of `versionId` and all its ancestors (blob addresses along
   * this head's history). The three-way base for any merge of this head against a
   * peer is `LCA(head, peerHead)`, which is always an ancestor of `head` — so
   * staging the bytes of these hashes (those the content store still holds) makes
   * every reachable base available to the pure merge without knowing the peer head
   * in advance. Cycle-safe.
   */
  reachableContentHashes(versionId: string): Set<string> {
    const out = new Set<string>();
    for (const v of this.ancestors(versionId)) {
      const ch = this.nodes.get(v)?.contentHash;
      if (ch) out.add(ch);
    }
    return out;
  }

  /** Every ancestor of `hash`, including `hash` itself. Cycle-safe. */
  private ancestors(hash: string): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [hash];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = this.nodes.get(cur);
      if (node) for (const p of node.parents) stack.push(p);
    }
    return seen;
  }

  /**
   * A cheap in-memory copy of the graph for a single sync round. Each node is
   * duplicated with a *fresh* `parents` Set, so mutating the clone (folding this
   * round's pending ops into it for the staging reachability walk) cannot alias or
   * grow the parent lists of the original — the pristine pre-round graph that
   * `recordVersionEdges` still needs to journal this round's genuinely-new edges
   * from (see the round-residual spec §3.1: sharing one instance would let
   * `buildLocalState` pre-add the pending edges so `recordVersionEdges`'s
   * `addVersion` returns `false` and never journals them). Cheaper than
   * `fromJSON(toJSON())` — no JSON round-trip, no journal replay, no re-validation.
   * O(nodes + edges).
   */
  clone(): VersionDag {
    const copy = new VersionDag();
    for (const [versionId, node] of this.nodes) {
      copy.nodes.set(versionId, {
        parents: new Set(node.parents),
        contentHash: node.contentHash,
        fileId: node.fileId,
      });
    }
    return copy;
  }

  /** Serializable snapshot (Set → array) for persistence. */
  toJSON(): Record<string, { parents: string[]; contentHash: string; fileId: string }> {
    const out: Record<string, { parents: string[]; contentHash: string; fileId: string }> = {};
    for (const [versionId, node] of this.nodes) {
      out[versionId] = { parents: [...node.parents], contentHash: node.contentHash, fileId: node.fileId };
    }
    return out;
  }

  /** Rebuild from {@link toJSON} output. Defensive against a malformed blob. */
  static fromJSON(obj: unknown): VersionDag {
    const dag = new VersionDag();
    if (obj && typeof obj === 'object') {
      for (const [versionId, raw] of Object.entries(obj as Record<string, unknown>)) {
        const rec = (raw ?? {}) as { parents?: unknown; contentHash?: unknown; fileId?: unknown };
        const parents = Array.isArray(rec.parents) ? rec.parents.filter((p): p is string => typeof p === 'string') : [];
        const contentHash = typeof rec.contentHash === 'string' ? rec.contentHash : '';
        const fileId = typeof rec.fileId === 'string' ? rec.fileId : '';
        dag.addVersion(versionId, parents, contentHash, fileId);
      }
    }
    return dag;
  }
}
