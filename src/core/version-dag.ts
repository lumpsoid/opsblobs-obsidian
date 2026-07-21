// ─────────────────────────────────────────────
//  Version DAG — the content causal graph (sync v2)
// ─────────────────────────────────────────────
//
//  Pure, obsidian-free. Records the causal parent links of every content version
//  this device has authored or pulled (contentHash → parent content hashes, per
//  fileId), so the merge can compute the true three-way base (LCA) from structure
//  rather than a locally-tracked scalar ancestor — which cannot testify to what a
//  peer's edit was based on. Parent links are tiny (hashes), so this graph is kept
//  even after the content-store GCs the bytes. See docs/sync-v2-decisions.md.

export interface VersionNode {
  parents: Set<string>;
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
   * Record a version and its causal parents. Idempotent — re-recording the same
   * hash unions the parent set (so seeing an op twice, or a merge node's second
   * parent later, never loses an edge). A self-parent (`parent === hash`) is
   * ignored defensively so a malformed op can't create a 1-cycle.
   */
  addVersion(hash: string, parents: string[], fileId: string): void {
    let node = this.nodes.get(hash);
    if (!node) {
      node = { parents: new Set<string>(), fileId };
      this.nodes.set(hash, node);
    }
    for (const p of parents) {
      if (p !== hash) node.parents.add(p);
    }
  }

  has(hash: string): boolean {
    return this.nodes.has(hash);
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
  toJSON(): Record<string, { parents: string[]; fileId: string }> {
    const out: Record<string, { parents: string[]; fileId: string }> = {};
    for (const [hash, node] of this.nodes) {
      out[hash] = { parents: [...node.parents], fileId: node.fileId };
    }
    return out;
  }

  /** Rebuild from {@link toJSON} output. Defensive against a malformed blob. */
  static fromJSON(obj: unknown): VersionDag {
    const dag = new VersionDag();
    if (obj && typeof obj === 'object') {
      for (const [hash, raw] of Object.entries(obj as Record<string, unknown>)) {
        const rec = (raw ?? {}) as { parents?: unknown; fileId?: unknown };
        const parents = Array.isArray(rec.parents) ? rec.parents.filter((p): p is string => typeof p === 'string') : [];
        const fileId = typeof rec.fileId === 'string' ? rec.fileId : '';
        dag.addVersion(hash, parents, fileId);
      }
    }
    return dag;
  }
}
