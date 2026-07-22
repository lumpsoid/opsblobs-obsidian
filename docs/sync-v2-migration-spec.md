# Sync v2 — Migration Spec

Ordered, sequential steps to evolve the engine from the v1 scalar-ancestor model to
the **v2 commit DAG keyed by op-id** described in `sync-v2-decisions.md` (read that
first — especially §3 "Version identity is the op-id, NOT the content hash"). Each
step is a single coherent commit that leaves `npm run build` and `npx vitest run`
**green** (tests may be intentionally updated within the step that changes their
contract). No compatibility is preserved — there are no users and no 1.0.

---

## ⚑ Current status & context — READ THIS FIRST

This section is the handoff for a fresh context. It states exactly what is on disk,
what is sound, what needs rework, and the immediate next action.

### The core decision (the pivot)

A version's identity in the DAG is the **op-id** (`op.id`, an HLC string), NOT its
content hash. Content recurs (`empty → "3" → empty`, undo, checkbox toggles), and a
content-hash-keyed DAG then forms a **cycle** that breaks LCA and re-introduces the
spurious-conflict bug we set out to kill. Op-ids are unique and HLC-monotonic, so
the DAG is acyclic by construction (this is Git's `hash(tree+parents)` trick, using
the op-id we already mint). **Content hash is kept only as the blob address.** See
decisions §3 for the full rationale, the mobile argument (op-id keeps work
`O(changes)`, not `O(vault)`), and why local pruning/collapsing is deferred and
can never break a fresh device's convergence (the server op log is the source of
truth; each device's DAG is a derived cache).

### What is committed on `sync-robustness-fixes` (newest first)

- `b62e039` feat(merge): retire the scalar ancestor + supersedes; reconcile over
  the op-id DAG — **THE folded Step 3 core, DONE (atomic).** The scalar content
  ancestor and `supersedes` are gone; the three-way base is the DAG LCA and every
  reconciliation (content/delete/binary/create-collision resolution + clean merge)
  is a two-parent merge node peers fast-forward onto. `FileEntry` drops
  `ancestorContentHash`/`ancestorPath`/`supersedes`, gains `lastSyncedPath`;
  `Operation` drops `supersedes`; conflict actions carry `parents` not
  `parentHashes`. New: `isUnchangedSinceBase` (DAG + `lastSyncedPath` rename check,
  reads the synced path from whichever side has it — preserves the delete/rename
  asymmetry for a projected remote), `VersionDag.isMergeNode`, `Ops.mergeDelete` /
  `recordMergeDelete`, applicator `mintMergeResolution`, registry `setSyncedPath`,
  applicator `updateSyncedPaths` (path-only, no_op / first-sync send_remote).
  Deleted `merge/ancestor-policy.ts` + test. `buildLocalState` folds the round's
  pending-op edges into the in-memory staging DAG so a fresh head reaches its base
  for byte staging (the old ancestor-staging line had masked this). **200 pass.**
- `af4a7a4` feat(sync): stage DAG-reachable base bytes in buildLocalState —
  **Step 3 prerequisite, DONE.** `buildLocalState` stages the bytes of every
  version reachable from each file's head (`VersionDag.reachableContentHashes`),
  so the merge base LCA(localHead, peerHead) — always an ancestor of the local
  head — is available even when deeper than the last-synced version (#4).
  Additive/behaviour-preserving.
- `0cf33b8` fix(dag): keep a renamed file connected across the move — **Step 3
  prerequisite, DONE.** `Ops.move` carries the content head it renamed as its
  parent; `reconstructRemoteState` projects a move's head as that parent (not the
  move op id). Without this, LCA/FF over a renamed remote head would strand once
  the scalar ancestor is removed. Behaviour-preserving (scalar still masks it now).
- `2595d94` feat(merge): content-conflict resolutions become two-parent merge
  nodes — **Step 4b, DONE.** A user-resolved content conflict is re-emitted as a
  two-parent merge node (parents = the two conflicting heads; content-addressed
  `m-` id); peers adopt it by the existing DAG fast-forward. `supersedes` remains
  ONLY for the binary/delete/create-collision paths (moved in the folded Step 3).
- `b1ef94e` feat(merge): clean merges become pushed two-parent DAG nodes — **Step
  4a, DONE.** A clean three-way merge mints a real two-parent merge op (deterministic
  content-addressed `m-<sha256(sorted-parents+contentHash)>` id via `Ops.merge` /
  `mergeVersionId`), pushed like a resolution so its edges+blob replicate. This
  **closes the Step-3/4 ordering hazard**: the next edit off a merged file now
  descends from a real DAG node, not a synthetic head. Also fixed finding #1: the
  `write_local` adoption path carries the remote op's real `headVersionId` and
  `adoptRemote` records it (an op-id is not always `hlcToString(hlc)`).
- `d61ab66` feat(merge): derive the three-way base from the op-id DAG (LCA) —
  **Rework R1-flip + R2 + Step 2b, DONE.** `parents` are version-ids; the DAG is
  keyed by op-id carrying `contentHash`; the merge fast-forwards / LCA-bases off
  the DAG.
- `e0be88a` refactor(sync): track headVersionId on the registry — **Rework R1a
  (additive), DONE.** Registry persists `headVersionId`; nothing read it yet.
- `50dd790` feat: persist a content version-DAG — Step 2a (superseded/reworked by
  the two commits above; the store/plumbing were reused).
- `b511e64` docs: refine Step 2 into 2a/2b.
- `78de087` refactor: op `parents[]` replacing `baseContentHash` — Step 1
  (parents' *meaning* reworked to version-ids by `d61ab66`).
- `b6b3bed` docs: v2 decisions + this spec.
- (earlier, unrelated to v2) `436ad7c` fast-forward sequential-edit fix (the
  `baseContentHash`+FF shipped in v1; superseded by the DAG), `cca55a6` onload
  gotcha, `628b5a7` cold-start phantom-delete fix.

### Why R1 became two commits (not one)

The merge's fast-forward is load-bearing and depended on `parents` being **content
hashes** (surfaced as `re.ancestorContentHash`). Flipping `parents` to version-ids
*breaks* that FF until the merge reads the DAG — so R1's flip could not be a
separately-green commit. The green-gate-honouring split was: `e0be88a` adds
`headVersionId` additively (nothing reads it → trivially green), then `d61ab66`
flips `parents` **and** wires the DAG merge together (the DAG restores the FF the
content-hash ancestor used to provide). This matches the spec's own note that "the
reworked Step 2b is folded into R2's Done-when."

### Immediate next action — Step 6 (conflicts panel + compare UX)

> **➡ Step 5 is DONE (inline conflict markers).** A text `conflict` is now surfaced
> NON-BLOCKINGLY as inline zdiff3 markers at the real path — no modal, no cursor hold.
> The file is recorded *two-headed* (`FileEntry.conflictParents = [A, B]` via
> `registry.markConflicted`); the merge holds (never re-conflicts / nests markers) or
> adopts a peer's resolution; the next ordinary save that removes the markers re-emits
> a two-parent merge node (`op-logger.flushModify` two-headed branch → `Ops.merge`),
> which peers fast-forward onto. New: `diff3.renderConflictMarkers`/
> `renderMarkersFromResult`/`hasConflictMarkers`; state-merge `resolveContentConflict`
> two-headed guard; applicator `conflict` case writes markers (F5-drift-guarded) instead
> of calling a resolver — the `onConflict` handler + coordinator `decideContentConflict`
> + main.ts `ConflictResolutionModal` wiring are REMOVED (delete/binary conflicts keep
> their modal/defer handlers). `src/ui/conflict-modal.ts` is now dead code, retained as
> the 3-way-compare reference for Step 6. Green gate: **206 pass**
> (`npm run build && npx vitest run`). New tests: `conflict-markers.test.ts` (pure
> render/detect), `inline-conflict-resolution.test.ts` (two-device e2e incl. the
> still-has-markers notice + no-open-peer adoption). Rewrote the conflict assertions in
> concurrent-conflict-dataloss / resolution-convergence / create-create-collision /
> maintenance-under-concurrency / auto-sync-conflict-defer (re-targeted at a delete
> conflict for the S5 defer) / contract-suite / sync-coordinator / round-interruption —
> data-safety intent preserved through the marker mechanism.
>
> The next step is **§"Step 6 — Conflicts panel + compare UX"** (below). Steps 7–8
> follow unchanged. The §"Step 3 core — the atomic removal: FULL DESIGN" and §"Step 5"
> sections below are historical/spec — kept for provenance.

Everything is green (**200 tests** as of `b62e039`). The Step-3/4 ordering hazard was **resolved**:
Step 4a/4b made clean merges AND content-conflict resolutions real two-parent DAG
nodes, so a subsequent edit off a merged/resolved file descends from a real node —
the scalar-ancestor fallback is no longer load-bearing for the content path
(proven by `merge-node-convergence.test.ts`). Steps 4a/4b did the parts of Step 4
that had to precede Step 3; the REST of Step 4 (removing `supersedes` entirely) is
now **folded into Step 3**, because the remaining `supersedes` uses live in the
same delete / create-collision / binary branches that Step 3 must move onto the DAG
(finding #6). Do them as one coherent commit (or split by branch if it stays green).

**The folded Step 3 — retire the scalar ancestor AND the rest of `supersedes` (✅ ALL
DONE in `b62e039`; the checklist below is what was carried out):**
- Delete `merge/ancestor-policy.ts` + its test; remove `ancestorContentHash` /
  `ancestorPath` from `FileEntry` and every writer (`file-registry.adoptRemote` /
  `setAncestorHash`, `sync-applicator.updateAncestorHashes`, `vault-sync-host`).
- Move rename-vs-delete detection off `ancestorPath` onto op path-history / a
  per-fileId `lastSyncedPath` (preserve `delete-rename-conflict`).
- Rework the one-sided-delete branches: replace `isUnchangedSinceAncestor` +
  `re.supersedes?.includes` with DAG fast-forward / LCA over version-ids (a delete
  resolution becomes a two-parent tombstone merge node `[modifiedHead, deleteHead]`;
  a peer FF-adopts it). Same for `resolveCreateCollision` and the binary branch.
- Delete `Operation.supersedes`, `FileEntry.supersedes`, and every remaining
  `supersedes` branch. Auto-adoption is then purely DAG fast-forward.
- `buildLocalState` must stage the DAG base's bytes (`dag.contentHashOf(base)`) in
  place of the `resolved.ancestorContentHash` staging line, or deep three-way
  merges lose their base bytes (finding #4).

**Preserve through the rework:** the `localAtHead` guard in `resolveContentConflict`
(finding #3 — an unlogged in-window edit leaves the head stale → don't FF-adopt →
fall through to three-way); the phantom-delete / F5 / F3 guards.

The Rework section below is now historical (done); Steps 5–8 remain unchanged.

### Step 3 core — the atomic removal: FULL DESIGN (✅ IMPLEMENTED as `b62e039`)

> **This section is HISTORICAL** — it is the design that was implemented verbatim as
> the atomic commit `b62e039`. Kept for provenance and to explain *why* each branch
> is shaped the way it is; do not re-implement. The one place the code went beyond
> this design: `buildLocalState` also folds the round's pending-op edges into the
> in-memory staging DAG (a fresh head can't otherwise reach its base for byte
> staging, since the persisted DAG gains those edges only later in the round). Where
> the prose below says "the merge does X" / "Step 3 adds X", read it as done.

The two prerequisites (`0cf33b8`, `af4a7a4`) were in. What remained was ONE atomic
commit: remove the scalar ancestor + `supersedes` together and move the
delete/binary/create-collision branches onto the DAG. It could not be split green
(the `supersedes` producers and consumers had to move together). The design:

**New DAG helper.** `VersionDag.isMergeNode(v): boolean` = `(parents.size ?? 0) >= 2`
— distinguishes a *resolution* (two-parent merge node) from a plain linear op, so
the delete branches auto-adopt only genuine resolutions.

**FileEntry.** Drop `ancestorContentHash` + `ancestorPath`. Add
`lastSyncedPath?: string | null` (the path at last sync — a straight rename of
`ancestorPath`, decoupled from content). Set it wherever `ancestorPath` was set
(`adoptRemote`, and the old `setAncestorHash` → becomes `setSyncedPath(fileId)`
recording `entry.path`). `reconstructRemoteState` leaves it null (a projected
remote entry has no last-synced path — matches the old `ancestorPath == null`
vacuous-path handling).

**Unchanged-since-base (replaces `isUnchangedSinceAncestor`), over the DAG:**
```
isUnchangedSinceBase(survivor, other, dag):
  if survivor.lastSyncedPath != null && survivor.path !== survivor.lastSyncedPath: return false  // renamed ⇒ touched
  if !dag || !survivor.head || !other.head: return false
  base = dag.mergeBase(survivor.head, other.head)
  if base is null or MULTIPLE_BASES: return false
  bc = dag.contentHashOf(base)
  return bc !== undefined && survivor.contentHash === bc
```

**Delete branches (state-merge):**
- `!le.deleted && re.deleted` (local present survivor, remote tombstone):
  1. `dag.isMergeNode(re.head) && dag.isAncestor(le.head, re.head)` → a keep_deleted
     resolution that already accounts for our head → `delete_local` (rename ignored;
     the resolution settled it). *Replaces `re.supersedes?.includes` keep-deleted.*
  2. `isUnchangedSinceBase(le, re, dag)` → clean one-sided delete → `delete_local`.
  3. else → `delete_conflict` (side `remote_deleted`).
- `le.deleted && !re.deleted` (local tombstone, remote present):
  1. `dag.isMergeNode(re.head) && dag.isAncestor(le.head, re.head)` → a restore
     resolution descending from our delete → `write_local` (restore). *Replaces the
     restore `re.supersedes?.includes` branch.*
  2. `isUnchangedSinceBase(re, le, dag)` → remote unchanged since base → our delete
     propagates → `delete_remote`.
  3. else → `delete_conflict` (side `local_deleted`).
  NB: this direction currently ALWAYS conflicts (a projected remote entry's scalar
  ancestor is null ⇒ old `isUnchangedSinceAncestor(re)` always false). The DAG makes
  it symmetric/commutative — a behaviour change; verify no test wanted the asymmetry.

**Delete/binary resolutions become merge nodes (drop `supersedes`):**
- `delete_conflict` action carries `parents: [le.head, re.head]`. Applicator:
  restore → an `update` merge node (`Ops.merge`, reuse the content-conflict path);
  keep_deleted → a *tombstone* merge node — add `Ops.mergeDelete` (type `delete`,
  content-addressed id) + `OperationLogger.recordMergeDelete`; PendingResolution
  gains `deleted?: boolean` to dispatch merge vs merge-delete after clearOps.
- `binary_conflict` action carries `parents`; applicator mints an `update` merge
  node for the chosen side (FF-adopted by peers — version-based, content-agnostic).
- Then DELETE `Ops.resolveUpdate`/`resolveDelete`, `recordResolvedUpdate`/`Delete`,
  and the `supersedes` branches in `resolveContentConflict` (binary now FF-adopts)
  and `resolveCreateCollision` (replaced by a DAG-FF branch there). *(As built, the
  applicator unifies all resolution minting in one `mintMergeResolution` helper with
  a `deleted` flag, rather than separate update/delete PendingResolution kinds.)*

**Create-collision:** `resolveCreateCollision` gets a DAG-FF branch at the top —
`isAncestor(le.head, re.head)` → adopt `re` (the resolution merge node descends from
our create). Its `conflict` action now carries `parents: [le.head, re.head]` so the
resolution is a merge node. Removes its two `supersedes` branches.

**Purge:** delete `merge/ancestor-policy.ts` + `__tests__/ancestor-policy.test.ts`;
remove `nextAncestorHash`/`setAncestorHash` and `updateAncestorHashes`' scalar
writes (write_local/write_merge already `setSyncedPath`; no_op/send_remote no longer
advance a content ancestor — the DAG is the base). Remove `Operation.supersedes`,
`FileEntry.supersedes`, `reconstructRemoteState`'s `supersedes`/`ancestor*` fields,
`resolveThreeWayBase`'s scalar fallback (DAG-only; null base ⇒ empty-ancestor only
when genuinely no base), the scalar-FF branch (261), `buildLocalState`'s
`ancestorContentHash` staging line, and `referencedHashes`' ancestor keep (GC now
keeps DAG-reachable base bytes — coordinate with Step 8).

**Test rewrites (same commit):** `core.test.ts` (8 `ancestorContentHash` refs — the
pure-merge three-way tests must build a `VersionDag` + `headVersionId` instead of a
scalar ancestor, then pass the dag to `mergeVaultStates`); delete
`ancestor-policy.test.ts`; update `operations.test.ts` (drop resolveUpdate/Delete,
add merge/mergeDelete); `delete-rename-conflict`, `create-create-collision`,
`binary-conflict-dataloss`, `content-hash-sentinel`, `maintenance-under-concurrency`,
`file-registry-referenced-hashes`, `sync-coordinator` (any `supersedes`/`ancestor`
assertions → assert the same guarantee via merge-node/DAG state). The
data-safety intent of each regression is preserved through the new mechanism, never
deleted to go green.

### Findings from R1/R2/2b — load-bearing, read before Step 3+

Non-obvious facts and known gaps discovered while implementing the identity flip.
Each will bite a continuation that doesn't know it. **Status tags added after 4a/4b
+ prereqs.**

1. ✅ **DONE (4a).** ~~`op.id === hlcToString(op.hlcTimestamp)` is load-bearing for
   `adoptRemote`'s head derivation.~~ Fixed: the `write_local` action now carries the
   remote op's real `headVersionId` and `adoptRemote(…, headVersionId?)` records it
   verbatim (falling back to `hlcToString(hlc)` only when absent). A peer
   fast-forwarding onto a content-addressed merge node adopts the real `m-` id. **Any
   NEW adoption path in Step 3 (delete restore, create-collision FF) MUST likewise
   pass `re.headVersionId` — do not re-derive from hlc.**

2. ✅ **DONE (4a/4b).** ~~Clean merges mint a synthetic head not in the DAG.~~ Both
   clean merges (4a) and content-conflict resolutions (4b) are now real two-parent
   DAG nodes with deterministic content-addressed `m-` ids, pushed like resolutions.
   The next edit off a merged/resolved file descends from a real node
   (`merge-node-convergence.test.ts` pins it). The scalar-ancestor fallback is no
   longer load-bearing for the content path — which is what unblocked Step 3.

3. **The `localAtHead` guard is a data-safety invariant, not an optimisation.** In
   `resolveContentConflict`, the DAG fast-forward adopts a remote descendant only
   when `dag.contentHashOf(le.headVersionId) === le.contentHash` — i.e. local is
   actually AT its head. An unlogged in-window edit (the debounce race) leaves the
   head stale while `buildLocalState` corrects `le.contentHash` from disk; without
   the guard the merge would treat the stale head as representing local and adopt a
   remote descendant, silently clobbering the edit (`concurrent-conflict-dataloss`
   test 1 pins this). Preserve it through any merge refactor.

4. ✅ **DONE (af4a7a4).** ~~`buildLocalState` stages only live content + scalar
   ancestor bytes, not DAG LCA base bytes.~~ It now also stages every
   `dag.reachableContentHashes(headVersionId)` the content store holds, so a base
   deeper than the last sync is available and deep-LCA merges succeed instead of
   degrading to a conflict. **DONE in Step 3 (`b62e039`):** the old
   `resolved.ancestorContentHash` staging line is removed; DAG-reachable staging is
   the sole path, and `buildLocalState` now also folds the round's *pending-op*
   edges into the in-memory staging DAG so a fresh head can reach its base (the
   persisted DAG only gains those edges later in the round — the deleted scalar line
   had been masking this gap). **GC retention of these base bytes is still Step 8**
   (`referencedHashes` doesn't see the DAG yet, so a GC'd base degrades a deep merge
   to a conflict — safe, not loss).

5. **DAG persistence is a full rewrite per round, not the incremental append the
   decisions doc §3 corollary calls for.** `VersionDagStore.save` does
   `JSON.stringify(dag.toJSON())` over the whole graph every round (inherited from
   Step 2a). Correct, but `O(vault-history)` per round — the very mobile cost the
   op-id design set out to avoid. Deferred perf; make it append-only (one line per
   new edge) before the DAG grows large. Not required for correctness.

6. ✅ **DONE (`b62e039`).** ~~THE Step 3 core.~~ The delete / rename-vs-delete /
   binary / create-collision branches are all on the DAG now: rename-vs-delete via
   `lastSyncedPath` in `isUnchangedSinceBase` (reading the synced path from
   whichever side carries it, so a projected-remote rename is still caught),
   "unchanged since the common base" via `dag.mergeBase`, resolution-adoption gated
   on `dag.isMergeNode` + `dag.isAncestor`. The scalar ancestor and `supersedes`
   are gone. **Non-obvious for a continuation:** the `le.deleted && !re.deleted`
   direction is now symmetric/commutative (it used to *always* conflict because the
   projected remote's scalar ancestor was null) — the `lastSyncedPath`-from-either-
   side rename check is what keeps the delete/rename asymmetry the
   `delete-rename-conflict` suite requires. Don't "simplify" it to read only the
   survivor's path.

### Primitives (built in 4a/4b + prereqs, then extended by Step 3 `b62e039`)

All of these now exist in the code — the **bolded** "Step 3 adds/added" items were
built as part of `b62e039`. Kept as the map of what lives where.

- `mergeVersionId(contentHash, parents)` (`core/operations.ts`, async) →
  deterministic `m-<sha256>` id, parents sorted (commutative). Merge/resolution
  nodes use it instead of `hlcToString(hlc)`.
- `Ops.merge(fileId, path, contentHash, hlc, parents, id)` → an `update` merge node
  (id precomputed by the caller). **Step 3 added `Ops.mergeDelete(…)` (type
  `delete`) by the same pattern.**
- `OperationLogger.recordMergeOp(fileId, path, contentHash, hlc, parents, id)` →
  records the pending merge op + `setHeadVersion`. **Step 3 added `recordMergeDelete`.**
- Applicator: **Step 3 unified all merge-node minting in `mintMergeResolution(fileId,
  path, contentHash, hlc, parents, deleted?)`** — `hash` the bytes → `id =
  mergeVersionId(hash, parents)` → `adoptRemote(…, id)` (skipped for a tombstone) →
  return the PendingResolution (recorded after `clearOps`). `write_merge`, `conflict`,
  `delete_conflict` (restore + keep_deleted), and `binary_conflict` all route through it.
- `PendingResolution` in `sync-applicator.ts` is now `{ fileId, path, contentHash,
  hlc, parents, id, deleted? }` (the `kind: 'update'|'delete'|'merge'` union was
  collapsed — **`deleted` dispatches recordMergeOp vs recordMergeDelete**).
- `VersionDag.reachableContentHashes(v)` (base-bytes staging), `contentHashOf` /
  `isAncestor` / `mergeBase` (returns `MULTIPLE_BASES`) exist. **Step 3 added
  `VersionDag.isMergeNode(v)` = `parents.size >= 2`.**
- `types.ts`: **Step 3 added `parents?` to `delete_conflict`/`binary_conflict`,
  removed `parentHashes` from all conflict actions + `supersedes` + `Operation`'s
  `supersedes`; `FileEntry` dropped `ancestorContentHash`/`ancestorPath`/`supersedes`
  and gained `lastSyncedPath?`.**
- `merge-node-convergence.test.ts` + `resolution-convergence.test.ts` pin the
  merge-node chain (the latter asserts an `m-` two-parent node).

Current green count: **200** (`npm run build && npx vitest run`). Branch
`sync-robustness-fixes`, last commit `b62e039` — the folded Step 3 core is DONE;
**Step 5 (inline 3-way conflict markers) is next.** (The count dropped from 209
because the 9 `ancestor-policy.test.ts` unit tests were removed with the file; the
send_remote-path-rule + delete/rename intent they guarded are now preserved through
the DAG and the delete-rename / concurrent-conflict integration suites.)

## Working rules

- **One step = one commit.** Sequential; each depends on the previous.
- **Green gate before every commit:** `npm run build` && `npx vitest run` both pass.
  If a step deliberately changes behavior, update the affected tests *in that step*
  and note it in the commit body.
- **Discovery-test discipline:** if a step uncovers a genuine bug, write the test
  for the correct behavior and fix it in the same step (or split a step).
- **No build artifacts committed** (`main.js`, `coverage/`). No Co-Authored-By trailer.
- **Protect the intent, not the letter, of the regression suite.** `core.test.ts`,
  `concurrent-conflict-dataloss`, `resolution-convergence`, `delete-rename-conflict`,
  `create-create-collision`, `edit-during-sync-dataloss`, `round-interruption-durability`
  encode data-safety guarantees. When a step changes *how* a guarantee is met, the
  test is rewritten to assert the same guarantee through the new mechanism — never
  deleted to go green.

## Orchestration (subagents)

Each step is implemented by a subagent, then verified and committed by the
orchestrator:

1. Orchestrator dispatches the step's task (this spec's "Changes" + "Done when") to
   a subagent that has full repo context.
2. Subagent implements, runs `npm run build && npx vitest run`, and reports the
   diff summary + test result.
3. Orchestrator reviews, re-runs the green gate, and **commits** with the step's
   message. On failure, iterate with the same subagent before committing.
4. Proceed to the next step only after the commit lands. Steps are **not**
   parallelized — the DAG refactor is inherently sequential.

---

## Step 1 — Op parent links (generalize `baseContentHash` → `parents`)

> ✅ **Committed (`78de087`)** — but `parents` hold *content hashes*. **Reworked by
> R1** to hold version-ids. Kept here for history; the live target is R1.

**Goal:** every op carries its causal parents; no behavior change yet.

**Changes**
- `types.ts`: replace `Operation.baseContentHash?: string` with
  `parents: string[]` (create `[]`; update/delete `[prevHash]`). Keep
  `supersedes` for now.
- `core/operations.ts`: factories take/emit `parents`.
- `core/operation-logger.ts`: at each emission site pass `[oldContentHash]`
  (or `[]` for create). Keep the pre-edit-hash capture already added.
- `network/server-sync.ts` `reconstructRemoteState`: read `op.parents` (still map
  the single parent to `ancestorContentHash` so the merge is unchanged this step).

**Done when** the suite is green with `parents` as the wire field and
`baseContentHash` fully removed. Behavior identical to today.

**Commit:** `refactor(sync): carry op parent links (parents[]) replacing baseContentHash`

## Step 2 — Content DAG + LCA merge base

**Design note (why a persisted store).** An LCA walk needs the parent links of
*past* versions, but pending ops are cleared after push and pulls are incremental,
so no in-flight op list holds the full history. The DAG must therefore be
**persisted and accumulated** — every op ever authored or pulled contributes its
`(contentHash → parents, fileId)` edge. Parent links are just hashes (tiny), so the
DAG is retained even after content GC drops the bytes (enabling "we know the base
but not its bytes → degrade to conflict"). Split into a safe mechanical half (2a)
and the behavior change (2b).

### Step 2a — Persisted version-DAG store (behavior-preserving)

> ✅ **Committed (`50dd790`)** — but the DAG is keyed by *content hash*. **Reworked
> by R2** to key by version-id (op-id) and carry `contentHash` as a node field. The
> store/plumbing are reused as-is.

**Changes**
- New pure module `core/version-dag.ts`: an in-memory DAG of `contentHash →
  { parents: string[]; fileId: string }` with `addVersion(hash, parents, fileId)`
  (idempotent, union of parents), `isAncestor(maybeAncestor, descendant)`
  (reachability via parent walk, cycle-safe), and `mergeBase(a, b)` returning the
  lowest common ancestor hash, `null` if none, or a sentinel for "multiple bases"
  (ambiguous criss-cross). Pure; no I/O.
- New `network/version-dag-store.ts` (modeled on `cursor-store.ts`): load/save the
  DAG to `.vault-sync/version-dag.json` with a defensive `load()`.
- Populate it at every point an op is minted or pulled:
  - `core/operation-logger.ts` — after emitting each op, record its edge.
  - `network/server-sync.ts` — after decrypting each pulled op, record its edge.
  (Prefer a single choke point if one exists; otherwise both.)
- Wire construction in `main.ts` and `TestDevice`; load in the init sequence.

**Done when** the DAG is persisted and accumulates edges across a round and a
reload, and the full suite is still green. Nothing reads the DAG for merge yet.

**Commit:** `feat(sync): persist a content version-DAG (parent links) for LCA`

### Step 2b — Merge computes the base from the DAG

⚠️ Do the **Rework (R1, R2)** below *before* this — Step 2b as originally sketched
merged over content-hash keys, which is unsound (see status section). The reworked
Step 2b is folded into R2's "Done when".

---

## Rework — op-id identity (✅ DONE — historical)

> **Committed as `e0be88a` (R1a additive `headVersionId`) + `d61ab66` (R1-flip +
> R2 + Step 2b together).** Kept below for the design rationale. See the status
> section above for the split rationale and the Step 3 ordering hazard.

Steps 1 and 2a were committed but used **content-hash** as the version identity,
which cycles on recurring content. Reworked to **op-id** identity, suite green
(204) at each rework commit.

### Rework R1 — `parents` are version-ids; registry tracks `headVersionId`

**Concept.** A "version" is an op-id (`op.id`). An op's `parents` are the op-ids it
descended from. Each file's registry entry records its current `headVersionId` — the
version a new local edit will name as its parent.

**Changes**
- `core/file-registry.ts`: add `headVersionId: string | null` to `FileEntry`
  (persisted). Set it whenever content changes: on create/update/delete the head
  becomes the *new* op's id; on adopting a remote version (applicator `write_local`)
  the head becomes the *remote* op's id; on a merge, the merge op's id. Add a
  setter used by the logger + applicator.
- `core/operations.ts` + `core/operation-logger.ts`: an op's `parents` become
  `[entry.headVersionId]` (or `[]` if null / a create) — the *version-id* the edit
  descended from, NOT the prior content hash. The pre-edit head is read from the
  registry entry before the update mutates it.
- `network/server-sync.ts` `reconstructRemoteState`: build each remote `FileEntry`
  with `headVersionId = op.id` (the pulled op *is* that version) and keep
  `op.parents` as its parent version-ids. (It currently maps `parents[0]` to
  `ancestorContentHash` — that mapping is retired here; the scalar ancestor stays as
  a dead field until Step 3, but nothing should read it after R2.)
- Every op must be resolvable to its `contentHash` by id — the DAG node carries it
  (R2), and `reconstructRemoteState` already has each op. The merge fetches bytes by
  the base's `contentHash`.

**Done when** ops carry parent *version-ids*, the registry persists `headVersionId`
(survives `reload()`), and the suite is green. A focused test: author create→update,
assert the update op's `parents === [createOpId]` and the entry's `headVersionId`
tracks the latest op.

**Commit:** `refactor(sync): version identity is the op-id; parents are version-ids`

### Rework R2 — key the VersionDag by version-id (op-id)

**Concept.** The DAG nodes are op-ids; each node stores its parents (op-ids), its
`contentHash` (blob address), and `fileId`.

**Changes**
- `core/version-dag.ts`: node value becomes `{ parents: Set<string>; contentHash:
  string; fileId: string }`. `addVersion(versionId, parents, contentHash, fileId)`.
  Add `contentHashOf(versionId): string | undefined` (the merge needs the base's
  bytes by hash). `isAncestor` / `mergeBase` are unchanged — they already treat keys
  as opaque strings; they now range over version-ids. Update `version-dag.test.ts`
  to use version-id keys + assert `contentHashOf`.
- Populate from ops: `recordVersionEdges(ops)` records
  `addVersion(op.id, op.parents, op.contentHash, op.fileId)`.
- `network/version-dag-store.ts`: persist the extra `contentHash` field.
- **Timing fix:** the round must record the current round's edges BEFORE the merge
  (Step 2a records them after apply, which is fine while nothing reads the DAG; once
  the merge reads it, `runSync` must call `recordVersionEdges([...local.pendingOps,
  ...pulled])` *before* `mergeVaultStates` so this round's heads are in the DAG).

**Done when (this also completes Step 2b):**
- `merge/state-merge.ts`: `mergeVaultStates(local, remote, dag?)` takes the
  `VersionDag`. In `resolveContentConflict`, use
  `dag.mergeBase(le.headVersionId, re.headVersionId)` for the base and
  `dag.isAncestor` for fast-forward (both directions); fetch base bytes via
  `dag.contentHashOf(baseVersionId)` → the content store. `MULTIPLE_BASES` → surface
  a conflict. Fall back to the old scalar path only when `dag` is absent (keeps
  pure-`VaultState` unit tests in `core.test.ts` green until Step 3).
- `runSync` passes the DAG to the merge (after recording this round's edges).
- The reworked FF makes the reported `empty → "3" → empty` case converge with **no
  conflict** via `id_3` being a clean ancestor of `id_empty2`; add/keep a two-device
  test asserting it. `concurrent-conflict-dataloss` still surfaces a conflict (its
  heads share an older base, not each other).

**Commit:** `feat(merge): derive the three-way base from the op-id DAG (LCA)`

---

## Step 3 — Retire `ancestor-policy` and `ancestorContentHash`

> ✅ **DONE (SUPERSEDED / FOLDED).** This original Step 3 and the Step 4 below were
> merged into ONE atomic commit, shipped as **`b62e039`** (Step 4a/4b had already
> shipped the merge-node halves in `b1ef94e`/`2595d94`; the prereqs in
> `0cf33b8`/`af4a7a4`). The worked-out plan that was implemented is §"Step 3 core —
> the atomic removal: FULL DESIGN" near the top. These two sections are kept only for
> the original goal statements + commit-message seeds — nothing here is open.

**Goal:** delete the scalar ancestor and its policy entirely.

**Changes**
- Delete `merge/ancestor-policy.ts` + `__tests__/ancestor-policy.test.ts`.
- Remove `ancestorContentHash` from `FileEntry` and every writer
  (`sync-applicator`, `vault-sync-host`, `file-registry`).
- Move rename-vs-delete detection off `ancestorPath` onto op path history (or a
  minimal per-fileId `lastSyncedPath`), preserving `delete-rename-conflict`.
- Rewrite `ancestor`-referencing assertions to assert the same guarantees via DAG
  state.

**Done when** no `ancestorContentHash` remains and the suite is green.

**Commit:** `refactor(merge): remove the scalar ancestor and ancestor-policy (DAG is the base)`

## Step 4 — Two-parent merge nodes; retire `supersedes`

> ✅ **DONE / FOLDED.** Clean merges (4a, `b1ef94e`) and content-conflict resolutions
> (4b, `2595d94`) shipped first; the remaining `supersedes` removal
> (binary/delete/create-collision) shipped in the atomic Step 3 core `b62e039`.
> `supersedes` is now gone entirely. Kept for the original goal statement.

**Goal:** resolutions and clean merges are versions with `parents: [A, B]`.

**Changes**
- Clean merge emits a version with `parents: [localHead, remoteHead]` (content-
  addressed → concurrent identical merges dedup).
- Human resolution emits the same shape instead of a `supersedes` op.
- Delete `Operation.supersedes`, `FileEntry.supersedes`, and every `supersedes`
  branch in `state-merge` / `resolveCreateCollision`. Auto-adoption becomes plain
  fast-forward to the descendant merge node.
- Rewrite `resolution-convergence` + `create-create-collision` to assert
  convergence via merge nodes.

**Done when** peers converge on resolutions with no `supersedes` anywhere.

**Commit:** `feat(merge): reconcile via two-parent merge nodes; remove supersedes`

## Step 5 — Conflicts as inline markers at the real path (non-blocking)

> ✅ **DONE.** Shipped as described. See the status section at the top for the
> as-built summary (fields, new diff3 helpers, the two-headed guard, removed modal
> path, and the test rewrites). Kept below for the original goal/commit seed.

**Goal:** stop blocking on a modal; write 3-way markers and keep both heads open.

**Changes**
- `merge/diff3.ts`: a `renderConflictMarkers(base, ours, theirs)` producing
  `zdiff3`-style 3-way markers, clean outside conflicting hunks.
- `network/sync-applicator.ts`: a `conflict` action writes marked bytes to the real
  path and records the fileId as two-headed; it no longer calls a resolver/modal.
- Resolution detection: the next local save on a two-headed file emits a merge op
  `parents: [A, B]` (the two heads at conflict time). A save that still contains
  markers → non-blocking notice, no merge yet.
- Remove the modal-gated resolution path from the round/coordinator.

**Done when** a conflicting two-device edit converges with no modal: markers appear,
an ordinary edit resolves, peers fast-forward. New `TestDevice` scenario covers it.

**Commit:** `feat(sync): surface conflicts as in-context 3-way markers, resolved by the next save`

## Step 6 — Conflicts panel + compare UX

**Goal:** legible, non-blocking resolution UI (the user's UX concern).

**Changes**
- A non-modal Conflicts view listing two-headed files with HLC provenance (which
  devices / when).
- A three-column compare (base | mine | theirs) reusing `resolveConflictChunkLines`,
  with per-hunk accept + preview; writing the chosen bytes triggers the Step-5 save
  path.
- Status item "Sync: N conflicts"; ribbon reflects conflict state.
- UI is manual-smoke (per the guide); logic stays in obsidian-free units where
  possible with thin adapters.

**Done when** the panel resolves a conflict end-to-end in a real vault (smoke) and
the obsidian-free resolution logic is unit-tested.

**Commit:** `feat(ui): non-blocking conflicts panel with 3-way compare`

## Step 7 — Simplify sync-state / conflict lifecycle

**Goal:** "conflicts" is a derived query, not hand-maintained state.

**Changes**
- Replace `SyncStateStore` outstanding-conflict set + badge record/clear/self-heal
  with a derived `filesWithTwoHeads()` over the DAG.
- Delete `SyncCoordinator` badge bookkeeping made redundant (clear-on-convergence,
  the conflict-specific self-heal).
- Keep genuinely useful observable state (last error, stranded, last-round summary).
- Rewrite `sync-coordinator.test.ts` conflict assertions against the derived query.

**Done when** no hand-maintained conflict set remains; the badge reflects the
derived head count.

**Commit:** `refactor(sync): derive conflict state from DAG heads; drop the badge lifecycle`

## Step 8 — GC for merge bases + rewrite the engineering guide

**Goal:** retention keeps three-way merges possible; docs describe v2.

**Changes**
- `core/content-store.ts` GC: retain content for reachable heads + plausible merge
  bases; retain parent-link hashes longer. Missing base bytes → degrade to markers
  (assert this).
- Rewrite `docs/sync-engineering-guide.md` for the DAG model; fold in the v2
  decisions; mark the v1-specific sections historical.

**Done when** GC preserves merge bases (test), and the guide reflects v2.

**Commit:** `chore(sync): GC retains merge bases; rewrite the engineering guide for v2`

---

## After the migration

- Re-run the full contract/integration suite (`npm run test:integration`) against
  the real Go server — the wire changed (`parents`), though it stays inside the E2E
  envelope, so the server should be agnostic. Confirm, don't assume.
- Manual smoke in two real vaults: sequential empty↔content, concurrent same-line
  conflict → markers → resolve, delete/rename conflict, offline capture.
- Delete this spec's now-historical status notes; the engineering guide is the
  living doc.
