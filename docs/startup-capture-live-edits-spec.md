# Vault Sync — Startup-Capture Live-Edit Handling Spec

**Status:** Implemented (`OperationLogger.captureOfflineChangesAndReconcile`, `src/core/operation-logger.ts`;
wired in `main.ts`'s `captureOfflineWithPerf`). **Date:** 2026-07-25. **Owner:** client/UX.

**One sentence:** during the first-enable / startup `captureOfflineChanges` scan (which can run
for minutes on a large mobile vault), don't hook the live vault listener into the same
registry/oplog writer the scan already owns — track touched paths in a disposable RAM set instead,
and reconcile by re-running the (already idempotent) capture pass until it goes quiet, before
handing off to normal listening.

This document is written to be picked up **cold**, with no prior conversation context.

**Companions:** `docs/startup-capture-optimization-spec.md` (the scan this spec wraps),
`docs/capture-concurrency-spec.md` (a *different* concurrency question — parallel I/O within the
scan, reverted; establishes the "single serial writer" invariant this spec also leans on),
`docs/sync-engineering-guide.md` §5 (invariants), §7 (capture gotchas). Trigger: `513844a`
(`fix(sync): guard Sync now against the startup offline-changes scan`), which patched the
symptom (a UI race) but not the underlying question this spec answers (what happens to a vault
*edit* during that window).

---

## 1. Context — the blind window

`src/main.ts` (`onLayoutReady`) runs, in order:

```
1. this.captureOfflineWithPerf()        // wraps opLogger.captureOfflineChanges()
2. this.opLogger.startListening()       // only now does the vault watcher attach
```

`captureOfflineChanges` (`src/core/operation-logger.ts:184`) diffs the live vault against the
registry and emits `create`/`update`/`delete` ops for anything that changed while nothing was
listening — first and foremost, files that already existed before the plugin's listeners ever
attached (no `create` event fires for those). On a large mobile vault this pass is documented to
run for **minutes** (`CaptureStats`, progress callback every `CAPTURE_PROGRESS_EVERY` files).

Obsidian gives no way to block the user from editing while this runs, and nothing here should try
to. So: **what happens to an edit the user makes during those minutes, before
`startListening()` ever attaches?**

### 1.1 What already works

Today, nothing observes that edit *as an event* — the watcher isn't attached yet. But no data is
lost:

- If the scan hasn't visited that file yet, it reads current bytes when it gets there — the edit
  is captured as part of the normal pass, no special-casing needed.
- If the scan already visited that file before the edit landed, the edit is invisible to *this*
  pass — but `captureOfflineChanges` runs again before every sync round
  (`sync-coordinator.ts:113`, `sync()` step 1), and it is explicitly idempotent (a file whose
  current content already matches its registry entry produces nothing — see the docstring at
  `operation-logger.ts:153`). The very next sync round's pre-round capture picks the edit up.
- If the app is killed/backgrounded mid-scan, the next launch just reruns
  `captureOfflineChanges` from scratch against on-disk state — nothing about the interrupted pass
  is trusted, so nothing is lost. This is the same property the mid-capture cancellation path
  already relies on (`captureOfflineChanges`'s `signal` handling, `operation-logger.ts:240-254`).

So: **correctness is not at risk today.** What's missing is *visibility latency* — an edit made
during the startup window doesn't show up as a pending op, doesn't fire `onChange`
(`operation-logger.ts:126`), and won't sync until whatever next triggers a round. On a vault that
takes several minutes to first-capture, "the note I just wrote 30 seconds ago shows 0 pending
changes" is a bad first impression, and if auto-sync's interval is long or the device goes
offline before any round fires, that edit can sit unsynced-but-unlabelled for a while.

### 1.2 Why you can't just attach the real listener during the scan

The obvious fix — call `opLogger.startListening()` *before* the scan instead of after — routes
live edits into `handleCreate` / `handleModify` / `handleDelete` / `handleRename`
(`operation-logger.ts:520-664`), which mutate the same registry entries, the same `pendingOps`
array, and issue HLC timestamps, **concurrently** with the scan's own mutations of that state.

The scan is built as a **single-writer batch**: `registry.suspendSaves()` defers registry
persistence to per-checkpoint flushes (`operation-logger.ts:204`), and each file's
read→hash→put→register→setHeadVersion sequence spans multiple `await`s during which the scan
holds a *snapshot* of that file's registry entry (`wasPlaceholder`, `parentVersion`, `existed`) it
captured before mutating it. `capture-concurrency-spec.md` §4 spells out exactly why every mutation
of this shared state has to stay in one serial consumer, even for a same-purpose concurrent
*read* pipeline (C1) — and that spec's concurrent stage still only ever *read* the registry, never
wrote it.

A live handler firing mid-scan is a second, independent writer. Concretely: capture reads file A's
pre-edit bytes at t0 and awaits hashing/storing; the user edits A; the (debounced) live
`flushModify(A)` reads the *new* bytes, updates the registry entry, emits an `update` op, and
advances `headVersionId` — all before capture's own delayed write for A lands. Capture then
overwrites the registry with its **stale** t0 snapshot and calls
`setHeadVersion(entry.id, <capture's op id>)`, silently rewinding the head pointer past the live
edit's op. Two ops now exist for one edit, and the live edit's op is stranded (never referenced as
head) — a real DAG-corruption hazard, not just duplicate work. This is the "same handler" option
from the prompt, and it's rejected for this reason.

---

## 2. Design — dirty-path buffer + bounded reconcile, then handoff

Don't give the live watcher write access to the registry/oplog while the scan owns it. Instead,
attach a **separate, trivial handler** for the duration of the scan that does no I/O and touches
no shared mutable sync state — just a `Set<string>` of paths:

```ts
const dirty = new Set<string>();
this.watcher.start({
  onCreate: p => dirty.add(p),
  onModify: p => dirty.add(p),
  onDelete: p => dirty.add(p),
  onRename: (p, old) => { dirty.add(p); dirty.add(old); },
});
```

This is synchronous and allocation-only — it cannot race the scan's `await`-interleaved registry
mutations, because it never reaches the registry, the content store, the oplog, or the HLC. It's
the RAM buffer the prompt asks about, but it stores **paths only**, never content or hashes: any
content/hash snapshotted now could be stale by the time it's used, so the reconcile step below
always re-reads current disk state rather than trusting anything buffered here.

### 2.1 The reconcile loop

```
attach dirty-tracker
await captureOfflineChanges()          // the main pass, as today
for i in 1..MAX_RECONCILE_PASSES:
  if dirty.isEmpty(): break
  const toRecheck = dirty; dirty = new Set()   // swap before rescanning, so edits
                                                 // landing *during* the rescan aren't lost
  await captureOfflineChanges()          // idempotent full pass — see §2.2
detach dirty-tracker
opLogger.startListening()               // real handoff, as today
```

Each reconcile pass is just another call to the *same* `captureOfflineChanges` — there is no
separate "merge buffered ops into the DAG" algorithm to build. Diffing live-vs-registry and
appending `create`/`update`/`delete` ops with `parentVersion` = current head **is** the merge; a
path discovered via the dirty-set gets exactly the same treatment as one discovered by the scan's
own listing, because it's the same code path. This directly answers the prompt's "append this
logs or merge then into the current dag" — there's nothing extra to append; re-running the
existing idempotent pass already does it correctly.

`MAX_RECONCILE_PASSES` bounds worst case latency for a pathological "vault is being rewritten
continuously" scenario (e.g. another sync client racing writes into this vault) — after the cap,
stop looping and hand off to normal listening anyway. Any remaining drift is not a correctness
gap: it surfaces on the very next sync round's pre-round capture, exactly as it does today for the
single-pass case (§1.1). A small constant (2–3) is enough; tune later, not a design blocker.

### 2.2 Why a full re-scan, not a path-scoped one

`captureOfflineChanges` already has an O1 stat gate (`operation-logger.ts:263-276`) that skips the
read+hash for any file whose `mtime`/`size` haven't drifted since the registry's last record — so
a reconcile pass over an otherwise-untouched multi-thousand-file vault is cheap (stat-only) except
for the handful of paths actually in `dirty`. A full re-scan also gets the phantom-delete guard's
existing correctness for free (`operation-logger.ts:346-384`) — it needs a **complete** on-disk
listing to safely detect deletes; a path-scoped pass restricted to `dirty` would have to skip or
reinvent that guard. Reuse over reinvention: don't build a targeted variant unless the on-device
measurement in §5 shows the O1-gated full rescan is too slow.

### 2.3 App closed / backgrounded mid-reconcile

Nothing new needed. `dirty` is memory-only, and losing it is always safe: the next launch's
startup scan re-diffs live vault against the on-disk registry from scratch, the same as it does
after a cancelled first pass today. The dirty-set is purely an optimization to shrink the
visibility window — never a source of truth, so it needs no persistence, no journal, no recovery
path.

### 2.4 UI during the window

`513844a` added `startupCaptureInProgress` (`main.ts:89-96`) so `isSyncing()` and the guarded
"Sync now" click cover the startup scan. That flag must wrap the **whole** reconcile loop
(§2.1), not just the first pass — otherwise a manual "Sync now" click landing between reconcile
passes would race the still-running capture the same way `513844a` fixed for the single-pass
case. No other UI change is required: the existing pending-op count / `onChange` notification
already only reflects what's durable in `pendingOps`, and a reconciled edit becomes visible the
moment its pass's checkpoint flushes, same as any other capture-emitted op.

---

## 3. Invariants preserved

- **Single writer over registry/oplog during any one capture pass.** The dirty-tracker never
  writes; only `captureOfflineChanges` itself does, one pass at a time, sequentially (no two
  passes run concurrently — each `await`s the previous to finish before checking `dirty` again).
- **Phantom-delete guard stays intact** (§2.2) — every reconcile pass is a full, complete listing,
  never a partial one.
- **Idempotence** — a reconcile pass over a path the main pass already captured correctly, and
  whose content hasn't changed again since, produces nothing (registry hash already matches).
- **No new persistence format** — `dirty` is transient; nothing added to `.vault-sync/`.
- **Bounded latency** — `MAX_RECONCILE_PASSES` caps worst case; uncaptured remainder always
  self-heals on the next sync round (§1.1), never silently lost.

---

## 4. Alternative considered and rejected

**Hook the real listener (`handleCreate`/`handleModify`/`handleDelete`/`handleRename`) during the
scan, buffering emitted ops in RAM until the scan finishes, then append.** Rejected: this still
requires those handlers to touch the registry (`registerFile`, `updateContentHash`,
`setHeadVersion`) to compute correct hashes/parents *at the time the edit is observed* — which is
exactly the concurrent-writer race in §1.2. Buffering the *ops* (not just paths) doesn't fix this,
because a correct op needs a `parentVersion` read from the registry at emit time, and the registry
is being concurrently rewritten by the scan. The dirty-path design in §2 sidesteps this entirely by
never computing anything during the window — only *after* the scan pass currently in flight
finishes, when the registry is quiescent again.

---

## 5. Implementation notes (resolving the open questions above)

- **`MAX_RECONCILE_PASSES` value: 1, not 2–3.** The reconcile pass is a full rescan, but the O1
  stat gate (§2.2) makes it cheap — only touched paths actually get read+hashed, everything else
  is a stat comparison. The *marginal* cost of a second/third pass is therefore small, but so is
  the marginal benefit: catching one edit made during the main pass in one extra pass covers the
  overwhelmingly common case, and any edit a bounded number of passes fails to catch isn't lost —
  it self-heals on the very next sync round's pre-round capture (§1.1), the same safety net the
  single-pass version already relied on. Chasing full convergence with more passes mostly just
  raises the worst case for a vault under continuous concurrent writes (another sync client racing
  this one) without a correctness payoff. `MAX_RECONCILE_PASSES = 1` in `operation-logger.ts` (a
  `maxReconcilePasses` param on `captureOfflineChangesAndReconcile` for tests/tuning).
- **On-device timing of the reconcile loop** — not yet measured on a real large mobile vault
  (open); the O1-gate cost model (`capture-stat-gate.test.ts`) predicts it's cheap, but this is a
  prediction, not a device measurement. Revisit the path-scoped variant only if that measurement
  says otherwise.
- **Dirty-tracker during the cancellation path** — confirmed out of scope, unchanged from the
  design: `captureOfflineChangesAndReconcile`'s reconcile loop checks `signal?.aborted` and stops
  (no wasted reconcile pass after an abort), and the dirty-tracker itself never touches the abort
  signal at all — verified by the "does not interact with the abort/signal path" test below.
- **Testing** — `__tests__/startup-capture-reconcile.test.ts`, driven through `TestDevice` per
  `[[vault-ports-and-testing]]`: (a) an edit landing after the main pass has already visited that
  file is picked up by exactly one reconcile-pass `update` (on top of the main pass's own `create`
  — not a duplicate), (b) the registry head reflects the latest content, (c) a pathological
  always-dirty fake still terminates at exactly `maxReconcilePasses` reconcile passes, (d) the
  dirty-tracker detaches cleanly so `startListening()` works normally afterward, and (e) an abort
  mid-main-pass stops the sequence with zero reconcile passes (matching
  `capture-cancellation.test.ts`'s existing exact-count pins, still green/unmodified).
