# Vault Sync — Capture Optimization Round Spec

**Status:** Draft / decision-of-record · **Date:** 2026-07-23 · **Owner:** client/perf

The mobile perf baseline (`docs/mobile-perf-baseline-spec.md`) surfaced that the
first-enable/offline-capture path (`OperationLogger.captureOfflineChanges`) was the
worst offender on mobile. The first fix — **registry write batching** (commit
`ddfc600`) — landed and was validated on-device: an 8,388-file first-enable now
*completes* (~126 s, previously never, OOM-bound) with **flat heap (72 MB / 1,940 MB
ceiling)**. This spec defines the **next** round: make capture fast enough to be a
non-event, and remove the cost it imposes on *every* sync.

Companion docs: `docs/mobile-perf-baseline-spec.md` (how we measure — reuse it),
`docs/sync-engineering-guide.md` (the invariants below must not break).

---

## 0. Ground rule: no users, no release yet

**There is no published release and no users.** Therefore, for everything in this spec:

- **Persisted schemas may change freely.** Add required fields to `FileEntry`, change
  the content-store path layout, change the registry on-disk format — **no migration
  code, no `version` gates, no "legacy entry" fallbacks.**
- A developer's existing `.vault-sync/` that predates a change is disposable: the
  recovery is "delete `.vault-sync/` and re-enable" (or **Rebuild sync metadata**), not
  a migration path we maintain.
- Do **not** write compatibility shims "to be safe." They are dead weight we would only
  have to delete later. Design for the clean end-state.

This removes the single biggest source of complexity from each optimization below.

---

## 1. What the on-device run established

From the post-batching device run (8,388-file vault, `perfLog` on):

| Fact | Value | Reading |
|---|---|---|
| capture completes | ~126 s | was: never (OOM). Batching fixed the death-spiral. |
| heap during capture | **flat 72 / 1940 MB** | **not memory-bound anymore** — the residual is I/O. |
| per-file cost, ≤3,500 files | ~3.4 ms/file | acceptable |
| per-file cost, >3,500 files | ~20–36 ms/file (step, then plateau) | a **filesystem** wall, not GC |

Two distinct problems remain:

1. **The residual first-enable step (~3,500 files).** Flat heap ⇒ I/O-bound. The
   suspect is the **single `.vault-sync/content/` directory** crossing a Capacitor/
   Android directory-scaling threshold: capture issues ~3 fs ops/file (`read`,
   `exists`, `write`) and they get ~5× slower once the dir holds a few thousand
   entries. Secondary: the growing registry/oplog atomic rewrites.
2. **Capture runs on EVERY sync.** `SyncCoordinator.sync()` calls
   `captureOfflineChanges()` before each round (`sync-coordinator.ts:113`) to catch
   drift — and it **re-reads + re-SHA-256s all F files every time**
   (`operation-logger.ts`; perf-baseline A1/B1). On this vault that is ~2 min of work
   *per sync*, not just at first enable. **This is the higher-impact problem.**

---

## 2. Goals & non-goals

**Goals**
- A routine sync's capture is **O(touched files)**, not O(F): a sync that changed
  nothing does ~no read/hash work.
- First-enable capture is **linear and flat** (no ~3,500-file step) and comfortably
  completes on a low-end phone.
- Preserve every data-safety invariant (§5). An optimization that risks a *missed
  change* (an edit that never syncs) is held to a higher bar than one that risks
  redundant work.

**Non-goals**
- Steady-state round `memCache` bounding (perf-baseline B6) — a separate follow-up.
- The DAG-walk (B2) and cold-pull (B4) costs — separate.
- Any migration/compat tooling (see §0).

---

## 3. O1 — mtime/size capture gate (primary)

**Problem.** `captureOfflineChanges` reads and hashes every live file every pass to
detect drift, so it is O(F·B) even when nothing changed — and it runs every sync.

**Design.** Gate the read+hash on a cheap stat. Persist, per file, the `mtime` and
`size` observed the last time we hashed it; on capture, if the current `mtime` **and**
`size` match the recorded pair, the file is unchanged — **skip the read, the hash, and
the content-store put entirely.**

- `FileEntry` gains **required** `mtime: number` and `size: number` (no migration, §0).
- The `VaultFiles` port's listing carries stat: `VaultFileRef { path; mtime; size }`.
  Obsidian's `TFile.stat` already provides both, so `list()` fills them for free (no
  extra syscall). The fake carries them in its map.
- Capture loop, for a tracked entry:
  `if (ref.mtime === entry.mtime && ref.size === entry.size) continue;` — the whole
  per-file body (read/hash/put/op) is skipped.
- Whenever content is (re)hashed — capture, and the `create`/`modify` event handlers —
  record the file's current `mtime`/`size` into the entry alongside `contentHash`.
  (Event handlers get it from a `stat` or the event's `TFile`; if that's inconvenient,
  leaving them stale is acceptable — the next capture re-hashes that one file once,
  self-heals the stat, then gates it forever. Decide during implementation; prefer
  recording it in the handlers so there's zero redundant re-hash.)

**Impact.** First enable is unchanged (all files new). **Every subsequent sync's
capture drops from O(F) to O(touched)** — the headline win.

**Safety (§5 — this is the one with a real trade-off).** `mtime + size` is a
*heuristic* for "unchanged": a content change that preserves *both* the size and the
mtime would be missed and never sync. This is acceptable because:
- Every **online** edit is captured by the `modify` **event**, independent of the gate;
  the gate only decides whether to re-hash on a *cold* pass. The miss window is an
  **offline** edit that leaves size identical *and* mtime bit-for-bit unchanged —
  astronomically unlikely, and the exact fast-path heuristic `rsync`, `git`, and
  Obsidian's own sync rely on.
- Escape hatch: **Rebuild sync metadata** (reset) already forces a full re-hash, so a
  user who suspects a missed offline edit has a one-click full rescan.

Document this trade-off in the code where the gate lives.

**Tests.** Drive the real `OperationLogger` over the fakes (perf-baseline harness):
- a stat-unchanged file is **not** read/hashed on a second capture (spy on
  `files.read` / `hashContent` call count → 0 for the unchanged file);
- a file whose `mtime` **or** `size` changed **is** re-hashed and re-opped;
- a routine second capture over F unchanged files does O(1) reads, not O(F).

---

## 4. O2 — content-store directory sharding

**Problem.** All blobs live directly in `.vault-sync/content/`; at a few thousand
entries, Capacitor/Android fs ops on that directory degrade (the ~3,500-file step).

**Design.** Shard by hash prefix, git-style: `content/<hash[0:2]>/<hash>.bin` (256
buckets; add a second level `content/<h0:2>/<h2:4>/…` only if a bucket itself gets huge
— unlikely). No migration (§0): change `ContentStore.contentPath`, update `listHashes`
to walk one directory level, and `gc` accordingly. A dev's existing flat `content/` is
abandoned — wipe `.vault-sync/` or re-baseline.

**Impact.** Keeps every content-dir operation on a directory of ≤ F/256 entries,
removing the single-directory scaling wall behind the first-enable step.

**Tests.** `put`→`get`→`has`→`delete`→`listHashes`→`gc` round-trip across the shard
layout (extend the existing content-store tests). No behavioural change beyond paths.

---

## 5. O3 — append-only registry journal

**Problem.** Batching (`ddfc600`) reduced the registry rewrite from O(F²) to O(F²/N) by
flushing every N ops, but each flush still re-serializes the **whole** registry, so a
large capture is still gently superlinear in bytes written.

**Design.** Give `FileRegistry` the same snapshot-⊕-journal persistence the version-DAG
store already uses (`network/version-dag-store.ts` is the reference): a base snapshot
plus an append-only journal of changed entries; `load()` = snapshot then replay;
periodic compaction rewrites the snapshot once the journal crosses a threshold. Capture
then costs **O(delta)** writes, not O(F²/N). The `suspendSaves()/flush()` batch API from
`ddfc600` is the seam this slots into.

**Impact.** True O(F) first-enable writes; removes the residual byte-growth. Lower
priority than O1/O2 — measure after them and only land it if B5 still shows meaningful
superlinearity on device.

**Tests.** Registry round-trips through snapshot+journal+compaction; a torn trailing
journal line is skipped (mirror the DAG store's corruption tolerance); the existing
registry suite passes unchanged.

---

## 6. O4 — minor wins (opportunistic)

- **Drop the redundant `exists()` before a content write** on a known-fresh batch
  (first enable, all-new): `ContentStore.put` does `exists` then `write`; on an all-new
  pass the `exists` always misses and is pure overhead (one fs op/file). Gate it, or
  write-unconditionally in a batch mode. Small.
- **Bounded concurrency** in the capture loop (process files in chunks with
  `Promise.all`) to hide per-file fs latency. Real win on high-latency mobile fs, but
  it reorders work and touches shared state (registry/oplog/pendingOps) — only with
  care and after O1 (which removes most of the files from the loop anyway).

---

## 7. Invariants that must not break (`sync-engineering-guide.md` §5/§7)

1. **No missed change beyond the documented O1 heuristic.** Online edits are always
   caught by events; the gate only elides *re-hashing on a cold pass*. Nothing else may
   skip a genuinely changed file.
2. **Crash-safety stays.** The checkpoint ordering from `c96d85e` (registry flushed
   before oplog; strand-not-orphan) holds through O1/O3. A gated (skipped) file emits no
   op and mutates nothing, so it cannot strand.
3. **Content addressing is unchanged.** O2 changes only the *path* a hash maps to, never
   the hash or the bytes. `getBlob`/blinded-hash/wire formats are untouched.
4. **The phantom-delete guard stays** (`operation-logger.ts` empty-listing check) — O1
   must not let a stat-gate interact with the delete-detection pass to resurrect the
   empty-listing bug.

---

## 8. Testing & measurement

- **Unit/integration:** the per-optimization tests above, all over the **real stack via
  the fakes** (never a reimplementation).
- **Regression (Layer 1/2):** re-run `npm run bench`; B1 (steady-state round) and B3/B5
  (capture) must improve, nothing else regress. Compare against the committed baseline
  `bench/results/2026-07-23_xs-s-m.json` and the post-capture-fix run.
- **On-device (Layer 3):** rebuild (`npm run build:dev`), redeploy
  (`scripts/deploy-android.sh`), re-run the 8.4k-file first-enable with `perfLog`:
  confirm (a) the ~3,500 step is gone (O2) and (b) a *second* sync's capture is ~instant
  (O1). Record numbers into `docs/perf-baseline-2026-07-23.md`.

---

## 9. Order of work & deliverables

Ranked by impact-per-effort; land and measure each before the next.

- [x] **O1 — mtime/size gate.** *Landed.* `VaultFileStat`/`VaultFileRef` carry stat
      (from `TFile.stat`, no extra syscall); `FileEntry` gains optional, **local-only**
      `mtime`/`size` (optional not required — a *projected remote* entry has no local
      stat, mirroring `lastSyncedPath`/`conflictParents`; §0's "no migration" is about
      not writing migration *code*, and an absent value self-heals in one re-hash). The
      capture loop gates the read+hash on `mtime === && size ===`; on a hash-equal
      miss it self-heals the stat (no op), so a file the applicator rewrote is gated
      after one pass. `FileRegistry.registerFile`/`updateContentHash` take the stat +
      new `recordStat`. The live create-handler leaves the cache absent (bare-path
      event) and self-heals — no watcher/port widening needed. Tests:
      `__tests__/capture-stat-gate.test.ts` (repeat capture ⇒ 0 reads; size-half of the
      gate; self-heal; reload-persistence) — all over the real stack.
      *Measurement:* the O1 win is a **no-op/repeat** capture, which the existing bench
      matrix does not cover (B3/B5 are first-enable = all-new files, B1 is
      `buildLocalState`), so it's proven exactly by the unit tests (`io.reads → 0`).
      Bench confirms **no regression**: B3/B5 reads/hashes/writes/timing unchanged vs
      the post-capture-fix baseline; registryBytes +~1.3% (the two extra serialized
      fields — same O(), tiny constant). NB `buildLocalState`'s own O(F) re-hash (B1)
      is a **separate** path O1 does not touch — a follow-up if a no-op *round* must
      also go O(touched).
- [ ] **O2 — content dir sharding.** `ContentStore` path/list/gc. Tests.
      *(Removes the first-enable step.)*
- [ ] **O3 — registry journal** *(only if B5 still superlinear on device).*
- [ ] **O4 — minor** *(opportunistic).*
- [ ] Re-measure Layer 2 (`npm run bench`) + Layer 3 (device), update the perf baseline.

## 10. Success criteria

Judged against the perf-baseline §6 budgets, on a mid-range phone:

| Operation | Target |
|---|---|
| routine sync capture (nothing changed) | **< 300 ms** (was ~2 min) — the O1 win |
| first-enable capture, per-file cost | **flat** across F (no step) — the O2 win |
| first-enable, 8.4k-file vault | completes well under the OOM-free bound it already meets, faster |

If O1 lands and a no-op sync's capture is still O(F), the gate isn't working — treat as
a correctness bug, not a tuning miss.
