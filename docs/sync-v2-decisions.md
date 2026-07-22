# Sync v2 — Decisions Going Forward

The durable record of *why* the sync engine is being reshaped and *what* it's
becoming. Pair with `sync-v2-migration-spec.md` (the ordered, committable steps).
Supersedes the scalar-ancestor model documented in `sync-engineering-guide.md`;
that guide will be rewritten to describe v2 once the migration lands.

Status: **decided, migration in progress.** No users, no 1.0 — we are free to
break the wire format, the on-disk format, and the API. Nothing is held for
compatibility.

---

## 1. The problem with v1

v1 tracks the three-way-merge base as a **single mutable scalar per file**
(`FileEntry.ancestorContentHash`), advanced by a **policy**
(`merge/ancestor-policy.ts`). A scalar cannot represent causal history, so the
policy is a lossy approximation, and every place the approximation diverges from
true causality became a bug that got patched locally:

- "Don't advance the ancestor on push" (a real fix for a real data-loss bug) left
  the *pusher's* ancestor stale, which caused sequential edits to **union/duplicate**
  (`"3"`+`"4"` → `"3\n4\n"`) or **silently diverge**. Patched with per-op
  `baseContentHash` + a fast-forward shortcut.
- Conflict *resolutions* needed a `supersedes` side-table so peers wouldn't
  re-conflict, plus a badge lifecycle (surface → skip/defer → converge → clear →
  self-heal) that the guide itself calls out as where "most bugs lived."

The git history (F1–F7, G11/G13, H5, S1–S5) reads as a series of leaks in one
lossy abstraction. The instinct to stop patching and fix the foundation is correct.

**Root cause:** a merge needs the *common ancestor* of two versions, which is a
fact about causal structure. v1 stores a guess and maintains it by rules; v2
records the structure and derives the ancestor.

## 2. Why not a CRDT (Yjs)

A text CRDT gives "simple local rules → convergence emerges," with no ancestor and
no three-way merge. Its correctness depends on **owning the editing surface**:
every keystroke becomes a positioned op with a stable character identity *at edit
time*.

A file-on-disk sync tool cannot own that surface. Files change by means we never
observe — mobile, `git checkout`, another plugin, an external editor, or our own
sync writing a pulled version. For all of those we only have "bytes were X, now
Y," and turning that into CRDT ops means **diffing X→Y and guessing which
characters are the same** — which is a merge heuristic, not CRDT identity. The
moment we diff, the CRDT guarantee is gone.

So a CRDT could only cover edits made inside an editor we instrument, and we'd
*still* need a diff-reconcile path for everything else — strictly more machinery.
**CRDT-for-content is the wrong tool for a sync plugin.** (Revisit only if we ever
build real-time collaboration and are willing to own the editor for all edits.)

## 3. The v2 model: a commit DAG keyed by op-id (a mini-Git for the vault)

Keep what already works — an append-only op log, UUID file identity, content-
addressed blobs, an E2E-opaque server — and make the causal structure explicit.

### Version identity is the op-id, NOT the content hash (load-bearing)

The one non-obvious decision, and the reason the first cut of Step 1/2a is being
reworked. A causal DAG needs each version to have a **unique, stable identity**.
The **content hash is the wrong identity** because content *recurs* — `empty → "3"
→ empty` (your reported case), toggling a checkbox, an undo, reverting a line. Two
edits that land on identical bytes share a content hash, so a content-hash-keyed
DAG forms a **cycle**:

```
create ""      node ""  parents {}
edit "" → "3"  node "3"  parents { "" }
edit "3" → ""  node ""  parents { "3" }   ← "" gains a 2nd parent
                ⇒  "" → "3" → "" …  a cycle → LCA breaks → spurious conflict
```

Git solved this: a commit's id is `hash(tree + parents)`, so the same tree at two
points is two different commits and the graph is acyclic. We already have the
primitive — **every op has a unique, HLC-ordered `id`** (`hlcToString(hlc)`). Use
that as the version identity:

- **Version node = op-id.** Globally unique; a parent always has a strictly lower
  HLC than its child, so the DAG is **acyclic by construction** — no cycle-avoidance
  hacks needed.
- **`parents` = parent *version-ids* (op-ids)**, never content hashes.
- **Content hash stays — but only as the blob address** (byte storage + dedup),
  decoupled from causal identity. A DAG node carries its `contentHash` as a field;
  the three-way merge fetches bytes by it.
- **The registry tracks each file's current head version-id**, so a new edit's
  parent is the head it descended from. Adopting a peer's version sets the head to
  that peer's op-id; a merge sets it to the merge op-id.

With op-ids the recurring-content case is `id_empty → id_3 → id_empty2` — three
distinct nodes, `id_3` a clean ancestor of `id_empty2` → **fast-forward, no
conflict**, and it generalizes to real multi-step LCA.

Why op-id and not a git-style "commit at sync": op-id keeps all work **incremental
and mobile-cheap** — one node per debounced edit (≈ one per "save"/button-click,
never per keystroke), formed at edit time; sync just pushes ops that already exist.
Cost is `O(changes since last sync)`, never `O(vault size)`. A commit-at-sync would
hash the whole changeset at sync time — `O(vault)` work that would nag mobile on
big vaults. (Corollary: persist the DAG **incrementally** — append edges — not by
rewriting the whole file each round, so persistence stays `O(changes)` too.)

### The rules (this is the whole thing)

1. **A version = an op-id.** It carries a `contentHash` (blob address) and a
   `fileId`.
2. **Every op names its parents** — the version-id(s) it was derived from:
   - `create` → `parents: []` (a root)
   - `update` (ordinary edit) → `parents: [prevHeadVersionId]`
   - `merge` (auto or human-resolved) → `parents: [headA, headB]`
   - `delete` → a tombstone version with `parents: [prevHeadVersionId]`
3. **The DAG is persisted and accumulated** (per `fileId`): every op ever authored
   or pulled contributes its `(versionId → parents, contentHash, fileId)` edge.
   Version-ids/hashes are tiny, so it survives content GC.
4. **A "head" is a leaf** (no child). One head = converged. Two heads = divergence.
   The registry names the local head per file.
5. **Merging two heads is pure and total:**
   - `LCA(A, B)` over the version-id DAG is the merge base `O`.
   - `A` reachable from `B` (or vice versa) → **fast-forward**, take the descendant.
   - else three-way over the *content* at `(O, A, B)`:
     - **clean** (no overlapping hunks) → deterministic merged bytes; record a merge
       version with `parents: [A, B]`.
     - **conflicting** → write diff3-marked bytes to the file (§5) and leave *both*
       heads open until a human save reconciles them.
   - `LCA` returns **ambiguous (multiple incomparable bases)** → treat as a
     conflict; never guess a base.

Fast-forward, clean-merge, and conflict all **fall out of DAG topology**. There is
no scalar ancestor field and no advance policy to get wrong.

### The one subtle rule: the determinism split

For "convergence emerges without coordination" to hold:

- **Clean merges are a deterministic function of `(O, A, B)` content.** diff3 with
  stable line-splitting and no overlapping hunks yields byte-identical output on
  every device → identical merged *content hash*. Recording the merge as a version
  lets late joiners fast-forward instead of re-deriving. (Two devices that merge the
  same pair mint different *op-ids* for the merge but identical *content*; they
  reconcile on the next round by fast-forward, since each is a descendant of both
  original heads — no storm.)
- **Human conflict resolutions are NOT deterministic** and therefore **must be
  shared** — as a merge version with `parents: [A, B]`. Peers holding either head
  adopt it by plain fast-forward (it descends from both).

This split is what v1 faked with `supersedes`. Making it structural is the point.

### Convergence for a fresh device, and why pruning can't break it

The **server op log is the source of truth**; each device's DAG is a *derived local
cache*. A new device C (empty, or with its own untracked files) does **not** read
any other device's DAG — it pulls the ops from the server and **builds its own DAG
from what it pulled**, reconstructs the shared state, and its own files become
`create` ops that merge in via create-collision handling. It lands in the same
state as everyone else. This is exactly how onboarding works today; v2 keeps it.

Therefore **local pruning/collapsing on one device is invisible to every other
device** — it only trims that device's cache, never what the server serves.
Consequently these are *optional space optimizations, deferred*, and correctness
never depends on them:

- **Default: keep the full local DAG.** No pruning, no collapsing, in the first cut.
  Nodes are tiny; it is provably correct.
- **Collapsing** (a burst of never-synced local edits points its parent straight at
  the last *shared* version) is safe by construction — those intermediates never
  reached the server, so no peer ever needed them. Add later.
- **Pruning** old nodes must be gated on a **version-vector proving every device is
  past the node** (causal stability), **never on wall-clock age** — age-based
  pruning is what could strand a long-offline device. Add later, if measured.
- The *only* thing that can break a late joiner is **server-side log compaction**
  (dropping old ops/blobs). Keep the full server log for now; if we ever compact,
  add periodic **snapshots/baselines** so C starts from a checkpoint + recent ops.
  Deferred, off the critical path.

## 4. Conflict UX — the part that must not become a maintenance burden

A bare "conflicted copy" sibling file is rejected: two files, no indication of
*what* diverged or *why*, awkward to compare, and a manual delete afterward. v2's
conflict experience is designed to be **in-context, legible, and resolvable by
ordinary editing**, while never blocking the sync.

**a. One file, at the real path, with 3-way markers.** On a conflicting hunk we
write diff3 `zdiff3`-style markers that show the **base**, **this device's**
version, and **the other device's** version — only around the hunks that actually
overlap; everything else stays clean and readable. Three-way markers (not two-way)
directly answer *"why is this a conflict"*: you see the common starting point and
what each side did to it. There is exactly one file to look at, and the
non-conflicting content is right there in place.

**b. A non-blocking Conflicts panel.** Sync never opens a modal and never waits. It
writes the markers, flags the file, and moves on. A status item ("Sync: N
conflicts") and a Conflicts view list the affected files with **provenance from the
HLC** — which two devices diverged and roughly when ("phone vs laptop, both edited
this paragraph ~14:30"). For users who don't want to hand-edit markers, the panel
offers a **side-by-side / three-column compare** (base | mine | theirs) with
per-hunk accept buttons and a live preview — the existing diff3 machinery
(`resolveConflictChunkLines`) reused as a pane instead of a blocking modal.

**c. Resolution is just editing.** A file with two heads is "in conflict." The
**next save** — whether the user hand-deleted the markers or clicked through the
panel — becomes the merge version with `parents: [A, B]`, collapsing to one head.
No resolution mode, no separate file to reconcile and delete, no `supersedes`
bookkeeping. If a save still contains conflict markers, a gentle non-blocking
notice says so (never a block).

This is strictly better than both v1's blocking modal and a bare conflict-copy: a
single in-context file, a clear "what and why," an optional GUI compare, and
resolution by the same editing the user already does.

## 5. What v2 deletes

- `merge/ancestor-policy.ts` and its test — the merge base is computed, not tracked.
- `FileEntry.ancestorContentHash` / `ancestorPath` — replaced by op parent links
  (version-ids) plus a per-file **`headVersionId`** on the registry entry (the
  current head the next edit descends from) and a small path-history for
  rename-vs-delete.
- `Operation.supersedes` and every `supersedes` shortcut in `state-merge` —
  replaced by two-parent merge nodes.
- The outstanding-conflict lifecycle in `SyncStateStore` / `SyncCoordinator`
  (badge record/clear-on-convergence/self-heal) — replaced by the *derived* fact
  "this fileId has two heads." "Conflicts" is a query over the DAG, not a
  hand-maintained set.
- The blocking `ConflictResolutionModal` gate on the sync round.

Net: fewer moving parts, and the parts that remain are consequences of the rules
rather than special cases.

## 6. Honest costs & corners

- **LCA computation.** Needs the parent DAG per file. Criss-cross histories can
  have *two* merge bases; v2 starts simple (multiple bases → treat as conflict →
  markers) and can adopt recursive merge later. Bounded by op-log size per file.
- **GC vs. history.** A three-way merge needs the *base bytes*. Retain content for
  reachable heads + plausible merge bases under the existing age policy; retain the
  cheap parent-link *hashes* longer. When base bytes are gone, **degrade to a
  conflict (markers)** — never fabricate. (The code already has this instinct.)
- **DAG growth.** Parent links are hashes (tiny). Content GC is unchanged.
  Tombstones/merge nodes prune once a version vector proves causal stability
  (later; not required for correctness).
- **Determinism discipline.** Any non-determinism in the clean-merge path (locale,
  line-ending handling, unstable sort) breaks convergence. The merge must be a
  pure, total, platform-independent function; this is a testing invariant, not a
  hope.

## 7. Non-goals (v2)

- Real-time collaboration / character-level CRDT.
- Automatic resolution of *overlapping* text conflicts (we surface, we don't guess
  — but non-blocking, via markers, not a modal).
- A complete audit log / history browser (the DAG could support one later; not now).
- Server-side merge (the server stays an opaque, untrusted op store).

## 8. The prime directive is unchanged

**The user's data is critical and must never be silently overridden, dropped, or
left divergent.** v2 honors it *more* strictly than v1: clean cases converge with
no prompt, genuine conflicts are surfaced in-context and never gated behind a
dialog, and every ambiguous case degrades to "keep both sides visible," never to a
guess.
