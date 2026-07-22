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
   */
  addVersion(versionId: string, parents: string[], contentHash: string, fileId: string): void {
    let node = this.nodes.get(versionId);
    if (!node) {
      node = { parents: new Set<string>(), contentHash, fileId };
      this.nodes.set(versionId, node);
    } else {
      // A node may have been created as a parent reference before its own edge was
      // recorded; backfill its blob address / fileId once the real op arrives.
      if (!node.contentHash && contentHash) node.contentHash = contentHash;
      if (!node.fileId && fileId) node.fileId = fileId;
    }
    for (const p of parents) {
      if (p !== versionId) node.parents.add(p);
    }
  }

  has(versionId: string): boolean {
    return this.nodes.has(versionId);
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
    const common: string[] = [];
    for (const h of ancA) if (ancB.has(h)) common.push(h);
    if (common.length === 0) return null;
    // The LCA(s) are the *maximal* common ancestors — those that are not a proper
    // ancestor of any other common ancestor. Exactly one → the merge base; more
    // than one incomparable → ambiguous.
    const maximal = common.filter(
      x => !common.some(y => y !== x && this.isAncestor(x, y)),
    );
    return maximal.length === 1 ? maximal[0]! : MULTIPLE_BASES;
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
