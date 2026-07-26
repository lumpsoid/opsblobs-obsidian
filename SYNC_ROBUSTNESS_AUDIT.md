# Sync Robustness & UX Audit

Status: **S1–S5 all remediated** (see per-finding markers below and the summary
table). Performed 2026-07-21, before the v2 DAG migration (Steps 5–8, sync-v2-migration-spec.md)
and the P0–P2 UX remediation pass (docs/pre-release-ux-audit-spec.md, 2026-07-22 to
07-26) — that unrelated work closed every finding here as a side effect (derived
conflict state, the unified non-blocking Conflicts panel, and explicit S1/S3/S4-labeled
fixes in `sync-coordinator.ts`). Retained for historical context; treat as closed, not
a live punch-list.

Scope: the live client↔server sync path of the Obsidian plugin — capture
(`OperationLogger`), the round (`ServerSyncClient` / `PluginVaultSyncHost` /
`SyncApplicator`), and everything the user sees (`main.ts` ribbon/status, settings,
conflict modals). Companion to `OP_FORMAT_AUDIT.md` (which covers the op wire format).

The merge core (state-merge, ancestor policy, HLC, F1–F7 fixes) is solid and
well-tested. The gaps below are all at the **edges**: getting a just-made edit
*into* an op, and getting the *state of the system* back *out* to the user. Those
two edges are exactly where the user reported pain.

Severity: **S1 highest**. Each finding lists the concrete failure, the root cause
with `file:line`, and a remediation.

---

## S1 — Edit-then-immediately-sync silently fails to push the edit  ⟶ data not propagated ✅ REMEDIATED

**Fixed:** `sync-coordinator.ts:110-113` — every round now runs `editorSaver.saveOpenEditors()` →
`opLogger.flush()` → `opLogger.captureOfflineChanges()` before building local state, explicitly
labeled "S1:" in the comment.

**This is the "I change, save, sync fast and it doesn't take the change; wait a bit,
sync again, now it takes it" bug.** Reproduces reliably. The edit is not lost
*locally*, but it is **silently not sent to the server** on the sync the user pressed.

### Why
Pushing an edit requires it to exist as a **pending op**. Op creation is driven
entirely by Obsidian's async `modify` vault event → a debounce timer
(`operation-logger.ts:192-205`). `triggerSync` tries to close the window by calling
`opLogger.flush()` first (`main.ts:261`), but `flush()` only drains timers that are
**already armed** (`operation-logger.ts:152-160`):

```
async flush() {
  const paths = [...this.debounceTimers.keys()];   // ← empty if modify hasn't fired yet
  ...
}
```

Two ways the timer isn't armed yet at sync time:

1. **Editor buffer not flushed to disk.** Obsidian holds editor changes in memory and
   writes to disk on an idle delay. If the user types and clicks sync immediately, no
   `modify` event has fired, *and the new bytes aren't even on disk yet*. `flush()`
   no-ops; `buildLocalState` reads the **stale** disk bytes (`vault-sync-host.ts:47`).
2. **Event latency.** Even once bytes are on disk, the `modify` event is dispatched
   asynchronously. If it lands after `flush()` runs, no timer existed to drain.

In case 2, `buildLocalState` *does* read the fresh bytes and corrects the snapshot
hash (`vault-sync-host.ts:52-57`) — but that only fixes the in-memory `VaultState`.
**It never creates a pending op.** `pushPendingOps` pushes `local.pendingOps` only
(`server-sync.ts:266`); a `send_remote` merge action is explicitly a no-op in the
applicator (`sync-applicator.ts:248-252`). So the corrected content is never uploaded.

Net: the edit ships only once a real `modify` event eventually mints an op, i.e. on a
*later* sync — precisely the reported symptom.

### Remediation
Make "capture everything on disk" a precondition of every sync, not a best-effort
timer drain. At the top of `triggerSync`, before `buildLocalState`:

1. **Force the active editor to persist.** Obsidian doesn't expose a clean public
   "save now", but the plugin can drain the modify latency by re-reading each open
   file's editor content, or by awaiting a microtask after triggering a save. At
   minimum, document that unsaved editor buffers are not synced.
2. **Run a drift-capture pass** — the logic already exists in
   `captureOfflineChanges` (`operation-logger.ts:71-123`), which re-hashes live files
   against the registry and **emits ops for drift**. Call it (or a lighter
   `captureDrift()` extraction) at sync start. This is the actual fix: any file whose
   disk hash ≠ registry hash becomes a pending op and is pushed, regardless of whether
   its `modify` event has fired. `flush()` becomes a redundant optimization.

Add a test mirroring `edit-during-sync-dataloss.test.ts` but for the
*edit-just-before-sync* (pre-round) window, which is currently uncovered.

---

## S2 — The system's real state is invisible: skips, deferrals, and stalls never surface ✅ REMEDIATED

**Fixed:** superseded by the v2 DAG migration's derived-conflict model (Steps 6–7) and the sync
status modal redesign (`162191a`). "Conflicts" are no longer a hand-maintained set — they're
derived from the registry's two-headed files plus the round's `deferredConflicts`, surfaced in a
persistent Conflicts panel (not a transient Notice) with a live ribbon/status-bar indicator, and a
skip can no longer silently drop a remote op (there is no more skip path — see S5).

The user asked for "an easy place to overview the current state — what's been missed,
what a skip left outstanding." Today there is none, and several states are not just
un-surfaced but **actively swallowed**.

### 2a — A skipped conflict is silent *and* sticky
"Skip for now" resolves `null` (`conflict-modal.ts:83-86`); the applicator drops it
(`sync-applicator.ts:175-176`, `if (!resolved) return null`). Nothing is recorded.
Worse, the cursor still advances past that remote op — `safeCursor` holds back only
for missing content (F3) and disk drift (F5), **never for a skip**
(`server-sync.ts:341-358`). So the remote op is consumed; a *normal* sync will never
re-present it. The two devices stay divergent **invisibly and indefinitely**. The only
recovery is the "Re-check for conflicts" button (rewinds cursor to 0,
`main.ts:360-363`) — which the user has to know to press, with no signal that anything
is outstanding. Dismissing the modal with Escape hits the same silent-skip path
(`conflict-modal.ts:89-93`).

### 2b — The "conflict" indicator is dead code
`pendingConflicts` is declared and never assigned (`main.ts:47` — sole occurrence).
`updateRibbonState('conflict')` is never called anywhere. The ribbon's amber
"conflicts need resolution" state (`main.ts:375`) is unreachable. So even an
*actively raised* conflict leaves no persistent indicator once the modal closes.

### 2c — Deferred (F5) and stranded (F3) files aren't shown
When a destructive action is deferred for on-disk drift, or an op is held back because
its blob couldn't be fetched, the code does the correct *mechanical* thing (cursor
hold, recapture) but only `console.warn`s (`sync-applicator.ts:123,148,165`). The user
has no way to know a file is in a "will retry next round" limbo.

### 2d — Status is a transient Notice, not an inspectable surface
`showSyncStatus` is an 8-second `Notice` (`main.ts:394-405`); the status bar shows only
a pending count or relative last-sync time (`main.ts:381-392`). There is no
per-file state, no error history, no skip queue, no last-error detail.

### Remediation
Introduce a small **persisted sync-state model** (alongside the oplog) tracking, per
file where relevant: `outstanding-conflict` (skipped/dismissed), `deferred-drift`,
`content-stranded`, and `last-error`. Then:
- Drive `updateRibbonState('conflict')` from a non-zero outstanding count (wire up the
  dead `pendingConflicts`, or replace it with the model's count).
- Replace the `showSyncStatus` Notice with a **dedicated status view/modal**: last sync
  result, pending-op list, outstanding conflicts (with a "resolve now" affordance that
  re-pulls just those), deferred/stranded files, and the last error.
- Record a skip in the model instead of dropping it, so it's listed and re-openable
  without a full history rewind.

---

## S3 — "Reset sync state" silently drops un-pushed local changes ✅ REMEDIATED

**Fixed:** `sync-coordinator.ts` `reset(confirm)` — confirms first when un-synced ops exist, then
reconciles the registry and re-captures every on-disk file as ops instead of `clearOps`. Explicitly
labeled "S3:" in the doc comment.

`resetSyncState` (`main.ts:346-350`) calls `reconcileWithVault` then **`clearOps()`**.
`clearOps` throws away the pending oplog (`operation-logger.ts:276-279`) **without
pushing it first**, and `reconcileWithVault` records new files with a `''` placeholder
hash (`file-registry.ts:195`) and emits nothing. No `captureOfflineChanges` runs
afterward, so ops are only re-derived on the *next plugin reload*.

Consequence: any edit captured but not yet synced is dropped from the sync log by a
button whose description says "Vault content is never touched" — true for the *files*,
but the user's **un-synced changes to the server are silently discarded**. For a tool
whose headline promise is "critical data is never silently dropped," this is the
sharpest edge in the plugin.

### Remediation
Either (a) refuse to reset while `getPendingOps().length > 0` without an explicit
"discard N unsynced changes?" confirmation, or (b) fold a `captureOfflineChanges()`
call into the reset so the rebuilt registry re-emits ops for everything on disk instead
of clearing them. (b) is safer and dovetails with S4.

---

## S4 — No "rebuild from a known-good client and force-push to the server" ✅ REMEDIATED

**Fixed:** `sync-coordinator.ts` `rebaseline(confirm, runManualSync)` — after an explicit confirm,
emits an op for every live file via `captureAllAsBaseline()` then runs a normal sync round. Explicitly
labeled "S4:" in the doc comment; exposed in the UI as the "Re-baseline this device to the server"
danger-zone action with a type-to-confirm gate.

Explicitly requested, and genuinely absent. The user wants: *"this client is the
source of truth — re-derive the whole sync state and push it up."* Today:
- `resetSyncState` is **local-only and lossy** (S3).
- `recheckConflicts` rewinds the *pull* cursor (`main.ts:360-363`) — it re-pulls, it
  does not force-push local content as authoritative.
- There is no operation that re-emits a full set of `create` ops for every live file
  and pushes them as the new baseline.

### Remediation
Add a **"Re-baseline this device to the server"** maintenance action:
1. `captureOfflineChanges`-style full scan that emits an op per live file (create for
   untracked, update for drift) — never clearing without capturing.
2. Run a normal sync round so blobs + ops upload idempotently (`clientOpId` already
   makes re-append safe, `server-sync.ts:290-313`).
3. Guard it behind a clear confirmation about what "this device wins" means for
   concurrent edits on other devices, and surface the result in the S2 status view.

This gives a non-destructive recovery path when a user believes the server (or another
device) has drifted, without the current footgun of dropping the oplog.

---

## S5 — Auto-sync can pop a blocking, unattended conflict modal ✅ REMEDIATED

**Fixed:** superseded by the "full inline" conflicts decision (pre-release-ux-audit-spec.md §3,
2026-07-23) — `DeleteConflictModal`/`BinaryConflictModal`/`ConflictResolutionModal` were deleted
entirely. Delete/binary conflicts now always defer into the Conflicts panel on every round (manual
or auto); there is no blocking modal of any kind left to pop, and no Escape-to-silent-skip path.

Auto-sync fires `triggerSync('auto')` on a timer (`main.ts:324-327`), which runs the
full round including `onConflict` → a modal (`main.ts:93-104`). A background sync can
therefore interrupt the user with a modal they didn't initiate; dismissing it Escapes
into the silent-skip path (S2a). For a *conflict* (not a clean merge), unattended
resolution is dangerous.

### Remediation
In `'auto'` mode, don't open modals: detect conflicts, **defer them** into the S2
outstanding-conflict model, hold the cursor for them, and set the ribbon to the
conflict state. Resolve interactively only on a manual sync or from the status view.

---

## Summary table

| # | Severity | Finding | Anchor | Status |
|---|----------|---------|--------|--------|
| S1 | High | Edit made just before sync isn't pushed (flush only drains armed timers; no op minted for drift) | `operation-logger.ts:152`, `main.ts:261`, `vault-sync-host.ts:52` | ✅ Remediated |
| S2 | High | Skips/deferrals/stalls invisible; skip is sticky (cursor advances); conflict indicator is dead code | `conflict-modal.ts:83`, `server-sync.ts:341`, `main.ts:47` | ✅ Remediated |
| S3 | High | "Reset sync state" drops un-pushed pending ops without pushing | `main.ts:346`, `operation-logger.ts:276` | ✅ Remediated |
| S4 | Medium | No non-destructive "rebuild & force-push to server" | `main.ts:346-363` | ✅ Remediated |
| S5 | Medium | Auto-sync can open blocking conflict modals; Escape = silent skip | `main.ts:324`, `main.ts:93` | ✅ Remediated |

### Recommended order (historical — all items shipped; kept for context)
1. **S1** — stops the reported silent non-propagation. Small, localized (reuse
   `captureOfflineChanges` at sync start).
2. **S2** — the persisted sync-state model + status view. Unlocks S4/S5 and answers the
   "overview the current state" ask directly.
3. **S3** — quick guard, high safety payoff.
4. **S4 / S5** — build on the S2 model.
