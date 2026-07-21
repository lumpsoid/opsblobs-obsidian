# Ops Sync Data-Safety Audit — Findings & Remediation Spec

Status: **active remediation**. Audit performed 2026-07-19 against `HEAD` of
`chore/p0-test-tooling` (all 100 unit tests green). This document is the single
source of truth for the remediation: it is both the audit record and the
per-fix briefing each implementing agent works from.

---

## 1. Context & scope

`obsidian-vault-sync` is an Obsidian community plugin doing E2E-encrypted vault
sync against an **untrusted** server that stores only ciphertext + routing
metadata and never merges. All merge/CRDT logic is client-side. The audit
covers the **operation path**: how local edits become ops, how ops travel to
and from the server, and how remote ops are merged and applied to the vault.

**Safety of user data is the overriding constraint.** The bar for every fix:
_a transient or edge condition must never cause silent, permanent loss or
corruption of a user's working file._ When in doubt, the safe action is to
**keep local bytes and defer** (retry next round) or **surface a conflict** —
never to fabricate, overwrite with empty, or silently clobber.

### The ops path (modules)

- `src/core/operation-logger.ts` — vault events → ops (debounced); offline-change capture.
- `src/core/file-registry.ts` — UUID↔path identity, tombstones, ancestor tracking.
- `src/core/content-store.ts` — content-addressed byte store + GC.
- `src/core/hlc.ts` — hybrid logical clock (total order for last-writer-wins).
- `src/network/server-sync.ts` — `runSync()` orchestrator: pull → fetch blobs → push → merge → apply → save cursor. Plus pure `reconstructRemoteState`.
- `src/network/vault-sync-host.ts` — `buildLocalState()` snapshot; wires stores.
- `src/merge/state-merge.ts` — pure `mergeVaultStates(local, remote)` → `MergeAction[]`.
- `src/merge/diff3.ts` — three-way text merge.
- `src/network/sync-applicator.ts` — applies `MergeAction[]` to the real vault; re-emits user resolutions as ops.
- `src/network/cursor-store.ts` — persisted scalar sync cursor.
- `src/network/encryption.ts` — at-rest E2E crypto; hash blinding.
- `src/network/server-http.ts` / `fake-server.ts` — transport (prod / test).

### Invariants the sync path MUST uphold

1. **No fabricated content.** The merge/applicator never writes bytes it did not
   actually obtain (no `new Uint8Array()` stand-ins written to the vault).
2. **No silent overwrite of divergent content.** Two independently-authored
   contents at the same path are a conflict, never a last-one-wins clobber.
3. **No cursor advance past unapplied work.** If a remote op could not be
   applied because its content was unavailable, the cursor must not move past it;
   it must be retried when the content appears.
4. **No silent drop of a local edit.** An edit that reaches disk is either
   captured as an op, preserved on disk, or surfaced as a conflict — never
   overwritten and forgotten.
5. **Monotonic logical time.** Locally-issued HLCs never regress below timestamps
   this device has already issued, even across restarts / wall-clock changes.

**Non-goal — log completeness against a malicious server.** These invariants
guard against *corruption*, not *incompleteness*. A withholding/truncating server
degrades to **staleness** (the client converges to an older state that self-heals
when the ops arrive), never to fabricated or overwritten bytes — content is
content-addressed and re-hashed on fetch, and reorder/replay are absorbed by the
convergent LWW-over-HLC fold. Proving the log is *complete* (a freshness/anti-fork
guarantee) is explicitly out of v1 scope; see `docs/server-api-spec.md` §
"Integrity guarantees vs. log completeness" and `OP_FORMAT_AUDIT.md` finding F.

### Test harness (use the REAL stack, never a reimplementation)

- Pure merge findings (F1, F2, F6): unit-test `mergeVaultStates` directly with
  hand-built `VaultState` maps (see `__tests__/*.test.ts` for patterns).
- Round-trip findings (F3, F4, F5, F7): drive `ServerSyncClient` over
  `TestDevice` (`__tests__/helpers/test-device.ts`) + `FakeSyncServer`. Use
  `seedFile/editFile/deleteFile/renameFile`, `resolveConflict`,
  `device.applied`, `device.entry(id)`, `device.pendingOps`, `device.cursor()`.
  See `__tests__/concurrent-conflict-dataloss.test.ts` (incl. its
  `editWithoutLogging` helper) and `__tests__/server-sync.test.ts`.

---

## 2. Findings & required fixes

Each finding is an independent fix + regression test + commit, applied in the
order listed (§3). Severity reflects data-safety impact.

Legend for "Required behavior": what the code must do after the fix. Keep fixes
**minimal and local**; do not refactor beyond the finding.

---

### F1 — Merge writes an EMPTY file over local content when the winning side's bytes are missing `[CRITICAL]`

**Location:** `src/merge/state-merge.ts:164-169` (the `!localContent || !remoteContent`
branch of `resolveContentConflict`); also the delete-conflict content fallbacks
at `state-merge.ts:105` and `:119` (`?? new Uint8Array()`), and defensively the
applicator restore/write paths (`sync-applicator.ts:129-171`).

**Scenario:** both sides modified a file, but one side's content is absent from
the content store — reachable when `fetchRemoteBlobs` skips an absent blob
(`server-sync.ts:205` `if (!envelope) continue`) or a pushed `update` op's blob
was never uploaded. When the **remote wins by HLC and its blob is missing**,
`content = remoteContent ?? new Uint8Array()` → the applicator overwrites the
user's local file with **zero bytes**. A transient availability issue becomes
permanent local destruction.

**Root cause:** the code fabricates empty content instead of declining to act
when it lacks the bytes it needs.

**Required behavior:**
- In `resolveContentConflict`, when the side that would be written is unavailable,
  return `{ type: 'no_op', fileId }` — keep local bytes untouched, defer. Never
  write fabricated/empty content. (If `localContent` is missing but `local`
  entry is present, also `no_op`: the local file already holds its own bytes.)
- In the one-sided delete branches, if the surviving side's content needed to
  build a `delete_conflict` is unavailable, return `{ type: 'no_op', fileId }`
  rather than a `delete_conflict` carrying empty bytes (`:105`, `:119`).
- Defensive guard in `sync-applicator.ts`: never `files.write` a zero-length
  buffer that originated from a `?? new Uint8Array()` fallback; if a
  `delete_conflict` restore/`write_local` action arrives with empty content that
  the store can't corroborate, skip it (log) rather than truncate the file.
  (State-merge should already prevent this; the guard is defense-in-depth.)

**Regression test:** unit test on `mergeVaultStates` — both sides modified, remote
HLC higher, remote content absent from `remote.contentStore` → assert the action
is `no_op` (NOT a `write_local` with empty content). Add the symmetric
delete-conflict-missing-content case.

**Acceptance:** no code path can emit a `write_local`/restore whose content is a
fabricated empty buffer; the affected file's local bytes are preserved; full
suite green.

**Note:** F1 must land first — F3 (cursor) relies on "unavailable content ⇒
deferred, not lost," and this establishes the `no_op`-on-missing-content rule.

---

### F6 — Missing ancestor bytes turn a clean merge into content DUPLICATION `[MEDIUM]`

**Location:** `src/merge/state-merge.ts:184-207` (ancestor lookup + `threeWayMerge`).

**Scenario:** both sides modified; `ancestorContentHash` is non-null but its bytes
aren't held (GC'd, or never fetched to this device). `ancestorText` falls back to
`''`; `threeWayMerge` then treats both versions as inserts at gap 0 and **unions
them** (`diff3.ts:332-335`), silently concatenating both full file versions.

**Root cause:** an empty-string stand-in for a *known-but-missing* ancestor is not
a valid three-way base.

**Required behavior:** distinguish "no ancestor recorded" (`ancestorHash == null`
— genuinely no common base) from "ancestor recorded but bytes unavailable". For
the latter, do **not** merge against an empty ancestor — surface a `conflict`
(user resolves) so nothing is silently unioned. Leave the `null`-ancestor path
unchanged (out of scope; overlaps F2). Concretely: only fall back to
`ancestorText = ''` when `ancestorHash == null`; when `ancestorHash != null &&
ancestorContent == undefined`, return the `conflict` action.

**Regression test:** unit test — both sides modified, `ancestorContentHash` set on
both, ancestor bytes absent from both stores → assert action is `conflict`, NOT a
`write_local` whose merged content contains both versions concatenated.

**Acceptance:** a known-but-missing ancestor never produces a silent union; full
suite green.

---

### F2 — Create/create PATH COLLISION silently clobbers one side with no conflict `[HIGH]`

**Location:** `src/merge/state-merge.ts:44-68` (the single-sided `write_local` /
`send_remote` branches of `classifyAndResolve`), interacting with
`file-registry.ts:147-163` (`adoptRemote` drops the divergent duplicate).

**Scenario:** two devices independently create a file at the same path → different
UUIDs. The merge is id-keyed, so each device sees the other's file as
"remote-only" → unconditional `write_local` + `adoptRemote`, which overwrites the
local file and deletes the colliding local registry entry. **No conflict raised.**
Whichever device syncs last wins; the other content is silently replaced in the
working copy (recoverable from the server oplog, but never surfaced). Classic
second-populated-vault onboarding hazard.

**Root cause:** "only one side knows this fileId" is treated as "new file, remote
authoritative," without checking whether a *different* live fileId already
occupies that path with *different* content.

**Required behavior:**
- In `mergeVaultStates`, precompute path→fileId lookups for local and remote live
  (non-deleted) entries.
- In the remote-only branch (`!localEntry && remoteEntry`, not deleted): if a
  *different* local live fileId occupies `remoteEntry.path`:
  - identical content (same hash) → treat as the same file / `no_op` (or adopt
    remote id deterministically without a content change);
  - different content → emit a **`conflict`** (three-way with empty/absent
    ancestor since there is no common base) between the two contents, so the user
    chooses and nothing is clobbered. Pick the surviving identity
    **deterministically** (higher HLC; tie-break by lexicographic fileId) so both
    devices converge on the same id. If the remote content needed for the
    conflict is unavailable → `no_op` (defer, per F1/F3).
- Symmetric handling for `localEntry && !remoteEntry` where remote's projection
  holds a different fileId at that path (may be rare since remote is a partial
  projection; handle if reachable, otherwise document why not).
- Ensure the applicator's `conflict` resolution path reconciles identity to the
  chosen id (existing `adoptRemote`/`supersedes` machinery) so the two devices
  converge to ONE fileId for the path.

**Regression test:** round-trip via two `TestDevice`s + `FakeSyncServer`: A and B
each `seedFile('note.md', 'AAA' / 'BBB')` independently, both sync. Assert a
`conflict` is surfaced (not a silent `write_local` clobber), and after the user
resolves, BOTH devices converge to the SAME content and the SAME fileId, with no
original content silently discarded. Also add the identical-content collision
case → converges with no conflict.

**Acceptance:** no create/create path collision resolves by silent overwrite;
both contents are preserved through a conflict; devices converge on one identity;
full suite green.

**Complexity note:** this is the subtlest fix (it reconciles two identities). Keep
the winner-selection deterministic and mirror existing tie-break conventions
(`hlcCompare`, then fileId). If a fully-general symmetric fix balloons, scope to
the demonstrably-reachable remote-only direction and document the deferral.

---

### F3 — Cursor advances past ops whose content was unavailable → file NEVER retried `[MEDIUM]`

**Location:** `src/network/server-sync.ts` — `fetchRemoteBlobs` skip
(`:193-212`), `pullAll` (`:172-185`), and `saveCursor(pulledCursor)` (`:168`).

**Scenario:** a remote op's blob is momentarily absent at pull → skipped by
`fetchRemoteBlobs` → `no_op`'d by the merge (post-F1) → but `saveCursor` advances
past it. When the blob later exists, nothing re-pulls that op; the file is
permanently skipped until a manual cursor rewind (`recheckConflicts`).

**Root cause:** the cursor advances unconditionally to `pulledCursor` regardless
of whether every consumed op was actually applied.

**Required behavior:** do not advance the cursor past any op whose content was
unavailable this round. Preferred implementation: have `pullAll` retain each
`OpRecord`'s `seq` alongside the decrypted op (return `{ seq, op }[]`), track the
set of content hashes that `fetchRemoteBlobs` could not obtain, and when saving
the cursor use `min(pulledCursor, (minSeq of any op referencing a missing hash) - 1)`.
Acceptable simpler fallback if the seq-threading is disproportionate: if ANY
content was missing this round, persist `startCursor` (do not advance) so the
next round re-pulls and retries — safe but re-pulls until the blob appears; if
you take the fallback, `log`/comment the trade-off explicitly.

**Regression test:** round-trip — device A pushes a file but its blob is made
absent on the server at B's pull time (e.g. delete the blob from `FakeSyncServer`,
or intercept `getBlob` to return null once); B syncs → file is NOT applied and
B's cursor does NOT advance past that op; then the blob is restored and B syncs
again → the file now applies. Assert no permanent skip.

**Acceptance:** a temporarily-unavailable remote op is retried and eventually
applied; the cursor never strands it; full suite green.

---

### F4 — Unhandled `StaleCursorError` (409) can WEDGE sync permanently `[MEDIUM]`

**Location:** `src/network/server-sync.ts` `runSync`/`pushPendingOps` (no catch);
`StaleCursorError` defined in `src/network/server-http.ts:27-33`.

**Scenario:** client always appends with `baseCursor = startCursor`; after pulling
new remote ops the server head is beyond that. Against a server enforcing the
spec's optional stale-writer 409 (server-api-spec §9.3), the append 409s → sync
throws → cursor never advances → every retry repeats with the same stale
`startCursor` → sync is stuck until manual reset.

**Root cause:** the error type is defined and imported by the HTTP layer but never
caught by the orchestrator; and it lives in the obsidian-coupled `server-http.ts`,
so `server-sync.ts` (deliberately obsidian-free) cannot import it without a cycle.

**Required behavior:**
- Move `StaleCursorError` to a neutral, obsidian-free location that
  `server-sync.ts` can import (e.g. define it in `server-sync.ts` itself or a new
  `src/network/errors.ts`); have `server-http.ts` import it from there. Do NOT
  make `server-sync.ts` import from `server-http.ts` (that pulls in `obsidian`
  and breaks unit-testability — verify `server-sync` still has no `obsidian`
  import after the change).
- In `pushPendingOps`/`runSync`, catch `StaleCursorError` on append and retry:
  re-pull to refresh the cursor, then re-attempt the append with the refreshed
  `baseCursor`. The append is idempotent by `clientOpId`, so retrying is safe.
  Bound the retries (e.g. 3) and rethrow a clear error if still failing. Ops
  appended by others in the 409 window sit at `seq > pulledCursor` and are
  re-pulled next round (cursor semantics unchanged), so correctness holds.

**Regression test:** unit/round-trip with a `ServerApi` stub whose `appendOps`
throws `StaleCursorError` on the first call (stale baseCursor) and succeeds on the
retry after a refreshed cursor → assert the sync completes, ops land, no throw
escapes. Confirm `server-sync.ts` imports no `obsidian`.

**Acceptance:** a 409 is transparently recovered (bounded); sync never wedges;
`server-sync` stays obsidian-free; full suite green.

---

### F5 — Edit-during-sync TOCTOU can DROP an in-window local edit `[MEDIUM]`

**Location:** `src/main.ts:238-241` (pre-sync `flush`), `vault-sync-host.ts:39-76`
(`buildLocalState` snapshot), `sync-applicator.ts` (apply under paused listeners).

**Scenario:** `flush()` before the round only captures debounced edits that exist
at that instant. An edit made **during** the pull/push network window arms a fresh
debounce timer not covered by that flush, while `buildLocalState` already
snapshotted the pre-edit bytes. If a concurrent remote edit to that same file
produces a `write_local`, `applyMerge` (listeners paused) overwrites the file, and
the still-pending timer then reads the overwritten bytes — its hash-equality guard
(`operation-logger.ts:203`) suppresses the op → the in-window edit is silently
lost.

**Root cause:** the snapshot→network→apply sequence has a write window where a
local edit can be overwritten before it is captured as an op.

**Required behavior (choose the minimal robust option, document it):** before
`applyMerge` executes a destructive action (`write_local`, `move_local`,
`delete_local`) on a file, verify the file's current on-disk hash still equals
what `buildLocalState` recorded for it. If it drifted (the user edited it inside
the window):
- do NOT apply the destructive action to that file this round; and
- ensure the fresh edit is captured (re-flush / re-emit its op) so it syncs next
  round — where it will now be a proper three-way merge / conflict against the
  remote change, not a silent loss.
Implement the drift check where the applicator has access to both the intended
action and the live file (it already reads/writes via `VaultFiles`). Keep local
bytes on any uncertainty. This turns a silent overwrite into a deferred, correctly
-merged (or conflicted) edit.

**Regression test:** reproduce the window — seed+sync a file on A and B; on A,
apply a remote edit while a local edit lands during the round but before apply
(drive via `editWithoutLogging` + manual ordering, mirroring
`concurrent-conflict-dataloss.test.ts`). Assert A's in-window edit is preserved
(on disk and/or as a pending op / surfaced conflict) and NOT silently overwritten.

**Acceptance:** an edit reaching disk during the sync window is never silently
overwritten; it is preserved and re-merged; full suite green.

**Complexity note:** if a fully-general fix is disproportionate, the minimum
acceptable guarantee is the drift check that *declines to overwrite* a file whose
on-disk bytes changed since the snapshot (safe: keeps local, retries). Do not ship
a version that can still silently overwrite.

---

### F7 — HLC not persisted; wall-clock regression can silently SUPERSEDE a newer edit `[LOW]`

**Location:** `src/core/hlc.ts` (`HybridLogicalClock`), `src/main.ts:56`
(constructed with no persisted state).

**Scenario:** the clock resets to `{wallTime:0,counter:0}` on load and adopts
`Date.now()` on first use. If the device wall clock moves backward (NTP
correction, manual change) below a previously-issued op's `wallTime`, subsequent
ops get *lower* HLCs and can lose last-writer-wins to older remote content — a
silent overwrite of the newer local edit.

**Root cause:** logical time is not persisted, so monotonicity is only as good as
the wall clock.

**Required behavior:**
- Persist the current HLC via `MetadataStore` (e.g. `.vault-sync/hlc.json`), and
  on startup seed the clock from `max(persisted, {wallTime: now})` so issued time
  never regresses below what this device already emitted.
- Persist on the existing write points (piggyback on oplog save after each
  `recordOp`, and after `merge`/`setCurrent`) — do not add a disk write per
  `now()` beyond what already happens. A tiny `HlcStore` (load/save) wired in
  `main.ts` mirrors `CursorStore`.
- Keep the wall-clock seam intact (the injected `wallClock` fn) so
  `TestDevice`/tests stay deterministic.

**Regression test:** clock-seam unit test — issue an op at wall=5000, persist,
reconstruct the clock from persisted state with a regressed wall=1000, issue a new
op → assert its HLC is strictly greater than the wall=5000 op (no regression).

**Acceptance:** locally-issued HLCs are monotonic across restart and wall-clock
regressions; deterministic tests unaffected; full suite green.

---

## 3. Execution plan

Fixes are applied **sequentially, one agent + one commit per fix**, in this order
(dependencies first, riskiest-with-most-shared-file grouped to minimize churn):

1. **F1** — never write fabricated/empty content (establishes the
   missing-content → `no_op` rule the later fixes rely on). `state-merge.ts`,
   defensive `sync-applicator.ts`.
2. **F6** — known-but-missing ancestor → conflict, not empty-ancestor union.
   `state-merge.ts`.
3. **F2** — create/create path collision → conflict, converge identity.
   `state-merge.ts`, `file-registry.ts` as needed.
4. **F3** — don't advance cursor past unavailable-content ops. `server-sync.ts`.
5. **F4** — handle `StaleCursorError` (relocate + catch + bounded retry).
   `server-sync.ts`, `server-http.ts`, maybe `errors.ts`.
6. **F5** — edit-during-sync drift guard. `sync-applicator.ts` / `main.ts` /
   `vault-sync-host.ts`.
7. **F7** — persist HLC. `hlc.ts`, `main.ts`, new `HlcStore`.

### Per-fix protocol (every agent MUST follow)

1. Read this spec (esp. the assigned finding) and the cited files.
2. Write the regression test FIRST and confirm it FAILS for the stated reason
   (proves the bug). Prefer the real stack (`TestDevice`/`FakeSyncServer`) for
   round-trip fixes; pure unit tests for `mergeVaultStates`/`hlc`.
3. Implement the minimal, local fix per "Required behavior." Do not refactor
   beyond the finding. Preserve existing comments/conventions and the
   obsidian-free boundaries (`server-sync.ts`, `state-merge.ts`, core/ stay free
   of `obsidian` imports).
4. Run the FULL suite: `npx vitest run`. All tests must pass (the new one now
   green, the existing 100 still green). If a pre-existing test legitimately must
   change because behavior intentionally changed, justify it in the commit body;
   never weaken a test to hide a regression.
5. Typecheck: `npx tsc -noEmit -skipLibCheck` must be clean.
6. Commit ONLY when green, one commit for the one fix.

### Commit convention

- Conventional commit, scoped: e.g.
  `fix(sync): never write empty content when the merge winner's bytes are missing (F1)`.
- Body: the scenario, the root cause, the fix, and the regression test added.
- **Do NOT append any `Co-Authored-By` trailer.**
- One fix per commit; do not bundle findings.

### Stop conditions

- If the regression test cannot be made to fail first (bug not reproduced as
  described), STOP and report — the finding needs re-analysis before a fix.
- If a fix would require changes broader than the finding's scope, STOP and
  report rather than expanding scope silently.
- After each commit, the orchestrator reviews the diff before the next fix
  starts.
