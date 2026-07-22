# Multi-Head Reconciliation (sync v2)

A durable design note on how the sync engine converges a file that has **more than
two concurrent heads** — the mechanism (`ServerSyncClient.reconcileConcurrentHeads`),
why it's needed, and its exact convergence properties, including a subtle
fold-tree non-determinism in the 3+-head case that is self-healing by design.

This complements the engineering guide (`docs/sync-engineering-guide.md`, §2 the DAG
model, §4 the round) and the point-in-time finding record in
`docs/causal-decision-audit.md` (Finding B). The guide and this note are the *living*
docs; the audit is the historical record of how the gap was found.

---

## 1. Background: a head is per-device

A "head" is a leaf of the version DAG for a file — a version nothing descends from.
Each device **linearizes its own edits** (every edit's `parents` is that device's
previous head), so a single device holds **exactly one head per file** at any moment.
Therefore the number of simultaneously-open concurrent heads for a file is bounded by
the number of devices that have diverged:

- **2 devices** → at most one *remote* head from any puller's view. The merge already
  reconciles one local head against one remote head. Nothing is dropped.
- **3+ devices** → two others (say B and C) can each push a concurrent head, so a third
  (A) can pull **two un-reconciled remote heads at once**. This is the case that needs
  multi-head reconciliation.

So "how many devices" is really a proxy for **how many un-merged concurrent heads reach
one puller in a single pull.** That count can only exceed one with ≥3 devices.

## 2. Why concurrent raw heads coexist on the server (the push-before-apply lag)

A round is `build → pull → push → merge → apply → cursor` (guide §4). Crucially, a device
**pushes its own raw edit before it merges** ("push before apply" — durability first).
The merge it computes during `apply` is a *new* op that goes out on the **next** round.

So when C edits `note.md` to `C1` and syncs while B's `B1` is already on the server:

1. C pulls `B1`.
2. C **pushes its raw `C1`** (`parent = base`, concurrent with `B1`) — *before* merging.
3. C merges `C1`+`B1` → merge node `M`, applies it locally; `M` is now pending.
4. `M` is pushed on C's **next** sync.

The server therefore holds `B1` **and** `C1` — two concurrent heads — for the window
between C pushing `C1` and C pushing `M`. (In the fully-simultaneous case where B and C
each pull before the other pushed, *neither* even computes a merge, so the two heads sit
there until some later puller reconciles them.) A device that pulls inside that window
gets both heads.

`reconstructRemoteState` collapses the pulled ops to **one entry per fileId** (the
HLC-max op), and `mergeVaultStates` reconciles the local head against that single remote
head. So without multi-head reconciliation, the puller adopts the HLC-max head and leaves
the other as a **stranded DAG leaf nothing reconciles** — a silent divergence (the puller
shows a partial view until a peer that already merged happens to re-sync and push its
merge). No data is lost — the stranded op is durable on the server and in the puller's DAG
— but the puller never reconciles it on its own. That is the gap this mechanism closes.

## 3. The mechanism: `reconcileConcurrentHeads`

Run in `runSync` **after** the main merge+apply, before `safeCursor`. It makes *any*
device that pulled ≥2 concurrent heads reconcile them **itself**, rather than depend on a
specific peer staying online to push a merge.

- **Scope** — the fileIds a *peer* touched this round (the only place a second head can
  arrive alongside the collapsed HLC-max). Files the main apply **deferred** (F5 drift, or
  an auto-deferred delete/binary conflict) are skipped: their cursor is held so the whole
  round re-pulls, and reconciling them now would overwrite the very in-window edit F5
  protects.
- **Enumerate** — `VersionDag.leaves(fileId)` gives the open leaves; the *extra* concurrent
  leaves are those the local head does **not** already descend from (`!isAncestor`).
- **Fold** — the local head is folded with each extra leaf, one at a time, in **version-id
  sorted order**, through the ordinary pairwise `mergeVaultStates`. A clean fold mints a
  `write_merge` node; overlapping edits surface a two-headed `conflict` (inline zdiff3
  markers) exactly like the normal path — never a silent pick. The loop rebuilds local
  state each pass (folding in any node it just minted) until one head remains.
- **Only genuine concurrent edits are folded** — a leaf with no pulled op this round, a
  tombstone, or a disconnected lineage (`mergeBase === null`, e.g. a re-create root — see
  Finding A) is left alone, never unioned.
- **Bytes** — the base `LCA(head, leaf)` is an ancestor of the local head, so its bytes are
  already staged by `buildLocalState` (`reachableContentHashes`); a known-but-missing base
  degrades to a conflict inside `mergeVaultStates` (F1), never a union. The extra leaf's own
  bytes weren't fetched by the HLC-max projection, so the sweep fetches them; if the blob is
  absent it's added to `missingContent`, so `safeCursor` holds the cursor and it re-pulls
  next round (F3) — never silently dropped.

Minted merge nodes are pending ops pushed next round like any other resolution, so
push-before-apply is untouched.

## 4. Convergence and determinism

### The 2-head case is exactly deterministic

Two heads `B1`, `C1`: every device that reconciles them folds *the same pair*, and
`mergeVersionId` **sorts its parents**, so `merge(B1,C1)` and `merge(C1,B1)` are the
identical content-addressed node. Every device mints the same node and fast-forwards onto
it — no storm, exact convergence.

### The 3+-head case: the fold *tree* can differ (but self-heals)

The sweep folds each extra leaf **into the device's current head**. When there are 3+
concurrent heads, different devices *enter* the sweep on **different heads**, so their
first fold — and thus the shape of the reduction tree — can differ.

Concrete example. Base `O`; three concurrent edits on different lines,
HLC order `D1 > C1 > B1`:

- `B1` (parent `O`) — edits line 1
- `C1` (parent `O`) — edits line 2
- `D1` (parent `O`) — edits line 3

**Device A** (idle at `O`, pulls all three):
1. Main merge adopts HLC-max `D1`.
2. Sweep: `D1` + `B1` → `merge(B1,D1)`, then + `C1` → **`Mₐ = merge([ merge(B1,D1), C1 ])`**.

**Device C** (on its own head `C1`, pulls `B1`, `D1`):
1. Main merge reconciles `C1` vs HLC-max `D1` → `merge(C1,D1)`.
2. Sweep: + `B1` → **`M_c = merge([ merge(C1,D1), B1 ])`**.

|        | inner node        | outer node (parents)                    |
|--------|-------------------|-----------------------------------------|
| A      | `merge(B1,D1)`    | `Mₐ = merge([ merge(B1,D1), C1 ])`      |
| C      | `merge(C1,D1)`    | `M_c = merge([ merge(C1,D1), B1 ])`     |

The **content is identical** (all three line-edits) but the *intermediate* nodes differ
(`merge(B1,D1) ≠ merge(C1,D1)`), so the outer nodes have different parents → **different
ids**. Parent-sorting equalizes order *within* a pair; it cannot equalize two differently
*grouped* reduction trees. The driver is the **starting head**: A started from the HLC-max
`D1` (no stake of its own), C started from its own head `C1`.

### Why it still converges, and terminates

`Mₐ` and `M_c` are now two distinct heads with **identical content**. When A and C sync,
the sweep folds them — and this is exactly where the **same-content convergence rule** (a
two-head divergence with equal bytes mints a uniting merge node; see the guide §7
"identical content ≠ causal convergence") takes over. That pair *is* deterministic (same
two nodes, sorted parents), so both compute the identical `M₃ = merge(Mₐ, M_c)` and
converge.

Termination: each reconciliation round reduces a set of distinct-but-equal-content heads
pairwise into deterministic merge nodes, so the number of distinct heads is strictly
non-increasing until it reaches 1. No storm, no oscillation — it costs at most **a few
extra merge nodes and one or two settling rounds** in the (rare) 3+-concurrent-editors
case, then the DAG is a single head.

## 5. Severity and the road not taken

- **Correctness:** unaffected — converges, no data loss, no permanent divergence, no
  infinite churn.
- **Cost:** a handful of redundant merge nodes + a settling round, only when 3+ devices
  edit *one* file concurrently before anyone merges.

So the 3+-head fold-tree divergence is an **efficiency footnote, not a bug.**

A **fully-deterministic** alternative exists: have the sweep ignore the device's current
head and reduce *all* the file's leaves in one canonical global order (sort all leaves,
fold left-to-right identically on every device). Then even the 3+ case mints one shared set
of nodes with no settling round. It is deferred because it means a device discarding the
head its main merge just produced to rebuild from a canonical base — more code and more
work for a case that already self-heals. If multi-editor-per-file concurrency ever becomes
common, this is the upgrade path.

## 6. Where this is exercised

`__tests__/causal-audit-discovery.test.ts`:
- "three devices: two concurrent edits to one file both converge on the puller" — the
  base fix.
- "puller converges to the merged content on its own, no further B/C sync" — proves the
  puller reconciles locally (no dependency on the merging peer staying online), mints a
  real `write_merge` node, ends with a single DAG leaf, survives a reload, and replicates
  (a returning peer fast-forwards, no re-conflict).
