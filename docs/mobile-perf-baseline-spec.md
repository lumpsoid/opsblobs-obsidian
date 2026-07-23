# Vault Sync — Mobile Performance Baseline Spec

**Status:** Draft / decision-of-record · **Date:** 2026-07-23 · **Owner:** client/perf

Mobile (Obsidian mobile — a JavaScript WebView on a phone, limited CPU and RAM) is an
**explicit target** of this project. Before we optimize anything, we need to **know our
ground truth**: where the time goes, where the RAM goes, and how each cost scales as a vault
and its history grow. This spec defines the benchmarks that establish that baseline.

**Non-goal (deliberate): this spec does NOT optimize.** No code path is changed for speed
here. The output is *measurement infrastructure + a recorded baseline*, so that when we do
optimize we can prove it helped and didn't regress correctness. The candidate hot paths in
Appendix A are **hypotheses to confirm or refute with numbers**, not a work list.

Companion docs: `docs/sync-engineering-guide.md` (behavior/invariants — do not break them
for a benchmark), `docs/pre-release-ux-audit-spec.md` (the other pre-release track).

---

## 1. Why now, and what "baseline" means

The sync engine grew correctness-first. Several paths do work proportional to the **whole
vault** or the **whole history** rather than the **delta** of a round (Appendix A). On a
laptop that is invisible; on a phone it may not be. We cannot make a sound optimization
decision without answering, with numbers:

1. **How long does a routine sync take** on a representative mobile vault, and which *phase*
   dominates?
2. **How does that cost scale** with number of files (**F**), history length (**H**), and
   file size (**B**)? Linear, or worse?
3. **How much RAM** does a round allocate transiently, and how much does the process hold
   resident across a long session?
4. **How much does startup cost** (first-enable and every cold load)?
5. **What is the I/O write amplification** per round / per op?

A "baseline" is a **recorded, reproducible table** of these numbers at several vault sizes,
checked into the repo, that we can re-run to spot regressions and, later, to quantify wins.

---

## 2. Scaling variables & representative vault profiles

Variables used throughout (and in Appendix A):

| Sym | Meaning |
|---|---|
| **F** | number of live files in the vault |
| **B** | bytes per file (content size) |
| **H** | total ops ever appended to the server log (history length) |
| **G** | version-DAG size (nodes ≈ H) |
| **P** | pending (un-pushed) local ops in a round |
| **R** | ops pulled this round (the remote delta) |
| **C** | concurrent heads for a single file |

**Vault profiles to benchmark** (pick fixed points so results are comparable over time):

| Profile | F | B (typical) | H | Rationale |
|---|---|---|---|---|
| **XS** | 50 | 2 KB | 200 | smoke / floor |
| **S** | 500 | 4 KB | 2,000 | a modest real vault |
| **M** | 2,000 | 6 KB | 20,000 | a serious note-taker; a realistic phone target |
| **L** | 10,000 | 8 KB | 100,000 | power user / long history — the stress point |
| **XL** | 20,000 | 8 KB | 250,000 | ceiling probe (may exceed mobile viability — that's a finding) |

Plus targeted variants that isolate one variable:
- **deep-history**: small F (e.g. 20 files), large H via many edits to the same files — isolates DAG-walk cost.
- **big-file**: small F, large B (e.g. 5 MB attachments/notes) — isolates hashing/crypto/diff3.
- **wide-concurrency**: one file, C = 3…10 concurrent heads — isolates `reconcileConcurrentHeads`.
- **low-unique-line**: one large file of repetitive lines — isolates the diff3 Myers O(L²) fallback.

---

## 3. What we measure (metrics)

For each scenario (§5) at each profile (§2), record:

| Metric | Unit | Why it matters on mobile |
|---|---|---|
| **wall time, per phase** | ms | the headline; per-phase attribution finds the dominant step |
| **CPU-bound op counts** | count | # SHA-256 hashes, # AES-GCM ops, # DAG ancestor-walks — device-independent proxy for CPU that isolates *algorithm* from *machine* |
| **transient allocation** | MB (peak heap delta) | a round that decodes the whole vault into RAM can OOM a phone tab |
| **resident memory** | MB (RSS after N rounds, post-GC) | session-lifetime growth (unbounded caches) |
| **fs operations** | count | syscalls dominate mobile I/O; count reads/writes/renames/removes |
| **bytes written** | bytes | write amplification (full-file JSON rewrites); flash wear + latency |
| **startup time** | ms | first-enable and cold-load are the first thing a mobile user feels |

**Op counts and fs counts are the most portable signal.** In-memory fakes (§4) don't
reproduce real flash latency, but they reproduce *exactly* how many times we hash, how many
times we walk the DAG, and how many bytes we rewrite — which is the thing that scales badly.
Absolute wall-times come from the on-device pass (§4, layer 3).

---

## 4. Measurement methodology — three layers

We can't get everything from one place. In-memory fakes give deterministic algorithm/CPU
signal but not true device I/O; a real phone gives true numbers but is manual. Use three
layers, each honest about what it does and doesn't capture.

### Layer 1 — CPU/allocation micro-benchmarks (Node, deterministic)
Drive the **real production stack over `TestDevice`** (Appendix B) and time operations with a
monotonic clock. Run under `node --expose-gc` so allocation deltas are measurable
(`global.gc()` + `process.memoryUsage().heapUsed` around the op). This isolates **algorithmic
big-O and JS allocation** independent of disk. Runner: a `npm run bench` script (or Vitest's
`bench()` where a stable median suffices). **Caveat:** the fakes are in-memory `Map`s, so
"fs" time here is near-zero and unrepresentative — this layer measures CPU + heap only.

### Layer 2 — I/O instrumentation (via the fakes)
Instrument `FakeMetadataStore` / `FakeVaultFiles` (Appendix B) with counters:
`reads`, `writes`, `renames`, `removes`, `appends`, `bytesWritten`, keyed by target file.
Run the same scenarios and record the counts. This makes **write amplification** (e.g. the
per-mutation full-registry rewrite) and **read/re-hash counts** visible and device-independent.
No timing here — pure counts + bytes.

### Layer 3 — On-device wall-clock (manual, the source of truth for absolute time)
Add a **debug timing log behind a setting flag** (`perfLog`, off by default): `runSync()` and
startup emit per-phase durations (`performance.now()` deltas) and `performance.memory` where
available, to the console / a log file under `.vault-sync/`. On a **mid-range Android phone**
and a **low-end phone**, run the manual matrix (§5 scenarios at profiles S and M, at least)
and record the real numbers. This is the only layer that reflects the actual WebView CPU
(~3–5× slower single-thread than a dev laptop) and Capacitor filesystem latency (each syscall
materially more expensive than desktop). **Absolute budgets (§6) are judged against Layer 3.**

> Rule: Layers 1–2 run in CI-adjacent `npm run bench` for regression tracking; Layer 3 is a
> pre-release manual pass recorded in the baseline table. A Layer-1 wall-time is only a
> *relative* signal; never quote it as the mobile number.

---

## 5. Benchmark scenarios

Each isolates one hypothesized hot path (Appendix A). For each: setup via `TestDevice`,
what to record, and the scaling hypothesis to test.

**B1 — Steady-state round vs F (the `buildLocalState` re-read/re-hash).**
Seed F files, sync to convergence, then make a **1-file** edit and time a full `runSync()`.
Record: round wall time (L1), # SHA-256 hashes and # file reads (L2), transient MB (L1).
*Hypothesis:* round cost grows **O(F·B)** despite a 1-file delta, because `buildLocalState`
re-reads + re-hashes every live file every round (`vault-sync-host.ts:42-91`). Confirm the
per-round hash count ≈ F, not ≈ 1.

**B2 — Round vs history H (DAG walks).**
deep-history profile: 20 files, each edited K times (H = 20·K), two devices producing real
divergence so `mergeBase`/`isAncestor` actually run. Time the merge phase; count DAG ancestor
walks. *Hypothesis:* merge-phase cost grows with per-file lineage depth; `mergeBase` shows
super-linear behavior (its `common.filter(common.some(isAncestor))` is O(common²·(V+E)),
`version-dag.ts:156`). Confirm whether it's a real curve at K = 100 / 1,000 / 10,000.

> **Measured (2026-07-23, `bench/run.ts` `b2`, K = 5/20/80/160 sweep).** The round **is
> super-linear in lineage depth** — `mergeRoundMs/H` climbs 3.2 → 3.2 → 5.6 → 9.5, and
> doubling K = 80 → 160 ≈ **3.4×**es the time (≈ O(H^1.7)). So the *curve is real*.
> **But the mechanism is NOT the `mergeBase` `common²` filter the hypothesis names.** The
> instrumented `isAncestor / mergeBase` ratio stays flat at **~1.0** across the sweep: this
> topology gives each file a *single* common ancestor (the create version), so
> `common.length == 1` and the `common.filter(common.some(isAncestor))` loop does **zero**
> `isAncestor` work — the ~1 `isAncestor` per `mergeBase` is just `state-merge`'s
> fast-forward check. The cost that *does* scale tracks `dagReachable` / `fileReads` /
> `sha256` (all ≈ equal, growing with H): the **O(depth) ancestor + `reachableContentHashes`
> walks and the re-read/re-hash of base bytes along each head's history**, repeated per file
> per round. So B2-as-written measures the **deep-lineage walk-and-rehash** cost (the real
> curve), and effectively *clears* `mergeBase`'s quadratic filter for the linear-lineage
> case. **The `common²·(V+E)` cliff only bites when a file's two heads share a *large*
> common-ancestor set** — which this profile never builds (it diverges at the create
> version, so `common` size = 1).
>
> **Root cause corrected + FIXED (`server-sync.ts` `reconcileConcurrentHeads`).** A deeper
> profile decomposed the residual: `reachableContentHashes` was invoked ~3,200× per round at
> K = 160 (`buildLocalState`'s full per-file read+hash+stage loop re-run ~K times), so the cost
> was **not** the O(depth) `ancestors()` walk (memoizing it would not have helped) — it was the
> reconcile fold loop **spinning**. `reconcileConcurrentHeads` set `folded = true` whenever it
> *attempted* a foldable leaf, but a two-headed **text conflict** doesn't collapse (the pairwise
> merge re-conflicts), so it re-picked the same leaf every iteration and spun to `maxFolds`
> (≈ pulled ops), re-running `buildLocalState` each time. Fix: remember attempted
> `(fileId, leafId)` pairs → folds bounded to O(distinct extra leaves). **Measured B2 K = 160:
> `fileReads` 64,460 → 460 (140×), `reachable`/`sha256` now flat in K, `mergeRoundMs`
> 29,108 → 466 ms (62×).** Residual ms growth is the inherent O(H) pull/decrypt of the deep
> chain (a B4-class cost), not the reconcile. Pinned by `reconcile-conflict-spin.test.ts`
> (conflict still surfaced, neither edit lost, `buildLocalState` count single-digit vs ~K+1).

**B2b — mergeBase's `common²` filter (deep SHARED backbone, tip divergence).**
The variant that isolates the filter B2 cleared. Both devices fast-forward onto a depth-K
*shared* backbone, then each makes **one** concurrent tip edit, so `mergeBase(a1, b1)` sees a
`common` set of size ≈ K. `bench/run.ts` `b2b`.

> **Measured (2026-07-23, K = 5/20/80/160/320).** **Hypothesis confirmed — and it is the
> clean complement of B2.** `mergeBase` call count stays **constant** (61 ≈ per-file), but
> `isAncestor` scales as **≈ FILES·(2K+1)** → the `isAncestor/mergeBase` ratio climbs
> **linearly** with depth: **11.3 → 41.3 → 161.3 → 321.3 → 641.3**. Each `mergeBase` now does
> O(K) `isAncestor` calls over its size-K `common` set (vs ~0 in B2), each itself an O(K)
> walk ⇒ **O(K²) filter work per round over constant files**, and wall time goes super-linear
> (683 → 1,642 ms for K = 160 → 320, a 2× depth). Crucially `dagReachable` / `fileReads` stay
> **FLAT** (840 / 860) — B2b pays in the *filter*, B2 pays in the *walk/rehash*; together they
> decompose the two DAG cost sources. The Layer-2 `isAncestor` count is the device-independent
> signal (wall time only starts to bite at K ≳ 160 on a laptop; a slow phone / larger graph
> moves that left).
>
> **FIXED (`version-dag.ts` `mergeBase`).** The `common.filter(common.some(isAncestor))`
> maximal-element scan was replaced by a **single multi-source upward walk**: walk up from
> every common node's parents, mark everything reached, and any common node so marked is a
> proper ancestor of another common node → non-maximal. One traversal, O(V+E), **zero
> `isAncestor` calls** — provably correct independent of node ordering (a set-membership
> question), so determinism/commutativity hold. Re-measured K = 5/20/80/160/320: `isAncestor`
> is now **flat at 81** (the constant `state-merge` fast-forward checks; `mergeBase` itself
> issues none), down from `61·(2K+1)` — a **483× drop at K = 320** (39,121 → 81), and the ratio
> collapses 641 → **1.33**. The topo-depth idea (an O(1) depth-compare prune) is unnecessary:
> the multi-source walk kills the quadratic without any incremental depth bookkeeping to
> maintain/propagate. Pinned by `version-dag.test.ts` "deep shared backbone, tip divergence".
> *(The residual `mergeRoundMs` growth is now purely B2's O(depth) `ancestors()` walk + base
> staging — the next target. A true criss-cross, many mutually-incomparable maximal common
> ancestors → `MULTIPLE_BASES`, is handled by the same single walk at the same O(V+E) cost.)*

**B3 — Cold startup vs F (`captureOfflineChanges`).**
Populate F files on disk (via `seedExistingFile` — no events), then `reload()` and time
`init()` + the first `captureOfflineChanges()`. Record: startup wall time (L1/L3), # hashes +
# reads + registry bytes written (L2). *Hypothesis:* startup is **O(F·B)** hashing + up to
**O(F²)** registry write bytes (per-file mutation → full registry rewrite,
`file-registry.ts`). This is what a mobile user feels on first-enable of a large vault.

**B4 — Cold pull / DAG rebuild vs H.**
Seed a `FakeSyncServer` with H ops (via a first device), then a fresh device pulls from
`cursor = 0` (also the `dagNeedsRebuild` path). Time the pull+rebuild; record peak RAM of the
`pullAll` array and decrypt count. *Hypothesis:* **O(H)** decrypts and O(H) simultaneous
in-memory Operation objects (`server-sync.ts:378`) — a memory spike proportional to full
history on the very first sync of a joining device.

**B5 — Write amplification per round/op (L2 only).**
Run B1 and a batch-capture (B3) and tabulate fs op counts + bytes written per store
(`file-registry.json`, `oplog.json`, DAG snapshot/journal). *Hypothesis:* registry rewrites
dominate (full pretty-printed `JSON.stringify` on every mutation, ×~3 fs ops via the atomic
temp+remove+rename dance, `obsidian-metadata-store.ts:33-49`); the DAG journal is the one
delta-sized writer. Confirm bytes-written scales O(F) per mutated file (O(F²) per batch).

**B6 — Memory over a session.**
Run N=50 consecutive rounds touching different files; sample RSS (post-GC) after each.
*Hypothesis:* `ContentStore.memCache` grows unbounded toward total distinct content bytes —
`clearMemCache()` exists but is **never called** (`content-store.ts:31,112`). Also record the
transient per-round peak (B1) and the resident DAG footprint at each profile (nodes ≈ H).

**B7 — Concurrent-head fold vs C.**
wide-concurrency profile: drive C independent heads of one file into a single round so
`reconcileConcurrentHeads` folds them. *Hypothesis:* cost is **O(folds·(F·B + G))** because
the fold loop re-runs `buildLocalState()` + `recordVersionEdges()` per fold
(`server-sync.ts:554-557`) — superlinear in C. Measure at C = 3, 5, 10.

> **Status / next (2026-07-23).** The B2 investigation already removed the *spin* half of this
> cost (a non-collapsing conflict fold re-ran `buildLocalState` `~pulled` times — fixed, 62× on
> B2; see the B2 measured-note + Appendix A #5). What remains for B7 is the **per-*genuine*-fold**
> rebuild: even folding C real concurrent leaves, the loop calls `buildLocalState()` (full vault
> re-read + re-hash + base-staging) **and** `recordVersionEdges()` **once per fold**, so a
> C-head file costs O(C·(F·B + G)). **Next optimization:** fold against reusable in-memory state
> — thread the loaded `VaultState`/DAG through the loop and mutate it per fold (or rebuild only
> the single file that changed), instead of a full `buildLocalState` each iteration. This is the
> remaining open item on hot-path #5; measure with B7 (C = 3/5/10) before and after. Ties into
> hot-path #6 (the DAG snapshot is reloaded 3–4× per round + once per fold — cache it per round).
> Gate on device data (§9): B7's wide-concurrency workload is rarer than the capture/steady-state
> paths, so land it only if the on-device pass shows folds materially on the hot path.

**B8 — diff3 large-file merge vs B and line-uniqueness.**
big-file and low-unique-line profiles, both-modified so `threeWayMerge` runs. *Hypothesis:*
normal files are ~O(L); a repetitive/low-unique file falls into `myersLCS`'s **O(L_a·L_b)**
DP matrix (`diff3.ts:141`) — a CPU + memory spike. Confirm the cliff.

**B9 — Crypto attribution.**
Micro-bench: PBKDF2 derive (once, `deriveFromPassphrase`), per-op AES-GCM, per-blob AES-GCM
over B bytes, per-blob HMAC blind, and SHA-256 over B bytes. *Hypothesis:* PBKDF2 is a fixed
~0.25–0.5 s one-time cost (acceptable); the accumulating cost is **repeated SHA-256** — a file
can be hashed 3+× per logical change (on-edit, buildLocalState re-hash, fetch-verify;
`encryption.ts` / `content-store.ts` / `server-sync.ts:445`). Quantify the per-change hash multiplier.

---

## 6. Provisional mobile budgets (to validate, not yet enforce)

Numbers to **judge the Layer-3 baseline against**. If the baseline blows these, that's the
signal to open the optimization track (out of scope here). Starting hypotheses — refine once
we have real device data:

| Operation | Profile | Provisional budget (mid-range phone) |
|---|---|---|
| routine sync (1-file delta) | S / M | < 400 ms / < 1 s |
| first-enable capture | S / M | < 1 s / < 4 s |
| cold pull (join) | M | < 5 s |
| transient RAM per round | M | < 50 MB |
| resident RAM after long session | M | < 150 MB, and **not monotonically growing** |
| startup (warm, no capture) | any | < 300 ms of plugin overhead |

The "not monotonically growing" line for resident RAM is the one hard qualitative bar — an
unbounded cache is a mobile crash waiting to happen regardless of the absolute number.

---

## 7. Instrumentation to add (measurement-only, no behavior change)

1. **Counters on the fakes** (L2): `FakeMetadataStore`/`FakeVaultFiles` tally
   reads/writes/renames/removes/appends/bytesWritten. Test-only; never shipped.
2. **Optional counters on the real hot modules**, gated so they compile out / are free when
   off: a `hashCount` on `ContentStore.hashContent`, an ancestor-walk counter on `VersionDag`.
   Prefer wrapping in the bench harness over editing production if it can be done externally.
3. **`perfLog` setting + per-phase timing in `runSync()` and startup** (L3): `performance.now()`
   deltas per step, logged only when the flag is on. This is the only production-touching
   change and it is inert by default.
4. **`npm run bench`** script running Layers 1–2 and emitting a machine-readable results JSON +
   a Markdown table.

---

## 8. Baseline report & regression tracking

- Commit the filled baseline as `docs/perf-baseline-<date>.md` (Layer-1/2 counts + Layer-3
  device wall-times), with the exact commit hash and device models.
- `npm run bench` prints current vs a stored `bench/baseline.json`; a >X% regression in an
  op-count or byte-count metric is a **review flag**, not a hard CI gate (initially).
- Re-run and append a new baseline before each release and after any change to the sync round,
  the DAG, persistence, or the merge (the guide's regression-critical surfaces).

## 9. Deliverables checklist

- [x] `TestDevice`-based large-vault seeding helpers (loop `seedFile`/`seedExistingFile`; a
      `FakeSyncServer` seeded to H ops). — `bench/harness.ts` (`seedVault`,
      `seedExistingVault`, `pushOffline`).
- [x] Instrumented fakes with I/O + byte counters (L2). — `__tests__/helpers/fakes/io-counters.ts`
      wired into `FakeMetadataStore`/`FakeVaultFiles` (`.io`).
- [x] Bench runner `npm run bench` (L1 timing + alloc via `--expose-gc`; L2 counts) → results JSON + Markdown.
      — `bench/run.ts` + `bench/harness.ts`; CPU-op counts via external monkey-patch (no production edit).
      Output: `bench/results/latest.{json,md}`.
- [x] Scenarios B1–B9 implemented against the profiles in §2. — `bench/run.ts`.
- [x] `perfLog` setting + per-phase timing in `runSync()`/startup (L3), inert by default. — `SyncSettings.perfLog`,
      `src/network/perf-timer.ts`, laps in `runSync()`, startup brackets + settings toggle in `main.ts`/`settings-tab.ts`.
      Covered by `__tests__/perf-timing.test.ts`.
- [ ] On-device manual pass on a mid-range and a low-end phone; numbers recorded. — **PENDING** (manual).
- [x] `docs/perf-baseline-<date>.md` committed with the full table + device/commit provenance. —
      `docs/perf-baseline-2026-07-23.md` (Layer 1/2 filled; Layer 3 device columns pending the manual pass).

---

## Appendix A — Known hot-path hypotheses (what the baseline is testing)

Ranked "where the time/RAM likely goes," each a hypothesis for §5 to confirm/refute. **These
are not fixes** — they are the map of what to measure.

1. **`buildLocalState` re-reads + re-SHA-256s the whole live vault every round** —
   `vault-sync-host.ts:42-91`. O(F·B) CPU + O(F·B) transient RAM per round, independent of
   delta size. (B1, B6)
2. **VersionDAG walks are un-memoized and scale with history** — `mergeBase` O(common²·(V+E)),
   `isAncestor`/`ancestors`/`leaves` full DFS, recomputed per call, per differing file, over
   each file's full lineage. `version-dag.ts:94,131,156,179,189`. Gets worse as **H** grows. (B2)
   — **B2 measured (2026-07-23):** the round *is* super-linear in depth (≈ O(H^1.7)), but via
   the **O(depth) `ancestors()`/`reachableContentHashes` walks + base-byte re-hashing**, not
   the `common²` filter — that filter did ~0 `isAncestor` work here (`common.length == 1` for a
   linear lineage; `isAncestor/mergeBase ≈ 1.0` flat across the sweep). **B2b measured
   (2026-07-23)** isolates the filter with a *deep shared backbone*: `common ≈ K`, `mergeBase`
   flat but `isAncestor` ≈ FILES·(2K+1) → the ratio climbs 11→41→161→321→641, an **O(K²)-per-round
   filter cliff** (reads/reachable stay flat). So there are **two** distinct DAG costs here:
   the deep-walk/rehash (B2, open) and the `common²` maximal-scan (B2b, **FIXED**). B2b's
   filter is gone: `mergeBase`'s pairwise-isAncestor scan is now a single multi-source upward
   walk (O(V+E), zero isAncestor) — `isAncestor` dropped from `61·(2K+1)` to a flat 81 (483× at
   K = 320). Remaining: memoize `ancestors()` + stop re-staging unchanged history (B2). See the
   B2/B2b §5 measured-notes.
3. **`ContentStore.memCache` is unbounded; `clearMemCache()` is never called** —
   `content-store.ts:31,112`. Session-lifetime RAM growth toward total content bytes. (B6)
4. **FileRegistry full pretty-printed JSON rewrite on every one of ~12 mutation sites**, looped
   per-file during capture/apply → up to O(F²) bytes written, ×~3 fs ops via the atomic
   temp+remove+rename dance. `file-registry.ts`, `obsidian-metadata-store.ts:33-49`. (B3, B5)
5. **`reconcileConcurrentHeads` re-runs `buildLocalState` + DAG reload inside its fold loop** —
   `server-sync.ts:554-557`. O(folds·(F·B+G)); pathological in **C**. (B7) — **partly FIXED:** the
   loop no longer *spins* on a non-collapsing conflict fold (it re-picked the same un-foldable
   text-conflict leaf every iteration → `folds ≈ pulled ops`); attempted-leaf memo bounds it to
   O(distinct extra leaves). This was the dominant **B2** cost (fileReads 64k→460 at K=160, 62×).
   The remaining per-*genuine*-fold `buildLocalState` re-run (real cost in **C**, B7) is still open
   — reuse the loaded state across folds instead of a full rebuild.
6. **The DAG snapshot is loaded + JSON-parsed 3–4× per round** (dagNeedsRebuild,
   buildLocalState, recordVersionEdges, + per fold) — each O(G), redundant. `vault-sync-host.ts`. (B1, B7)
7. **Cold pull / DAG rebuild is O(H)** — `dagNeedsRebuild` resets cursor to 0; `pullAll`
   decrypts the whole log into one array. `server-sync.ts:378`; startup `captureOfflineChanges`
   `operation-logger.ts:89`. (B3, B4)
8. **diff3 Myers fallback is O(L_a·L_b)** with a matching DP matrix for low-unique-line files —
   `diff3.ts:141`. (B8)
9. **Merge wraps its per-touched-file work in an O(F) vault scan** (union over all local
   fileEntries, `state-merge.ts:27,54`) — a floor cost even for a 1-file delta. (B1, B2)
10. **Repeated SHA-256 per change** (on-edit, buildLocalState re-hash, fetch-verify) — a >1×
    hash multiplier per logical change. `content-store.ts`, `server-sync.ts:445`. (B9)

## Appendix B — Harness notes

- **`__tests__/helpers/test-device.ts`** wires the **real** FileRegistry, ContentStore,
  OperationLogger, SyncApplicator, PluginVaultSyncHost, CursorStore, VersionDagStore over the
  in-memory fakes with a **settable wall clock**. Action helpers (`seedFile`, `editFile`,
  `deleteFile`, `renameFile`, `seedBinary`, `renameAndEdit`, `seedExistingFile`) drive the
  genuine op-logger path; `reload()` models a restart from persisted disk state. This is the
  seeding + timing harness — loop `seedFile` to build a large vault, then time
  `host.buildLocalState()` / a full `ServerSyncClient.runSync()`.
- **`__tests__/helpers/fakes/`** — `vault-files.ts`, `metadata-store.ts`, `vault-watcher.ts`.
  `FakeMetadataStore` is the instrumentation point for I/O counts (Layer 2).
- **`src/network/fake-server.ts`** (`FakeSyncServer`) — seed a large server log (H ops) for the
  cold-pull / rebuild benchmarks (B4).
- No scale/perf fixtures exist today (grep found none) — all of the above is **net-new**, built
  on the existing real-stack harness so benchmarks exercise production code, never a
  reimplementation (consistent with the testing doctrine in the engineering guide §8).

## Out of scope
The optimizations themselves (memoization, in-memory DAG caching per round, incremental /
mtime-gated `buildLocalState`, bounding `memCache`, batching registry writes, DAG pruning) —
each is a **separate, post-baseline decision** that must preserve every data-safety invariant
in `sync-engineering-guide.md` §5 and §7. This spec only measures.
