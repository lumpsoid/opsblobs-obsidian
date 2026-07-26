# Sync status modal — redesign spec

**Status:** proposed, not yet implemented · **Date:** 2026-07-26 · **Owner:** UX + client ·
**Related:** `docs/pre-release-ux-audit-spec.md` (§0 UX surface table, §5 status/feedback
findings, §3 conflict unification); `docs/sync-engineering-guide.md` (architecture — read
before touching sync core).

## Problem

`src/ui/sync-status-modal.ts` has grown into six conceptually different things stacked in one
linear scroll, and the reader has to do the triage the UI should be doing:

1. **Live, ticking state** — first-enable indexing progress, in-flight sync-round activity
   (`renderLive`, `:191-249`).
2. **Historical summary** — last sync's pushed/pulled/conflict counts (`:88-98`).
3. **Actionable-but-duplicated state** — delete/binary conflicts (`:109-134`). This fully
   re-lists each conflict (path, kind, relative time) even though `src/ui/conflicts-view.ts`
   already renders every conflict in full, with its resolution controls, as a dedicated
   main-area tab. The modal's list is pure duplication of a surface that already exists.
4. **Self-resolving, non-actionable state** — deferred/drift files (`:136-145`) and stranded
   content (`:147-159`). Both retry automatically; nothing the user does changes them.
5. **An error that can go stale forever** — `lastError` (`:161-165`) is rendered read-only.
   Per `src/network/sync-state-store.ts:184-194`, it is only ever cleared in one place —
   `sync-coordinator.ts:123`, on the *next successful sync round*. There is no dismiss
   affordance and no TTL. If a user fixes the underlying problem but doesn't (or can't yet)
   trigger a sync that succeeds, the error banner sits there indefinitely, including across
   restarts (`sync-state-store.ts:127` rehydrates it from disk).
6. **Static config** — server URL, vault key fingerprint, device name (`:167-180`). This never
   changes tick-to-tick; it's configuration, not status.

None of this is wrong information — it's the wrong *grouping*. The fix is to separate by
**actionability**, not by chronology, and to stop duplicating the Conflicts panel.

## Decisions of record

**2026-07-26:**

1. **Connection info (server/fingerprint/device) is dropped from the modal entirely** — moves
   to `settings-tab.ts` only. No compact fallback line kept in the modal.
2. **`PendingChangesView` uses a flat sorted list for v1** (no folder grouping), but each row is
   **color-coded by change type** (create/update/delete/move) rather than a bare path string.
3. **Deferred is count-only in the modal**, folded into the "Waiting to sync" summary line
   exactly like stranded — full detail (path list) lives only in `PendingChangesView`.

## Existing precedent to reuse

The plugin already has a pattern for "this needs a full listing/interaction surface, not a
paragraph in a modal": both `ConflictsView` (`src/ui/conflicts-view.ts:48`) and `PerfLogView`
(`src/ui/perf-log-view.ts:34`) are `ItemView`s opened as a **main-area tab**
(`workspace.getLeaf('tab')`, chosen deliberately for mobile — see the pre-release audit's
decision of record, §3). There is **no in-modal tab-switcher anywhere in the plugin** — the
only "tabs" are whole separate workspace views. A redesign that wants a browsable list should
follow that precedent (a new `ItemView`), not invent a new in-modal tab widget.

## Redesign

### 1. `SyncStatusModal` — slimmed to a live "what's happening / what needs me" glance

Keeps the getter-closure live-polling pattern (`getIndexingProgress`/`getSyncActivity`/
`getUploadProgress` read on the existing 2s timer) — nothing about the live section changes.

Sections, top to bottom:

1. **Live section** (indexing bar / sync-activity bar) — unchanged.
2. **Last error, with a Dismiss action** — see below. Stays near the top since it's the one
   thing that can mean "something is currently broken."
3. **Needs your attention** — collapses to one line: `N conflict(s) waiting` +
   the existing "Open Conflicts panel" button. **Drop the per-conflict list** (`:118-124`) —
   `ConflictsView` already owns rendering each conflict.
4. **Waiting to sync** — one line combining the three "not yet fully synced" states as counts,
   e.g. `12 pending · 2 deferred · 1 waiting on content`, plus a "View details" button that
   opens the new `PendingChangesView` (below). Drop the individual path lists (`pathList` at
   `:251-257`) and the explanatory paragraphs (`:140-144`, `:154-158`) from the modal — they
   move to the new view, next to the data they explain.
5. **Last sync** one-liner — unchanged (`:88-98`).
6. **Connection info** — **dropped from the modal entirely** (decided — see Decisions of
   record). `serverUrl`, `fingerprint`, `deviceId`, `deviceName` (`:33-37`, rendered `:167-180`)
   move to `settings-tab.ts`, which already owns configuring these values — the modal shouldn't
   re-render config it doesn't let you act on.

New/changed `SyncStatusSnapshot` fields:

```ts
export interface SyncStatusSnapshot {
  // serverUrl / fingerprint / deviceId / deviceName REMOVED — settings-tab.ts only
  conflictCount: number;           // replaces rendering `state.conflicts` in full
  waitingCounts: { pending: number; deferred: number; stranded: number };
  onOpenConflicts: () => void;     // unchanged
  onOpenPendingChanges: () => void; // new — opens PendingChangesView
  onDismissError: () => void;      // new — calls syncState.clearError()
  // getIndexingProgress / getSyncActivity / getUploadProgress unchanged
}
```

### 2. `lastError` — add a Dismiss action

The store already has `clearError()` (`sync-state-store.ts:189-194`); it's just never wired to
the UI. Fix:

- Render the existing relative-time + message, plus a **"Dismiss"** button.
- Click → call `onDismissError()` (bound in `main.ts` to `this.syncState.clearError()`) and
  remove the section from the DOM immediately (no need to close/reopen the modal).
- Dismissing doesn't fix the underlying cause. If the same failure recurs on the next sync
  (auto or manual "Sync now"), `setError` fires again and the section reappears — that's
  correct, not a regression to guard against.
- No separate "Retry" button in the modal — the existing "Sync now" button already does that;
  duplicating it here would be another instance of the same "don't re-render what another
  surface already owns" problem this redesign is fixing.

### 3. New: `PendingChangesView` (`ItemView`, main-area tab)

Mirrors `ConflictsView`/`PerfLogView`: `src/ui/pending-changes-view.ts`, activated via a new
`activatePendingChangesView()` in `main.ts` (same shape as `activateConflictsView`,
`main.ts:1010-1018`).

Three sub-sections (decided — flat list, not folder-grouped, for v1):

- **Pending** — local edits not yet pushed. Flat list, sorted (path order), one row per file,
  **color-coded by the op's `OperationType`** (`create` | `update` | `delete` | `move` —
  `src/types.ts:61`) instead of a plain string, so scanning the list tells you *what kind* of
  change is queued without reading each path. Per the plugin's no-emoji decision (pre-release
  audit §5/"no emoji, use color"), the type is a color class + short word label (e.g. "New" /
  "Edited" / "Deleted" / "Moved"), not an icon or glyph.
  **New plumbing needed:** today's `pendingPaths: string[]` (`main.ts:1044`,
  `opLogger.getPendingOps().map(op => op.path)`) drops the `type`. Replace with
  `pendingOps: { path: string; type: OperationType }[]` — `getPendingOps()`
  (`operation-logger.ts:745-747`) already returns the full `Operation` (`types.ts:68-84`), so
  this is a one-line change to what gets mapped through, not new data. The 50-item cap and
  truncation notice (`sync-status-modal.ts:253-256`) are dropped — this view scrolls.
- **Deferred** — count-only in the modal's "Waiting to sync" line (decided — same treatment as
  stranded, not shown inline). Full detail — path list + the existing "changed on disk while a
  sync was in flight… retries automatically" copy (`:141`) — lives only in this view.
- **Stranded** — `state.stranded`: count + the existing "waiting on content… retries
  automatically" copy (`:155-156`). Stays count-only — items are identified only by content
  hash, nothing meaningful to list per-item.

## Out of scope

No change to sync engine behavior, conflict resolution logic, or the `ConflictsView` itself —
this is presentation-only, scoped to `sync-status-modal.ts` plus one new view. Governed
alongside (not instead of) `docs/sync-engineering-guide.md`.
