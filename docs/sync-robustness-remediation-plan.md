# Sync Robustness & UX — Remediation Plan

Fixes the findings in `SYNC_ROBUSTNESS_AUDIT.md` (S1–S5). Steps are **ordered and
dependent** — later steps build on the plumbing earlier ones add. One subagent per
step; the orchestrator verifies `npm run build` + `npm test` and commits after each.

Guiding invariants (must hold after every step):
- **No silent data loss.** Nothing drops an un-synced local change without either
  pushing it or an explicit user confirmation.
- **Every non-clean outcome is recorded and surfaced** — a skip, a deferral, a stall,
  an error must land in an inspectable state, not just a `console.warn`.
- The obsidian-free modules (`core/`, `merge/`, `network/server-sync.ts`) stay
  obsidian-free and unit-testable against the in-memory fakes.

---

## Step 1 (S1) — Capture on-disk drift at the start of every sync

**Problem.** An edit made just before pressing sync isn't pushed: `flush()` only drains
already-armed debounce timers, and `buildLocalState` corrects its in-memory snapshot but
never mints an op, so only pending ops get pushed.

**Change.**
- In `main.ts::triggerSync`, before `buildLocalState`, after the existing `flush()`, run
  a full drift-capture: call `opLogger.captureOfflineChanges()` (idempotent; re-hashes
  live files vs the registry and emits create/update/delete ops for any drift). This is
  the core, testable fix.
- Best-effort force-save open editor buffers first, so the drift capture sees the latest
  bytes on disk. Iterate `app.workspace` markdown leaves and trigger a save if the
  installed Obsidian API exposes one; guard everything so a missing API can't throw.
  Where the API isn't available, the on-disk drift capture still covers the
  already-saved case. Do **not** regress the existing `flush()` behaviour.
- Optionally rename/extract a `captureDrift()` alias if it reads better, but reusing
  `captureOfflineChanges` verbatim is acceptable — keep the diff minimal.

**Tests (required).** New fakes-based test (pattern of
`__tests__/edit-during-sync-dataloss.test.ts`, driving the real stack via `TestDevice`):
a file drifts on disk with **no** pending op (simulate the pre-round window), a sync
runs, and the drift is (a) turned into a pending op and (b) pushed to the server / lands
on a second device. Assert it converges in ONE sync, not two.

**Acceptance.** `npm run build` clean, all tests green, new test proves single-sync
propagation of a pre-sync edit.

---

## Step 2 (S2) — Persisted sync-state model + real status surface

**Problem.** Skips/deferrals/stalls/errors are invisible; a skip is sticky (cursor
advances past it); the "conflict" ribbon state is dead code; status is a transient
Notice.

**Change.**
1. **`SyncStateStore`** — new obsidian-free module (model on `network/cursor-store.ts`),
   persisting `.vault-sync/sync-state.json`. Shape (JSON-serializable):
   ```ts
   interface SyncState {
     outstandingConflicts: Array<{
       fileId: string; path: string;
       kind: 'content' | 'delete' | 'binary';
       firstSeen: number;          // wall ms
     }>;
     deferred: Array<{ fileId: string; path: string; reason: 'drift'; at: number }>;
     stranded: Array<{ contentHash: string; at: number }>;   // F3 missing blobs
     lastError: { message: string; at: number } | null;
     lastSync: { at: number; pushed: number; pulled: number; conflicts: number } | null;
   }
   ```
   Provide `load()/save()`, plus typed mutators (`recordConflict`, `clearConflict(fileId)`,
   `setRound(summary)`, `setError`). Load defensively (corrupt/absent → empty state).
2. **`runSync` returns a summary** — change `ServerSyncClient.runSync(): Promise<void>`
   to return `SyncRoundSummary { pushed: number; pulled: number; deferred: string[];
   stranded: string[] }`. `deferred` = the `drifted` set it already computes; `stranded`
   = `missingContent` (already computed in `fetchRemoteBlobs`). Pure plumbing — assert it
   in the existing fake-server tests.
3. **Record skips instead of dropping them.** The conflict-handler closures in `main.ts`
   already observe a skip (modal resolves `null`). On skip → `syncState.recordConflict(...)`;
   on a real resolution → `clearConflict(fileId)`. No applicator change needed for this.
4. **`SyncStatusModal`** — new Obsidian `Modal` replacing the `showSyncStatus` Notice.
   Shows: last-sync summary, pending-op count + paths, outstanding conflicts (each with a
   **Resolve now** button → rewind cursor + sync, reusing `recheckConflicts`), deferred +
   stranded files, last error, server/key fingerprint. Wire the existing
   `view-sync-status` command and add a settings button to open it.
5. **Wire the dead indicator.** Drive `updateRibbonState('conflict')` and the status-bar
   text from `syncState.outstandingConflicts.length`. Remove the never-assigned
   `pendingConflicts` field or replace it with a getter over `syncState`.
6. After each round in `triggerSync`, write the summary + refresh deferred/stranded into
   `syncState`, persist, and update ribbon/status. On sync error, `setError`.

**Tests (required).** Unit tests for `SyncStateStore` (round-trip, corrupt-load →
empty, mutators). Extend a fake-server round test to assert the returned
`SyncRoundSummary`. A test that a skipped conflict is recorded as outstanding and a
resolved one clears it (can be driven at the state-store + closure level).

**Acceptance.** Build clean, tests green; ribbon reflects outstanding conflicts; skip is
recorded, not lost.

---

## Step 3 (S3) — Make "Reset sync state" non-destructive

**Problem.** `resetSyncState` calls `clearOps()` without pushing, silently discarding
un-synced changes; leaves `''` placeholder hashes until the next reload.

**Change.**
- Reorder/replace: `reconcileWithVault` → **`captureOfflineChanges()`** (re-emits ops for
  everything on disk, filling real hashes) instead of `clearOps()`. Result: registry
  rebuilt, pending ops reflect true disk state, nothing dropped.
- If any pending ops exist at the moment of reset, first show a confirmation modal
  ("Rebuild sync metadata? N unsynced change(s) will be re-captured and pushed on the
  next sync, not discarded."). Provide a small reusable `ConfirmModal`.
- Update the settings description to match the new (safe) behaviour.

**Tests (required).** Test that reset with pending ops present does **not** reduce the
effective set of changes that reach the server on the next sync (drive via `TestDevice`).

**Acceptance.** Build clean, tests green; reset can no longer strand un-synced edits.

---

## Step 4 (S4) — "Re-baseline this device to the server" (rebuild + force-push)

**Problem.** No non-destructive way to declare this client the source of truth and push
its full state up.

**Change.**
- Add `OperationLogger.captureAllAsBaseline()`: for **every** live, non-excluded file,
  ensure a pending op exists carrying current content (create if untracked, otherwise
  update), regardless of whether the registry hash already matches — so the server is
  guaranteed to receive every file. Idempotent on the server via `clientOpId` + blob
  dedup, so re-running is safe.
- Add `main.ts::rebaselineToServer()`: confirmation modal (explain "this device's
  version wins for any file also edited elsewhere; other devices merge against it") →
  `captureAllAsBaseline()` → `triggerSync('manual')` → write the round summary into the
  S2 status state.
- Settings button "Re-baseline this device to the server" (destructive styling +
  confirmation). Surface the result via the S2 status modal.

**Tests (required).** Two-device `TestDevice` test: device A re-baselines; device B pulls
and ends up with A's full file set. Assert idempotence (running it twice doesn't
duplicate files or corrupt content).

**Acceptance.** Build clean, tests green; a re-baseline reconstructs server state from
the client without touching vault files.

---

## Step 5 (S5) — Auto-sync defers conflicts instead of popping modals

**Problem.** A background auto-sync can open a blocking conflict modal; Escape silently
skips (cursor advances).

**Change.**
- Thread the sync `source` ('manual' | 'auto') to the conflict-handler closures (store
  `this.currentSyncSource` for the duration of the round). In `'auto'` mode the handlers
  must **not** open a modal: record the conflict as outstanding (S2), and signal a defer.
- Hold the cursor when a conflict was deferred in auto mode, mirroring the F5 drift path,
  so the conflict re-presents on the next **manual** sync instead of being consumed. Use
  the applicator's/round's existing deferral plumbing (extend `SyncRoundSummary` /
  `safeCursor` so an auto-deferred conflict caps the cursor at `startCursor`).
- Ribbon goes to the conflict state after an auto round that deferred anything.

**Tests (required).** Auto-mode round with a conflict: no modal handler is invoked, the
conflict is recorded outstanding, the cursor does not advance past it, and a subsequent
manual sync still presents it.

**Acceptance.** Build clean, tests green; auto-sync never blocks on a modal and never
silently consumes a conflict.

---

## Orchestration & verification

- One subagent per step, in order. Each: implement + add/adjust tests + run
  `npm run build` and `npm test`, report results. Subagents do **not** commit.
- Orchestrator re-runs build + tests, then commits the step with a `fix(sync)` /
  `feat(sync)` message referencing the finding (e.g. `S1`). Commit after each step.
- If a step's tests can't be made green, stop and surface it rather than committing red.
