# Sync Test Coverage Spec

Goal: every sync **happy path** and every meaningful **two-device gotcha** covered by a
deterministic test that drives the *real* device stack (via `TestDevice` /
`runContractSuite`), never a reimplementation. Where the Obsidian runtime blocks a
test, extract the business rule into an **obsidian-free entity behind a thin port** and
test that; keep the Obsidian adapter a dumb pass-through.

Principle (from `vault-ports-and-testing` memory): tests drive the production classes
over the in-memory fakes. We never assert against a test double's internals.

---

## Part 1 — Testability refactors (make the untestable testable)

### 1.1 `SyncCoordinator` — extract the orchestration trapped in `main.ts`  ⟵ highest value
The largest untested surface is `VaultSyncPlugin`. Pure orchestration logic lives inside
an Obsidian `Plugin` subclass and can't be unit-tested: `triggerSync` (the
editor-save → flush → captureOfflineChanges → runSync → recordRoundOutcome/clearError
sequence, and the error→setError path), the conflict-handler closures' auto/manual
branching (`currentSyncSource` → `DEFER_CONFLICT` vs. interactive modal + skip
recording), `resetSyncState`, and `rebaselineToServer`.

**Extract `src/network/sync-coordinator.ts` (obsidian-free)** owning that logic, depending
only on interfaces already present plus two small new ports:
- `EditorSaver { saveOpenEditors(): Promise<void> }` — the one genuine Obsidian bit of
  S1 (see 1.2).
- `Notifier { info(msg): void; error(msg): void }` — wraps `new Notice(...)` so the
  coordinator can be tested without Obsidian; main provides the real impl.
- Existing collaborators passed in: `opLogger`, a `runRound()` thunk (or a
  `ServerSyncClient` factory), `SyncStateStore`, `HybridLogicalClock`, and the
  interactive conflict resolvers (main still owns the modals).

The coordinator exposes `sync(source)`, `reset()`, `rebaseline()`, and a
`decideConflict(action, source)` used by the applicator handlers. `main.ts` shrinks to a
thin adapter: construct the coordinator with Obsidian impls, and render
ribbon/status-bar from its state.

**Constraint:** behavior-preserving. The underlying stack (runSync, applicator, stores)
is already covered by existing tests; this move must keep them green and add coordinator
unit tests. Verify `npm run build` + full suite after.

**Tests — `__tests__/sync-coordinator.test.ts`:**
- capture ordering: `saveOpenEditors` → `flush` → `captureOfflineChanges` → round, in
  that order (spy the ports).
- happy round: summary folded into `SyncStateStore` (`setRound`), `clearError` called.
- error path: a throwing round calls `setError`, does NOT `clearError`, surfaces via
  `Notifier.error`, leaves pending ops intact.
- manual conflict skip: interactive resolver returns null → `recordConflict`, decision
  is skip (cursor-advance path unchanged).
- auto conflict: source='auto' → no interactive resolver invoked, `recordConflict`,
  decision is `DEFER_CONFLICT`.
- reset: with pending ops and confirm=false → aborts (no capture); confirm=true →
  `reconcileWithVault` + `captureOfflineChanges`, never `clearOps`.
- rebaseline: confirm=true → `captureAllAsBaseline` then a round; confirm=false aborts.

### 1.2 `EditorSaver` port (new)
The only S1 piece that must touch Obsidian (`workspace` markdown leaves → `view.save()`).
Behind a port so the coordinator's capture sequence is unit-testable and the Obsidian
glue is a ~10-line adapter (`src/network/obsidian-editor-saver.ts`) that is intentionally
not unit-tested (documented as manual-smoke, like the other thin adapters).

### 1.3 Conflict-resolution logic — already mostly pure (LOW)
`resolveConflictChunkLines` is already an extracted pure helper. Confirm the
splice/ordering in `buildResolvedContent` (apply-in-reverse, default-to-local) is
covered by a pure unit test; if not, extract `applyResolutions(mergedLines, conflicts,
resolutions)` and test it. The rest of the modal is thin rendering — leave it.

### 1.4 Thin Obsidian adapters — keep thin, document the fakes' fidelity (LOW)
`ObsidianVaultFiles/MetadataStore/VaultWatcher` are pass-throughs behind ports; the fakes
stand in for them. Full DOM/vault mocking is out of scope. Instead add a short
`__tests__/helpers/fakes/README` (or header comments) pinning the **semantic assumptions**
the fakes encode and that the real adapters must honor: `modify` is async/debounced,
`rename` fires with `oldPath`, `create` does NOT fire for files present before listeners
attach (the reason `captureOfflineChanges` exists). The Go-server integration contract
already guards the wire. Real-adapter faithfulness stays a manual smoke item.

---

## Part 2 — Sync scenario matrix (two devices unless noted)

Legend: ✓ already covered · ➕ new. "Where" is the target test file for ➕ items.

### Happy paths (H)
| id | scenario | why it matters | status | where |
|----|----------|----------------|--------|-------|
| H1 | create on A → B materialises it | baseline propagation | ✓ contract | |
| H2 | one-sided text edit → clean `write_local` on B | the commonest op; no conflict expected | ➕ | two-device-happy-paths |
| H3 | one-sided delete → tombstone on B | | ✓ contract | |
| H4 | one-sided rename → `move_local` on B | id-stable path follow | ✓ contract | |
| H5 | rename **and** edit content in the same round | move + update interplay, id stability | ➕ | two-device-happy-paths |
| H6 | identical concurrent create (same content) → one id, no conflict | F2 dedupe | ✓ | |
| H7 | one round touching several files (create+edit+delete+rename) | realistic batch; ops don't cross-contaminate | ➕ | two-device-happy-paths |
| H8 | concurrent edit to the **same** resulting content → `no_op`, no conflict | identical-change convergence | ➕ | two-device-happy-paths |
| H9 | three devices, each pair converges | fan-out replication | ✓ partial → strengthen | two-device-happy-paths |
| H10 | first-enable on a **pre-existing** vault emits creates for every file | `captureOfflineChanges` on cold start | ➕ | offline-capture |

### Gotchas (G)
| id | scenario | status | where |
|----|----------|--------|-------|
| G1 | concurrent conflicting edits, no silent loss | ✓ | |
| G2 | edit lands *during* the sync window (F5) | ✓ | |
| G3 | edit lands *just before* sync (S1) | ✓ | |
| G4 | delete vs rename → delete/rename conflict | ✓ | |
| G5 | delete vs edit → delete_conflict, resolution replicates | ✓ | |
| G6 | concurrent binary edits → binary_conflict | ✓ | |
| G7 | referenced blob temporarily missing (F3) — cursor never strands | ✓ | |
| G8 | stale-cursor 409 on append recovered (F4) | ✓ | |
| G9 | HLC monotonic across wall-clock regression (F7) | ✓ | |
| G10 | `''` never-captured sentinel never escapes (audit G) | ✓ | |
| G11 | create-then-delete **before any sync** → peer never sees the file (prune) | ➕ | offline-capture |
| G12 | truncation guard: empty bytes must NOT overwrite a non-empty file on the peer | ➕ | empty-and-truncation |
| G13 | empty↔non-empty transitions propagate (empty→content, content→empty) | ➕ | empty-and-truncation |
| G14 | manual skip → `recheckConflicts` (cursor rewind) re-surfaces it → resolve → converge | ➕ | maintenance-under-concurrency |
| G15 | re-baseline (S4) while the peer holds a concurrent edit → LWW/conflict, no silent loss | ➕ | maintenance-under-concurrency |
| G16 | multi-device auto-defer (both on auto) then one manual resolves → all converge | ➕ | maintenance-under-concurrency |
| G17 | exclusion transition: a tracked file becomes excluded (and back) | ➕ (low) | empty-and-truncation |

### Durability / interruption (C) — a round crashing at each seam
| id | crash point | expected | status | where |
|----|-------------|----------|--------|-------|
| C1 | after push, before `clearPendingOps` | re-run is idempotent (no double-append) | ✓ partial | round-interruption-durability |
| C2 | after apply/`clearOps`, before `saveCursor` | re-run re-pulls, merges to no-op, converges | ➕ | round-interruption-durability |
| C3 | full restart: registry+oplog+cursor+sync-state reload from metadata and sync continues | ➕ | round-interruption-durability |
| C4 | between blob `putBlob` and op `appendOps` | next round re-checks blobs; append idempotent | ➕ | round-interruption-durability |

To model a crash/restart deterministically, add a `TestDevice.reload()` helper (Part 3)
that constructs a fresh device stack over the *same* `FakeMetadataStore` + `FakeVaultFiles`
— i.e. everything persisted survives, in-memory state is dropped.

---

## Part 3 — Harness extensions (foundational for Part 2 ➕ items)
Add to `TestDevice` / helpers, once, before the parallel scenario work:
- `reload(): Promise<TestDevice>` — new stack over the same fakes (simulated restart) for
  the C-series and persistence round-trips.
- `renameAndEdit(from, to, text, wall)` — a rename that also changes content (H5).
- `seedExistingFile(path, text)` — write to `files` **without** emitting a create event,
  to model a pre-existing vault for H10 (then the test calls `captureOfflineChanges`).
- keep every helper driving the real `OperationLogger`/registry — no hand-built ops.

## Part 4 — Coverage guardrail
Add `@vitest/coverage-v8` + `npm run test:coverage`, and a soft line/branch threshold on
`src/core/**` and the sync-critical `src/network/{server-sync,sync-applicator,
sync-state-store,vault-sync-host,sync-coordinator}.ts`. Coverage is a blind-spot finder,
not the target — the scenario matrix is. Report uncovered branches; don't chase 100%.

---

## Part 5 — Orchestration
- **Step A (sequential):** 1.1 + 1.2 — extract `SyncCoordinator` + `EditorSaver`/`Notifier`
  ports, thin `main.ts`, add `sync-coordinator.test.ts`. Verify build + full suite. Commit.
- **Step B (sequential, foundational):** Part 3 harness extensions + 1.3 conflict-logic
  test if missing. Commit. (Unblocks parallel Step C without file clashes.)
- **Step C (parallel fan-out — each a distinct NEW test file, no shared source edits):**
  - C-1 `two-device-happy-paths.test.ts` — H2, H5, H7, H8, H9
  - C-2 `offline-capture.test.ts` — H10, G11
  - C-3 `round-interruption-durability.test.ts` — C1–C4
  - C-4 `maintenance-under-concurrency.test.ts` — G14, G15, G16  +  `empty-and-truncation.test.ts` — G12, G13, G17
  Each agent adds only its file(s), runs the full suite, and **reports any scenario that
  exposes a genuine bug as `test.todo` + a written note — never forces a test green.**
- **Step D (sequential):** Part 4 coverage tooling; triage anything Step C flagged. Commit.

After Step C the orchestrator runs the whole suite, reviews, and commits (grouped). Any
real bug a scenario surfaces is triaged before closeout — that discovery is a feature of
the exercise, not a failure.
