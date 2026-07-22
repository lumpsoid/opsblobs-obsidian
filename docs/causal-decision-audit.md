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
| B | `server-sync.ts:~437` `reconstructRemoteState` HLC-max per fileId | D1/D5 | **CONFIRMED gap** — silent-divergence window, eventually-consistent, never lossy | low–med |
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

### B — `reconstructRemoteState` collapses concurrent remote heads (CONFIRMED, low–med)

The remote projection keeps only the **HLC-max op per fileId** (`VaultState` is one entry per
fileId). When a device pulls two concurrent remote heads for one file (3 devices — B edits &
pushes B1, C edits & pushes C1), the puller A merges only against the HLC-max (C1) and
**silently ignores B1**, which stays a DAG leaf A never reconciles. Traced dynamics:

- **The merge does get computed — by C.** C pulls B1 *before* pushing C1, so C produces the
  merge node M = `merge(B1, C1)` (`write_local, write_merge`). The puller A, however, adopts
  only C1 → ends at the partial `"base\nC-edit"`, missing B's edit.
- **Self-heals in the common case:** once C re-syncs and pushes M, A and B fast-forward onto
  it and all three converge (verified: full round-robin → all `"B-edit\nC-edit"`).
- **Permanent divergence only in a narrow window:** if C computes M then goes offline *before
  pushing it*, A stays at the partial view indefinitely (B's edit invisible). **No data
  loss** — B1 is durable on the server and in A's DAG; A simply never reconciles it.

So it is a real *silent-divergence window*, but eventually-consistent under normal syncing and
never lossy — hence low–med, not high.
**Fix (design decision, deferred).** Make any device that pulls ≥2 concurrent remote leaves
for a file reconcile them itself, rather than depend on the specific pull-both device staying
online: either the projection surfaces *all* concurrent heads per fileId (invasive — changes
`VaultState` shape), or the round adds a **multi-head reconciliation sweep** after apply (fold
the local head with each extra DAG leaf via the existing pairwise `mergeVaultStates`, minting
a merge node). A cheaper interim: **surface** it (detect >1 un-reconciled remote leaf and
defer/flag) so the window is loud, not silent. Discovery test:
`causal-audit-discovery.test.ts` → "three devices: two concurrent edits".

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
