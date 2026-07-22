# Causal-Decision Audit (sync v2)

**Goal.** Find every place the engine decides a *causal* fact — "converged?",
"diverged?", "what's the base?", "changed since base?", "which head wins?", "nothing to
do?" — from a **proxy** (content-hash equality, a scalar field, or HLC alone) instead of
from the `VersionDag`. Under concurrency the proxy lies, and the engine then **silently**
strands a divergence, drops an edit, overwrites one, or unions a file. (Guide §7: *"content
equality is not head equality"*; the danger is always the *silent* failure.)

This is the durable checklist. It was seeded by the fix for the concurrent
empty↔empty→edit bug (`concurrent-identical-edit-convergence.test.ts`) and a fan-out
audit that enumerated **73 causal-decision points** across `state-merge`, `operation-logger`,
`file-registry`/`vault-sync-host`, `server-sync`/`sync-applicator`, and
`sync-coordinator`/`version-dag`, then adversarially probed the 30 proxy-based ones.

## Method (re-runnable)

1. **Enumerate** decision points per module (grep `no_op`, `contentHash ===`, `hlcCompare`,
   early `return`/`continue`; read each site).
2. **Triage**: is it causal? DAG-backed or proxy-based?
3. **Probe** each proxy-based site with the *concrete two-device scenario* where the proxy
   lies — the five ways it lies:
   - **D1 identical content, distinct heads** (concurrent same edit) — equality ≠ convergence.
   - **D2 recurred content** (X→Y→X): `contentHash === base` while the head advanced.
   - **D3 stale head / in-window edit**: `le.contentHash` (disk-corrected) ≠ head content.
   - **D4 criss-cross base**: `mergeBase` returns `MULTIPLE_BASES`.
   - **D5 HLC-only winner**: last-writer-wins with no DAG check drops the loser.
4. **Confirm** empirically with a `TestDevice` two/three-device scenario; record confirmed
   findings as discovery-tests (`causal-audit-discovery.test.ts`, `test.skip` asserting the
   *correct* behavior).

## Findings

| ID | Site | Class | Verdict | Severity |
|----|------|-------|---------|----------|
| FIXED | `state-merge` same-content `no_op` | D1 | **fixed** — mints `write_merge` to unite heads | — |
| A | delete-convergence head-stranding + re-create behavior | D1 | **RE-DIAGNOSED**: stranding benign; re-create conflict is by-design; a real minor bug (re-create left `deleted`) **FIXED** | low |
| B | `server-sync.ts:~437` `reconstructRemoteState` HLC-max per fileId | D1/D5 | **FIXED** — multi-head reconciliation sweep folds every stranded concurrent leaf | — |
| C | `state-merge.ts:~672` `isUnchangedSinceBase` (`contentHash === baseContent`) | D2 | **CLEARED** (data-safe) | — |
| D | `state-merge.ts:~364` binary `changed since base` by hash | D2 | head-stranding, no net loss — likely OK | low |
| E | `file-registry.ts:~128` `applyRemoteEntry` HLC-only overwrite | D5 | **dead code** (no callers) | n/a |
| F | `operation-logger.ts:~333` `flushModify` content-hash "nothing changed" | D2/D3 | local-authoring; registry hash mirrors head | low |

### A — delete-convergence stranding + re-create (RE-DIAGNOSED; minor bug fixed)

Initially flagged as the delete twin of the fixed same-content bug (both-deleted / clean
one-sided delete leave a stranded DAG leaf; a later re-create surfaces `delete_conflict`).
Probing the fix candidate corrected the diagnosis:

- **A re-create of a tombstoned path emits a `create` op with `parents: []` — a fresh,
  causally-disconnected DAG root** (`op-logger.handleCreate`), reusing the fileId. So the
  re-create does **not** descend from any tombstone, whether or not the tombstones are
  united. Uniting them (a `delete_merge` node) would therefore **not** change the re-create
  outcome — it would be cosmetic. The empty↔empty fix worked only because its follow-up was
  a *linear update* (`parents: [head]`); a re-create is a root, breaking the analogy.
- **The tombstone-head stranding is real but benign**: nothing ever descends from a
  tombstone (re-creates are roots), so it never becomes a three-way base and causes no
  content-merge harm.
- **The re-create → `delete_conflict` is by-design and safe.** A re-created file is a
  genuinely new, unrelated file at the same path; a peer that deleted the old one gets a
  delete/create conflict rather than a silent un-delete (prime directive). Kept as-is; pinned
  by `recreate-after-delete.test.ts` → "BY DESIGN … surfaces a conflict".

**The one genuine bug here, FIXED:** `FileRegistry.registerFile` returned the existing id for
a path already in `pathIndex` *without resurrecting a tombstoned entry*, so a re-created file
was left `deleted: true` with a stale `contentHash` while its head advanced —
`buildLocalState` would then mis-project the just-created file as deleted. Fix: resurrect the
entry in place (`deleted=false`, fresh `contentHash`/`hlc`) on a create over a tombstone.
Pinned by `recreate-after-delete.test.ts` → "FIX … resurrects a consistent live entry".

### B — `reconstructRemoteState` collapses concurrent remote heads (FIXED)

The remote projection keeps only the **HLC-max op per fileId** (`VaultState` is one entry per
fileId). When a device pulled two concurrent remote heads for one file (3 devices — B edits &
pushes B1, C edits & pushes C1), the puller A merged only against the HLC-max (C1) and
**silently ignored B1**, which stayed a DAG leaf A never reconciled. Traced dynamics:

- **The merge does get computed — by C.** C pulls B1 *before* pushing C1, so C produces the
  merge node M = `merge(B1, C1)` (`write_local, write_merge`). The puller A, however, adopted
  only C1 → ended at the partial `"base\nC-edit"`, missing B's edit.
- **Self-heals in the common case:** once C re-syncs and pushes M, A and B fast-forward onto
  it and all three converge (full round-robin → all `"B-edit\nC-edit"`).
- **Permanent divergence in a narrow window:** if C computed M then went offline *before
  pushing it*, A stayed at the partial view indefinitely (B's edit invisible). **No data
  loss** — B1 is durable on the server and in A's DAG; A simply never reconciled it.

**Fix (landed) — multi-head reconciliation sweep.** `ServerSyncClient.runSync` now runs
`reconcileConcurrentHeads` after the main merge+apply. It makes *any* device that pulled ≥2
concurrent leaves reconcile them itself, instead of depending on the pull-both device staying
online:

- **Scope.** The files a *peer* touched this round (where a second head can arrive alongside
  the collapsed HLC-max). Files the main apply deferred (F5 drift / auto-deferred conflict) are
  skipped — their cursor is held so the whole round re-pulls and reconciles once settled;
  reconciling them here would write over the very in-window edit F5 protects.
- **Enumerate.** For each such file, `VersionDag.leaves(fileId)` gives the open leaves; the
  *extra* leaves are those the local head does not already descend from (`!isAncestor`). Only
  live↔live edits that share a real common base (`mergeBase !== null`) are folded — a
  disconnected re-create root (Finding A) or a tombstone leaf is left alone (benign), never
  unioned.
- **Fold.** The local head is folded with each extra leaf, one at a time in **version-id sorted
  order**, through the *existing* pairwise `mergeVaultStates` — a clean fold mints a
  `write_merge` node (deterministic content-addressed id, commutative in parents, so two
  devices sweeping the same leaves mint the identical node and fast-forward onto each other);
  overlapping edits surface a conflict (inline zdiff3 markers, two-headed) exactly like the
  normal two-head path. The loop rebuilds local state and repeats until one head remains.
- **Base + leaf bytes.** The three-way base `LCA(head, leaf)` is an ancestor of the local head,
  so `buildLocalState` already staged its bytes (`reachableContentHashes`); a known-but-missing
  base degrades to a conflict inside `mergeVaultStates` (F1). The extra leaf's own bytes weren't
  fetched by the HLC-max projection, so the sweep stages them (`fetchBlob`); if the blob is
  absent it is added to `missingContent` so `safeCursor` holds the cursor and the leaf re-pulls
  next round (F3), never silently dropped.
- **Round invariants.** The minted merge node is a pending op, pushed next round like any other
  resolution (push-before-apply is unaffected — the sweep pushes nothing itself). The cursor is
  still the persisted pull cursor, held back on a missing leaf.

Now-active tests (`causal-audit-discovery.test.ts`): "three devices: two concurrent edits to
one file both converge on the puller" (the un-skipped acceptance test), and "puller converges
to the merged content on its own, no further B/C sync" (the permanent-divergence angle — A
reaches `"B-edit\nC-edit"` in one round, survives a reload, and its merge node later
fast-forwards onto B without a re-conflict).

The durable design note — the mechanism, the push-before-apply lag, and the 3+-concurrent-head
convergence/determinism analysis (a self-healing fold-tree footnote) — lives in
`docs/multi-head-reconciliation.md`.

### C — `isUnchangedSinceBase` on recurred content (CLEARED, data-safe)

Base is DAG-derived (`mergeBase`) but the *untouched* verdict is
`survivor.contentHash === baseContent`. A survivor that recurred to base bytes (X→Y→X) has an
advanced head yet reads "unchanged", so a peer's delete propagates cleanly. Traced to full
convergence: **both devices correctly converge to `<deleted>`, `cp=0`, no data loss, no
spurious conflict at delete time** — matching git (a net-zero diff vs base is not a
modification, so the delete is clean). So the *content* decision is correct; using
`contentHash === base` here is the semantically right question.

What the trace *did* surface: the clean delete leaves the survivor's live head un-united with
the tombstone (two stranded DAG leaves) — the same stranding as finding A, and (per A's
re-diagnosis) equally benign, since a re-create is a disconnected root that never descends
from a tombstone.

### D — binary "changed since base" by hash (likely OK, low)

Same D2 shape for the binary branch. A recurred binary head reads "unchanged" and the other
side's edit wins with no merge node (head-stranded). But "did the bytes change from base" is
the semantically correct question for binary, and the recurred side's bytes == base, so
nothing distinguishable is lost. The head-stranding is cosmetic (a later edit still finds the
right base). Left as-is; noted.

### E — `applyRemoteEntry` (not a live bug)

Pure HLC last-writer-wins over a whole `FileEntry` incl. `headVersionId`, no ancestry check —
but it has **no callers** in `src/`. Dead code; either remove it or, if revived, route head
adoption through the DAG, never HLC alone.

### F — `flushModify` content-hash gate (low)

`hash === entry.contentHash → no op` is local authoring, not cross-device reconciliation;
correctness relies on `registry.contentHash` mirroring the current head (maintained by
`adoptRemote`/`buildLocalState`). No concurrent lie found; noted so the invariant stays
explicit.

## The rule this audit enforces

> With an op-id DAG, **content equality is not head equality, and a scalar flag is not a
> causal fact.** Any "converged / unchanged / nothing-to-do" shortcut keyed on a content
> hash or a scalar must, when the two heads are distinct, consult the DAG and — on genuine
> divergence — **unite the heads with a merge node** rather than returning `no_op`. Converge
> the heads, not the bytes.
