# Sync v2 — Migration Spec

Ordered, sequential steps to evolve the engine from the v1 scalar-ancestor model to
the v2 content DAG described in `sync-v2-decisions.md`. Each step is a single
coherent commit that leaves `npm run build` and `npx vitest run` **green** (tests
may be intentionally updated within the step that changes their contract). No
compatibility is preserved — there are no users and no 1.0.

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

**Goal:** compute the three-way base from the DAG, not the scalar ancestor.

**Changes**
- New pure module `merge/content-dag.ts`: build `Map<fileId, DAG>` from an ordered
  op list; `mergeBase(dag, a, b)` returns the LCA content hash (or a marker for
  "multiple/again none"). Ancestor-reachability helper for fast-forward.
- Thread the op history into the merge: `buildLocalState` / the round provide the
  parent map (local pending ops + pulled ops) so `mergeVaultStates` can call
  `mergeBase`. `VaultState` gains the DAG (or a parent lookup) instead of relying on
  per-entry `ancestorContentHash`.
- `merge/state-merge.ts`: in `resolveContentConflict`, use `mergeBase(localHead,
  remoteHead)` for the three-way base and reachability for fast-forward. Keep the
  existing conflict/clean outcomes.

**Done when** all merge tests pass using the DAG-computed base; the FF and
concurrent-conflict cases are driven by reachability/LCA. `ancestorContentHash`
still exists but is no longer *read* by the merge.

**Commit:** `feat(merge): derive three-way base from a content DAG (LCA), not the scalar ancestor`

## Step 3 — Retire `ancestor-policy` and `ancestorContentHash`

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
