# Sync Engineering Guide

The durable orientation doc for anyone — human or agent — changing the sync engine.
AGENTS.md covers generic Obsidian-plugin conventions; this covers *how this project's
sync actually works, why it's built this way, and how to change it without causing
silent data loss.* Read this before touching anything under `src/core`, `src/merge`, or
`src/network`.

The specs in `docs/*-spec.md` and the `*_AUDIT.md` files at the repo root are
**point-in-time** (plans and findings). This guide is meant to stay current — update it
when an invariant or pattern changes.

---

## 1. What this is

An **end-to-end-encrypted vault sync** for Obsidian against an *untrusted* server. The
server stores only ciphertext + routing metadata and **never merges** — all conflict
resolution is client-side. Two (or more) devices sharing a passphrase converge to the
same vault state by replaying an ordered log of operations.

The core mental model: each device keeps a **local op log** and a **cursor** into the
server's global op sequence. A sync round pulls new remote ops, merges them into local
state, applies the result to the vault, pushes local ops, and advances the cursor. The
merge is a **CRDT-style deterministic replay**: every device that sees the same source
ops computes the same result, so most merge output is *not* re-pushed (it's redundant).

The prime directive, everywhere: **the user's data is critical and must never be
silently overridden, dropped, or left divergent.** When in doubt, defer and surface —
never guess and overwrite.

---

## 2. Architecture: ports & adapters

The single most important structural rule:

> **Logic lives in obsidian-free modules behind ports. Anything that imports `obsidian`
> is thin glue, verified by manual smoke — never business logic.**

This is what makes the engine unit-testable without a running Obsidian. Layers:

- **Ports** (`src/ports/`) — narrow interfaces the engine depends on:
  `VaultFiles` (read/write/move/trash), `MetadataStore` (`.vault-sync/*` persistence),
  `VaultWatcher` (create/modify/delete/rename events), `EditorSaver` (flush open
  editors), `Notifier` (user-facing toasts).
- **Obsidian adapters** (`src/network/obsidian-*.ts`) — the *only* place `obsidian` is
  imported besides `main.ts` and `src/ui/`. Each is a dumb pass-through implementing a
  port. **Keep them dumb.** They are not unit-tested (no real Obsidian in tests); their
  behavior is pinned as assumptions in `__tests__/helpers/fakes/README.md` and verified
  by manual smoke + the Go-server integration suite.
- **Engine** (`src/core`, `src/merge`, `src/network/*` minus the adapters) — pure/
  obsidian-free. This is where correctness lives and where tests concentrate.
- **Glue** (`src/main.ts`, `src/ui/`) — plugin lifecycle, ribbon/status rendering, modal
  construction, settings. `main.ts` is a *thin adapter*: it wires real implementations
  into the engine and renders state; it holds almost no logic.

If you find yourself writing a branch, a loop, or a decision inside `main.ts` or a modal,
stop — that logic belongs in an obsidian-free module (usually `SyncCoordinator` or the
relevant `core`/`merge` unit) with a port for the Obsidian bit.

### Module map (engine)

| Module | Role |
|--------|------|
| `core/hlc.ts` | Hybrid Logical Clock — total ordering of events across devices; persisted (F7) so logical time never regresses across a wall-clock jump. |
| `core/file-registry.ts` | The source of truth for file **identity**: UUID → `{path, contentHash, ancestor…, deleted}`. `adoptRemote` converges identity across devices. |
| `core/content-store.ts` | Hash → bytes cache (`.vault-sync/`), incl. retained ancestors for three-way merge; age-aware GC. |
| `core/operation-logger.ts` | Watches vault events, debounces edits into ops, persists the pending oplog. Also the cold-start capture (`captureOfflineChanges`) and force-push baseline (`captureAllAsBaseline`). |
| `core/operations.ts` | Op factories (create/update/delete/move + resolution ops). |
| `core/exclusion-policy.ts` | Glob-based path exclusion (`.obsidian`, `.vault-sync`, user patterns). |
| `merge/state-merge.ts` | **The heart.** Pure `mergeVaultStates(local, remote) → actions`. Commutative & deterministic. Decides write/delete/move/conflict per file. |
| `merge/diff3.ts` | Three-way line merge + `resolveConflictChunkLines` (the logic behind the conflict modal's Accept buttons). |
| `merge/ancestor-policy.ts` | Pure decision for how the three-way-merge ancestor hash advances after a round. |
| `network/server-sync.ts` | `ServerSyncClient.runSync()` — orchestrates one round (pull→fetch→push→merge→apply→cursor). Obsidian-free; driven by fakes in tests. Also `reconstructRemoteState` and `safeCursor`. |
| `network/sync-applicator.ts` | Applies merge actions to the real vault (writes/moves/trashes, runs conflict handlers). Reports `deferred` + `converged` fileIds back to the round. |
| `network/vault-sync-host.ts` | `PluginVaultSyncHost` — bridges the obsidian-free round to the live stores. |
| `network/sync-coordinator.ts` | Obsidian-free orchestration extracted from `main.ts`: the capture→round→record sequence, manual/auto conflict decisions, reset/rebaseline, and outstanding-conflict bookkeeping. |
| `network/sync-state-store.ts` | The **observable** sync state (`.vault-sync/sync-state.json`): outstanding conflicts, deferred/stranded files, last error, last-round summary. |
| `network/cursor-store.ts` / `hlc-store.ts` | Scalar cursor + persisted HLC. |
| `network/encryption.ts` | `VaultCrypto` — passphrase-derived key, op/blob envelopes, blinded content hashes (unlinkable dedup). |
| `network/server-http.ts` / `fake-server.ts` | Real HTTP `ServerApi` vs in-memory fake (contract-tested to be equivalent). |

---

## 3. Anatomy of a sync round (and its load-bearing invariants)

`ServerSyncClient.runSync()` (`server-sync.ts`) — the order and the *why* both matter:

1. **`buildLocalState()`** — snapshot registry entries + pending ops + content. It
   re-hashes live files against the registry and corrects the snapshot to the *real disk
   hash* (never the stale recorded one) so the merge compares true content.
2. **Pull** remote ops since the cursor, decrypt each. Keep each op's server `seq`.
3. **Reconstruct the remote projection** (`reconstructRemoteState`) and fetch the blobs
   it needs (verifying each decrypts back to its asserted content hash).
   - **Exclude our own re-pulled ops** from the projection. We persist the *pull* cursor,
     not the append head, so our own ops re-pull every round; projecting them as "remote"
     would corrupt the ancestor and silently clobber a peer's concurrent edit.
4. **Push** our pending ops (blobs first, then the append) — *before* applying, so ops
   are durable on the server before the local oplog is cleared. The append is idempotent
   by `clientOpId`, so a crash in between is safe.
5. **Merge + apply** — `mergeVaultStates`, advance the HLC past the merged time *before*
   applying (so a user-resolved conflict minted during apply dominates what it
   supersedes), then `applicator.applyActions`.
6. **Save the cursor** via `safeCursor(...)`, which **holds the cursor back** when a blob
   was unavailable (F3) or a destructive action was deferred (F5/auto-defer), so those
   ops re-pull next round instead of being stranded.

Invariants you must preserve if you touch the round:
- **Push before apply.** Durability first; idempotent append makes it crash-safe.
- **Persist the pull cursor, not the append head** — another device may have appended in
  between; jumping to the head would skip their ops.
- **Never advance the cursor past an op you couldn't fully apply** (F3/F5). That's what
  `safeCursor` guarantees; the applicator's `deferred` set drives it.
- **Only locally-authored ops are pushed.** Merge-derived content replays identically on
  every device (redundant). The lone exception is a user-resolved conflict, which the
  applicator re-emits as an op so a fresh human decision replicates.

---

## 4. Core invariants (the data-safety spine)

These are enforced across `state-merge`, `sync-applicator`, and `server-sync`. The
`F#` labels appear throughout the code and the `*_AUDIT.md` / `ops-sync-data-safety-spec`
docs.

- **F1 — never fabricate content.** If a winning side's bytes are unavailable, the merge
  returns `no_op` and defers, rather than writing an empty/guessed file. This — *not* any
  applicator-level guard — is the real truncation protection. (See §6, G13: a blunt
  applicator guard that refused empty writes was *removed* because it produced false
  positives, blocking legitimate file-emptying.)
- **F2 — create/create identity collision.** Two devices independently creating the same
  path mint different UUIDs. `resolveCreateCollision` converges them to one id
  deterministically (`adoptRemote`), raising a conflict only for genuinely different
  content.
- **F3 — stranded content.** A referenced blob that can't be fetched holds the cursor
  back and is surfaced as `stranded`, never silently skipped.
- **F4 — stale-cursor 409.** A too-stale append is recovered by re-pulling and retrying
  (bounded), never wedged.
- **F5 — edit during the sync window.** If a file drifts on disk between snapshot and
  apply, the destructive action is deferred, the edit re-captured as an op, and the
  cursor held — the in-flight edit is never overwritten.
- **F7 — HLC persistence.** Logical time is persisted per-op and on shutdown so a
  wall-clock regression can't rewind below an already-issued timestamp.

**File identity is by UUID, not path.** The merge is keyed on `fileId`. `adoptRemote`
converges two devices onto one id for the same path and moves the pathIndex — get this
wrong and edits to "the same file" never reconcile (permanent divergence with no conflict
raised). Any new `write_local`-shaped path must keep identity consistent.

**HLC decides last-writer-wins**, with a deterministic `deviceId` tie-break. Any
"winner" decision (path, content, resolution) must be computed the same way on both
devices from the same inputs, or convergence breaks. Keep merge output **commutative** —
`merge(A,B)` and `merge(B,A)` must agree.

---

## 5. The conflict lifecycle (subtle — most bugs lived here)

A conflict flows through several states; the bookkeeping is centralized in
`SyncCoordinator` + `SyncStateStore`, and the transitions are easy to get wrong.

1. **Surface** — `state-merge` emits a `conflict` / `delete_conflict` / `binary_conflict`
   action when both sides diverged since the ancestor.
2. **Decide** — `SyncCoordinator.decide*Conflict` branches on the round source:
   - **manual** → run the interactive modal. A real resolution **clears** the outstanding
     badge and re-emits a resolution op; a **skip** (dismiss) **records** an outstanding
     badge and lets the cursor advance (a deliberate choice).
   - **auto** → never open a modal: **record** the badge and return `DEFER_CONFLICT`,
     which makes the applicator hold the cursor (re-presents on the next manual sync).
3. **Replicate** — a resolution op carries `supersedes` (the two content hashes it
   settles). A peer still holding either side **adopts** it via a clean `write_local`
   (the `supersedes` shortcut in `resolveContentConflict`) instead of re-conflicting.
4. **Clear the badge on convergence** — because step 3's adoption is a `write_local` and
   never re-enters `decide*`, the applicator reports every fileId it **converged**
   (applied write/move/delete or a resolved conflict — *not* a skip/defer/drift). The
   coordinator clears the badge for those. Without this, a skipped-then-auto-resolved
   file shows "1 conflict to resolve" forever even though the vaults are identical.
5. **Self-heal** — "Re-check for conflicts" rewinds the cursor to 0 *and* clears all
   badges before replaying the full log: genuinely-still-conflicting files re-record,
   stale badges heal.

The trap to remember: **a conflict can be resolved without the conflict handler ever
running again** (auto-adoption via `supersedes`). Any state tied to "the handler was
called" will leak. Drive badge/state changes off what the round *converged*, not off
handler invocations.

---

## 6. Hard-won lessons & the gotcha catalog

Real bugs found and fixed during the robustness/coverage work. Each is now a regression
test; the *classes* are what to watch for.

- **Edit-timing (S1).** Ops are minted from async vault `modify` events. An edit made
  right before "Sync" may not have fired its event yet, so the round would miss it. Fix:
  the coordinator force-saves editors + runs `captureOfflineChanges` (disk-drift capture)
  *before* every round. **Lesson:** never assume a vault event has fired; reconcile
  against disk.
- **Silent path divergence (H5).** A rename *combined with* an edit in one round put the
  new content at the *old* path (the clean-merge branch used the local path). Fix: target
  the HLC-winning path and have the applicator trash the stale old copy + fix the
  pathIndex. **Lesson:** any `write_local` must account for a concurrent rename; a merge
  action's path is a decision, not a given.
- **False-positive guard (G13).** A `wouldTruncateNonEmpty` guard refused *any* empty
  write over a non-empty file — which permanently blocked a legitimate file-emptying.
  Since `state-merge` already `no_op`s on missing content (F1), the guard could only ever
  false-positive. It was **removed**. **Lesson — for a data-safety tool, a guard that
  produces false positives (silent divergence) is worse than no guard.** Prefer one
  correct guarantor (the merge's F1) over redundant blunt backstops.
- **Phantom op (G11).** Create-then-delete before any sync pruned the create but still
  emitted a delete op referencing an un-uploaded hash. Fix: the pair fully cancels.
  **Lesson:** transient files must leave no trace on the wire.
- **Orphaned status (badge-clear).** See §5.4. **Lesson:** convergence, not handler
  invocation, is the signal.

Meta-lesson across all of them: **the dangerous failures are silent** — an edit that
doesn't propagate, content at the wrong path, a file that won't empty, a badge that never
clears. Loud failures (an error toast) are fine; silent divergence is the enemy. When
adding a guard or a shortcut, ask "what does this *silently* do in the concurrent case?"

---

## 7. Testing approach

The doctrine (see the `vault-ports-and-testing` memory): **tests drive the real
production stack over in-memory fakes — never a reimplementation of the merge/apply
logic.**

- **`TestDevice`** (`__tests__/helpers/test-device.ts`) wires the genuine
  registry/content-store/oplog/applicator/host over `FakeVaultFiles`/`FakeMetadataStore`/
  `FakeVaultWatcher` + a settable wall clock. User-action helpers (`seedFile`, `editFile`,
  `renameFile`, `renameAndEdit`, `deleteFile`, `seedExistingFile`) drive the real
  `OperationLogger` path — tests never hand-build ops or ids.
- **`TestDevice.reload()`** builds a fresh stack over the *same* fakes (persisted state
  survives, in-memory state drops) — models a plugin restart / crash-recovery. Use it for
  durability tests.
- **Two-device convergence** is the default shape: A and B (and often C) share a
  `FakeSyncServer`; assert the end state *and* the merge **decision** (`device.applied`),
  so the test proves the mechanism, not just the outcome.
- **The contract suite** (`__tests__/helpers/contract-suite.ts`) runs the *same*
  behavioral scenarios against both the in-memory fake and the real Go server
  (`npm run test:integration`). This equivalence is what stops the fake from drifting from
  the server it stands in for. Assert only *observable* behavior, never a fake's internals.
- **The coordinator** is unit-tested directly (`sync-coordinator.test.ts`) with fake
  ports/spies — that's where the capture ordering, error path, and conflict bookkeeping
  live. `TestDevice` deliberately does *not* route through the coordinator/`SyncStateStore`;
  assert coordinator-level behavior there, and assert the *round summary* (returned by
  `runSync`) in `TestDevice` tests to bridge the two.
- **Coverage** (`npm run test:coverage`) is a **blind-spot finder, not a target.** It's
  scoped to the obsidian-free modules; don't chase 100% and don't gate on a percentage.
- **The discovery-test pattern:** when a scenario surfaces a genuine bug, write the test
  asserting the *correct* behavior, mark it `test.skip`/`test.todo` with a root-cause
  note, and report it — never write a passing assertion around wrong behavior. Several of
  §6's bugs were found exactly this way.

---

## 8. How to change the sync engine safely — checklist

1. **Keep obsidian-free modules obsidian-free.** No `obsidian` import in `core/`,
   `merge/`, or `network/*` except the `obsidian-*` adapters. If you need an Obsidian
   capability in the engine, add a port + a thin adapter.
2. **Put logic where it's testable.** New orchestration → `SyncCoordinator`. New merge
   behavior → `state-merge` (keep it pure & commutative). New persisted state →
   a store modeled on `cursor-store.ts` with defensive `load()`.
3. **Add a scenario test through `TestDevice`** (two-device where convergence matters),
   asserting both the decision and the end state. Add a durability angle with `reload()`
   if the change touches persistence or the round.
4. **Run `npm run build` && `npm test`.** Both must be green. Glance at
   `npm run test:coverage` for new blind spots.
5. **Protect the regression-critical tests** when touching the merge/applicator/cursor:
   `core.test.ts` (`mergeVaultStates` cases), `contract-suite`, `delete-rename-conflict`,
   `create-create-collision`, `resolution-convergence`, `concurrent-conflict-dataloss`,
   `edit-during-sync-dataloss` (F5), `round-interruption-durability`. If your change
   diverges from one of these, that's a design tension to surface, not force green.
6. **Ask the silent-divergence question** (§6): in the concurrent case, does this ever
   drop, overwrite, or strand a change without a trace? If yes, defer + surface instead.
7. **Never commit build artifacts** (`main.js`, `coverage/`, `node_modules/`) — they're
   gitignored. Commits omit the Co-Authored-By trailer (project convention).

---

## 9. Where to look for more

- `docs/sync-test-coverage-spec.md` — the testability refactor + two-device scenario
  matrix (what's covered and why).
- `SYNC_ROBUSTNESS_AUDIT.md` + `docs/sync-robustness-remediation-plan.md` — the S1–S5
  robustness/UX work.
- `OP_FORMAT_AUDIT.md` + `docs/ops-sync-data-safety-spec.md` — op wire format + the
  F-series data-safety invariants in depth.
- `docs/server-api-spec.md` — the client↔server wire contract (the five endpoints).
- `__tests__/helpers/fakes/README.md` — the semantic assumptions the real Obsidian
  adapters must honor.

**Known manual-smoke surface** (not covered by automated tests, verify by hand before a
release): the `obsidian-*` adapters, `src/ui/` modals and rendering, `main.ts` wiring, the
editor force-save, and end-to-end behavior in a real vault. The `npm run test:integration`
suite covers the real server wire but still runs the client over fakes for the vault side.
