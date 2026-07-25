# Vault Sync — Mobile Performance Baseline (recorded)

**Status:** recorded baseline · **Date:** 2026-07-23 · **Spec:** `docs/mobile-perf-baseline-spec.md`

The first recorded run of the baseline the spec defines. This is **measurement, not
optimization** — no hot path was changed for speed. It exists so a future
optimization can be proven to help (and not regress correctness), and so the
Appendix-A hypotheses are confirmed/refuted **with numbers** rather than asserted.

Re-generate the Layer-1/2 half with `npm run bench` (see `bench/README.md`); the
machine-readable companion to this run is `bench/results/2026-07-23_xs-s-m.json`
(each run writes a date+profile-stamped file so no run silently overwrites another —
`bench/results/latest.*` is a transient, git-ignored pointer to the most recent run).

---

## Provenance

| | |
|---|---|
| Commit | `530b330` (baseline). The B3/B5 tables show the **pre-fix baseline**; the capture-batching fix's post-fix numbers are shown beneath each as a delta. |
| Machine-readable | baseline `bench/results/2026-07-23_xs-s-m.json`; post-fix run `bench/results/2026-07-23_post-capture-fix_xs-s-m.json` |
| Layer-1/2 host | AMD Ryzen 7 5800H, Node v26 — **a dev laptop, not a phone** |
| Layer-1/2 runtime | 54.7 s for profiles XS, S, M |
| Profiles | XS(F=50, B=2 KB), S(F=500, B=4 KB), M(F=2000, B=6 KB) |
| Layer 3 (on-device) | **PARTIAL** — first Android run recorded below (first-enable capture on an ~8.4k-file vault). Formal mid-range + low-end matrix still pending. |

**Read the layers correctly (spec §4):**
- **Layer 1** (wall ms, heap MB) is a **relative** signal on this laptop. It is *not*
  the mobile number — a phone WebView is ~3–5× slower single-thread and each
  filesystem syscall is materially more expensive. Never quote a Layer-1 ms as "how
  long this takes on mobile".
- **Layer 2** (op-counts, byte-counts) is **exact and device-independent** — the same
  on a laptop and a phone. This is the portable signal, and where the scary numbers
  are.
- **Layer 3** (absolute on-device wall time) is the only source of truth for time and
  is **still to be recorded** via the `perfLog` diagnostic (Settings → Diagnostics →
  Performance logging → read `.vault-sync/perf-log.txt`).

---

## Headline findings

Ranked by how much they matter on a phone. All are Layer-2 (device-independent) unless
noted. Each maps to an Appendix-A hypothesis — **all were confirmed**.

1. **First-enable of a large vault rewrote the whole registry per file → O(F²) bytes
   (A4, B3/B5). — FIXED, see "The fix" below.** Capturing a 2000-file vault wrote
   **1.96 GB** to disk (500 files: 124 MB; 50 files: 1.4 MB) — the classic O(F²) curve
   (10× files ⇒ ~90× bytes). Each logical registry write is ~3 fs syscalls (atomic
   temp+remove+rename), so M issued **~18,000 metadata syscalls** on first enable — on
   phone flash the single most alarming result (latency **and** flash wear). Batching
   the registry write (commit below) cuts M to **26.5 MB / 6,096 syscalls** — a **74×**
   reduction in bytes — and removes the on-device cliff's cause.

2. **Every routine round re-reads + re-SHA-256s the whole live vault (A1, B1). —
   FIXED, see "The R1 fix" below.** A **1-file** edit round hashed **F+1** files and
   issued **F** vault reads (M: 2001 hashes, 2000 reads for a one-file change). Round
   cost was O(F·B), independent of the delta — the dominant per-round cost as a vault
   grows. R1 extends the capture mtime/size gate into `buildLocalState`, so the
   steady-state capture→round sequence now hashes **≈1** and reads **1** at every
   profile (M: **2** hashes, **1** read), independent of F.

3. **VersionDAG walks scale with per-file history depth (A2/A6, B2).** A merge round
   against a peer with deep lineage did **20,440** `reachableContentHashes` walks and
   **21,522** SHA-256s at K=50 (H≈1000) — and the Layer-1 round took **4.3 s** on the
   *laptop*. `mergeBase`/`isAncestor` are un-memoized and recomputed per differing
   file; the cost climbs steeply with history.

4. **`ContentStore.memCache` grows unbounded across a session (A3, B6). — partially
   addressed.** Post-GC heap climbed monotonically with rounds — +8.1 MB over 50 rounds
   at M, not reclaimed by GC (the cache holds live references). `clearMemCache()` exists
   but was never called; the capture fix now calls it at each checkpoint, so a large
   first-enable no longer accumulates the whole vault's content in RAM. The *steady-state
   round* cache (B6) is still unbounded — a separate follow-up.

5. **Cold join is O(H) decrypts + O(H) resident ops (A7, B4).** A fresh device's first
   sync decrypted **≈H** ops into one in-memory array (H≈1020 ⇒ 1041 AES-GCM decrypts,
   23.5 MB transient). Linear, but the whole history lands in RAM at once on the very
   first sync.

6. **Concurrent-head fold is superlinear in C (A5, B7).** The fold loop re-runs
   `buildLocalState` + `recordVersionEdges` per fold: vault reads 7→9→14 and round
   time 11→13→20 ms for C=3→5→10. Bounded here by a 1-file scope; pathological if C is
   large.

7. **diff3 falls off an O(L²) cliff on low-unique-line files (A8, B8).** A normal 1 MB
   file merged in **68 ms**; an 8000-line *repetitive* file took **1431 ms** — the
   Myers DP fallback. Rare in prose, real for generated/tabular content.

8. **Crypto is not the accumulating cost (A10, B9).** PBKDF2 is a fixed one-time
   ~29 ms here (~0.25–0.5 s on phone — acceptable); per-op AES-GCM is ~0.1 ms; blob
   AES-GCM/SHA-256 scale linearly with B. The accumulating CPU cost is the **repeated
   SHA-256** surfaced in B1/B3, not the ciphers.

**Bottom line:** the costs that scale badly are all **structural** — full-vault
re-hash per round (B1), full-registry rewrite per file (B3/B5), un-memoized DAG walks
(B2), and an unbounded content cache (B6). None is crypto. These are the candidates the
(separate, out-of-scope) optimization track should target — each while preserving every
data-safety invariant in `sync-engineering-guide.md` §5/§7.

---

## Layer 1 & 2 table

Wall/heap columns are **relative** (laptop); count/byte columns are **exact**.

### B1 — steady-state round vs F (1-file edit; `buildLocalState` re-hash)
| profile | fileReads | sha256 | metaWrites | roundMs¹ | heapMB¹ |
|---|--:|--:|--:|--:|--:|
| XS (F=50) | 50 | 51 | 5 | 8.3 | 1.0 |
| S (F=500) | 500 | 501 | 5 | 38.4 | 8.6 |
| M (F=2000) | 2000 | 2001 | 5 | 153.1 | 8.3 |

_hashes ≈ F+1 and reads ≈ F for a **one-file** delta → O(F·B) per round confirmed._

### B2 — round vs history H (DAG walks)
| variant | dagMergeBase | dagIsAncestor | dagReachable | sha256 | mergeRoundMs¹ |
|---|--:|--:|--:|--:|--:|
| deep-history K=20 (H≈400) | 441 | 461 | 8,440 | 8,922 | 1,249 |
| deep-history K=50 (H≈1000) | 1,041 | 1,061 | 20,440 | 21,522 | 4,262 |

### B3 — cold startup vs F (`captureOfflineChanges`) — **baseline (pre-fix)**
| profile | sha256 | fileReads | metaWrites | registryBytes | fsSyscalls² | captureMs¹ |
|---|--:|--:|--:|--:|--:|--:|
| XS (F=50) | 50 | 50 | 152 | 1,389,518 | 456 | 6.7 |
| S (F=500) | 500 | 500 | 1,502 | 124,244,172 | 4,506 | 285 |
| M (F=2000) | 2,000 | 2,000 | 6,002 | **1,959,351,836** | 18,006 | 4,201 |

_**After the capture-batching fix** (sha256/fileReads unchanged — the fix targets writes,
not the read/hash pass):_

| profile | metaWrites | registryBytes | fsSyscalls² | captureMs¹ |
|---|--:|--:|--:|--:|
| XS (F=50) | 53 | 181,324 | 159 | 4.4 |
| S (F=500) | 509 | 3,680,621 | 1,527 | 44.5 |
| M (F=2000) | 2,032 | **26,556,558** | 6,096 | 264.9 |

_Full post-fix run: `bench/results/2026-07-23_post-capture-fix_xs-s-m.md`; baseline:
`bench/results/2026-07-23_xs-s-m.md`._

### B4 — cold pull / DAG rebuild vs H
| variant | aesDecrypt | sha256 | metaWrites | coldPullMs¹ | heapMB¹ |
|---|--:|--:|--:|--:|--:|
| join H≈420 | 441 | 61 | 43 | 25.5 | 10.6 |
| join H≈1020 | 1,041 | 61 | 44 | 56.5 | 23.5 |

### B5 — write amplification per batch capture (L2 only) — **baseline (pre-fix)**
| profile | metaWrites | fsSyscalls² | bytesWritten | writesPerFile |
|---|--:|--:|--:|--:|
| XS (F=50) | 152 | 456 | 1,389,518 | 3.0 |
| S (F=500) | 1,502 | 4,506 | 124,244,172 | 3.0 |
| M (F=2000) | 6,002 | 18,006 | 1,959,351,836 | 3.0 |

_Baseline: `writesPerFile` is a flat **3.0** — registerFile + setHeadVersion each rewrote
the whole registry → O(F²) `bytesWritten`. **After the fix:** writesPerFile → **1.0**
(one content-blob write/file; registry persisted only at checkpoints), and M
`bytesWritten` → **26,556,558** (S → 3,680,621; XS → 181,324) — 74× less at M.
`bytesWritten` stays gently superlinear (the flush re-serializes a growing registry,
O(F²/N)); true O(F) needs an append-only registry journal (future work)._

### B6 — memory over a 50-round session (post-GC heap)
| profile | heapStartMB¹ | heapEndMB¹ | heapGrowthMB¹ |
|---|--:|--:|--:|
| XS | 7.8 | 8.3 | +0.4 |
| S | 11.6 | 13.9 | +2.3 |
| M | 29.5 | 37.5 | **+8.1** |

_Monotonic, un-reclaimed by GC → `memCache` never cleared._

### B7 — concurrent-head fold vs C
| variant | fileReads | dagMergeBase | sha256 | foldRoundMs¹ |
|---|--:|--:|--:|--:|
| C=3 | 7 | 7 | 17 | 11.2 |
| C=5 | 9 | 9 | 21 | 12.9 |
| C=10 | 14 | 14 | 31 | 20.2 |

### B8 — diff3 large-file merge (Layer-1 CPU)
| variant | conflicts | mergeMs¹ |
|---|--:|--:|
| big-file 64 KB unique | 4 | 1.9 |
| big-file 256 KB unique | 14 | 8.1 |
| big-file 1 MB unique | 53 | 68.1 |
| low-unique 1,000 lines | 0 | 16.0 |
| low-unique 4,000 lines | 0 | 354.4 |
| low-unique 8,000 lines | 0 | **1,431.3** |

### B9 — crypto attribution (Layer-1 CPU)
| op | ms¹ |
|---|--:|
| PBKDF2 derive (one-time) | 29.4 |
| AES-GCM per op | 0.1 |
| AES-GCM per blob, 1 MB | 0.6 |
| AES-GCM per blob, 5 MB | 9.5 |
| SHA-256, 5 MB | 3.7 |

¹ Layer-1 wall/heap — **relative** signal on a dev laptop, not the mobile number.
² `fsSyscalls` estimates real syscalls: each atomic metadata write ≈ 3 (temp+remove+rename).

---

## Layer 3 — on-device, recorded (the number that actually matters)

First real-device run: **B3 first-enable capture** on an Android phone (Chromium
WebView; exact model TBD), vault of **8,388 notes**, via the `perfLog` diagnostic
streaming `captureOfflineChanges` scan progress. It was stopped at 3,400/8,388 — it
never finished (see the cliff), which is itself the finding.

Per-100-file batch wall time (from the streamed progress lines):

| files scanned | ms/100 files | ms/file | note |
|---|--:|--:|---|
| 100 → 3,200 | ~390–510 | **~4.1** | roughly flat / gently linear |
| 3,200 → 3,300 | **26,735** | **267** | cliff — 65× jump |
| 3,300 → 3,400 | **55,215** | **552** | still climbing |

`startup load` (persisted-store load, near-empty on first enable) was 278 ms — fast;
all the cost is in the capture.

**This overturns the Layer-1 prediction.** The laptop bench showed a smooth O(F²) byte
curve; the *device* is ~flat until ~3,200 files, then a **60–130× cliff**.

**Confirmed mechanism (Node probe):** per-file capture cost grows *linearly* with the
number of files already processed — 0.26 ms/file at file 100, 4.0 at 2,000, 8.6 at
4,000 — i.e. O(F) work per file, O(F²) total. That's the full-registry re-serialization
on every file (registerFile + setHeadVersion each `save()`). The laptop shows it as a
smooth ramp (fast RAM, no memory ceiling); the phone's constrained GC turns the same
O(F²) *allocation churn* into a cliff once the allocation rate saturates the collector
at ~3,200 files. So the cliff is the O(F²) registry churn — **not** raw cache size
(3,200 × 6 KB ≈ 19 MB is far too small for a memory wall). The `perfLog` line now carries
`heapMB=<used>/<limit>` to pin the GC ceiling on a future device run. **This whole
mechanism is why Layer 3 exists** (spec §4): the laptop's fast RAM hid the cliff entirely.

**Practical verdict (pre-fix):** first-enable of a multi-thousand-file vault was
effectively **unusable** on mobile — hours, and likely an OOM before completion. The fix
below removes the O(F²) churn; the on-device cliff should move far out (to re-confirm).

**Bugs this run surfaced (both real, one already fixed):**
- **Crash-unsafe capture — FIXED** (`fix(sync): checkpoint oplog during offline
  capture`). The registry advanced per-file but the oplog was persisted only at the
  end, so an OOM kill mid-capture stranded every registered-but-un-opped file (they
  skip re-capture and never sync). Now checkpointed every 200 ops.
- **Stale pending count** (same fix) — the status bar showed a stale "217 pending"
  during the multi-minute capture because the count only refreshed on the end-of-pass
  oplog write; the periodic checkpoint now keeps it live.

---

## The fix — capture batching (`captureOfflineChanges`)

Landed after the on-device run above; the post-fix B3/B5 tables reflect it. Three
coordinated changes to the first-enable capture, all preserving the data-safety
invariants (`sync-engineering-guide.md` §5/§7):

1. **Batch the registry write (the O(F²) killer).** `FileRegistry` gained a
   suspend/`flush()` batch mode; capture suspends the per-mutation autosave and persists
   the registry only at checkpoints, so it re-serializes O(F²/N) instead of O(F²/1). At
   M this is the **1.96 GB → 26.5 MB (74×)** drop, and `writesPerFile` 3.0 → 1.0.
2. **Checkpoint for crash-safety** (the prior commit). Registry-then-oplog every N=200
   ops, so an interrupted capture rolls back to a consistent checkpoint (files strand,
   recoverable — never orphan ops), instead of the registry running ahead of an
   end-only oplog write.
3. **Bound capture memory.** `clearMemCache()` at each checkpoint (every blob is already
   on disk), so the pass no longer holds the whole vault's content in RAM.

**Residual (future work):** `bytesWritten` is still gently superlinear — the periodic
flush re-serializes a growing registry (O(F²/N)). True O(F) needs an **append-only
registry journal** (the pattern the version-DAG store already uses). And the
*steady-state* round's `memCache` (B6) is still unbounded — a separate follow-up.

---

## The R1 fix — steady-state round stat-gate (`buildLocalState`)

Landed after the capture fix (headline finding #2, A1/B1;
`docs/steady-state-round-optimization-spec.md`). One change to
`PluginVaultSyncHost.buildLocalState()` (`src/network/vault-sync-host.ts`), preserving
every data-safety invariant (`sync-engineering-guide.md` §5/§7).

The redundancy: the coordinator runs `captureOfflineChanges` (the mtime/size drift
scan) milliseconds *before* every round, then `buildLocalState` unconditionally
re-read + re-SHA-256'd the whole live vault again. R1 extends the shipped capture gate
into the round — a live entry whose `mtime`/`size` still match `TFile.stat` is trusted
(`entry.contentHash`) and its bytes are staged straight from the content store
(memCache/blob hit, disk-read fallback on a store miss), with **no re-hash**. A
placeholder / head-less / stat-drifted / stat-absent entry falls through to the exact
prior read + hash + snapshot-correction path, so the F5 / un-opped-edit safeguards hold
up to the same heuristic capture already accepts.

**Layer-2 result (B1, `bench/run.ts` now profiles the real capture→round sequence).**
Per-round SHA-256 and vault reads go **flat in F** — the O(F·B) per-round cost is gone:

| Profile | sha256 before | sha256 after | fileReads before | fileReads after |
|---|--:|--:|--:|--:|
| XS (F=50)   | 51   | **2** | 50   | **1** |
| S (F=500)   | 501  | **2** | 500  | **1** |
| M (F=2000)  | 2001 | **2** | 2000 | **1** |

The residual `sha256 = 2` is the one edited file (hashed once by capture) plus the
push's blinded-blob hash — both O(touched), not O(F). The per-fold `buildLocalState`
rebuilds in `reconcileConcurrentHeads` (B7) inherit the same O(touched) drop for free.

**Layer 3 confirmed (native-ARM / Termux, Node v26.4.0).** B1 at the **L profile
(F=10000)** — the case that pre-fix hashed 10001 files and hung the on-device sweep at
**6590 ms** — verifies the gate fires on the device build (counts flat-in-F):

| B1 L (F=10000) | fileReads | sha256 |
|---|--:|--:|
| pre-R1 (native ARM) | 10000 | 10001 |
| post-R1 (native ARM) | **1** | **2** |

The accumulating SHA-256 cost A1/B1 named is gone. **Caveat on the wall time:** the
native-ARM run reported `roundMs` 6590 → 2346, but that L round is **not** the
steady-state round — see the correction below.

### Correction — B1 measured the wrong round (backlog drain, not steady state)

A phase decomposition of B1-at-L (runSync's built-in `PhaseTimer`) showed the
post-R1 round was **83% `pull`, having pulled 10000 ops**. That is not per-edit steady
state: we persist the *pull* cursor, not the append head (server-sync.ts:330), so a
device's own just-pushed ops re-pull once next round. B1 batch-creates F files and
converges in **one** round, leaving the cursor at 0, so the measured round drained the
whole **F-op backlog at once** — a one-time post-convergence cost R1 never targeted.

B1 now runs one **drain round** after convergence (advancing the cursor past the
backlog) before the measured edit, so `pull` drops to **0 ops**. The true steady-state
round:

| B1 roundMs | XS(50) | S(500) | M(2000) | L(10000) |
|---|--:|--:|--:|--:|
| backlog-drain artifact (L was ARM) | 21 | 129 | 190 | 2346 |
| **steady state, laptop** (pre-R3) | **3.8** | **9.9** | **18.3** | **122.5** |
| **steady state, laptop — post-R3** (1 DAG load/round) | **2.6** | **4.9** | **18.6** | **89.4** |
| **steady state, native ARM** (pre-R3) | — | — | — | **308** |
| **steady state, native ARM — post-R3** | — | — | — | **207** |

The **native-ARM L steady-state round is 308 ms** (Termux, drained B1) — not the
2346 ms the backlog artifact showed, and ~2.5× the laptop's 122 ms (in line with the
~3× ARM CPU penalty). Counts flat on-device: sha256=2, fileReads=1.

Phase split of the drained L round (118 ms laptop total): captureOfflineChanges
**30 ms** (O(F) stat scan) · buildLocalState **38 ms** (gated, no hashing) · DAG
load+`recordVersionEdges` **33 ms** (O(DAG)) · merge+apply **12 ms** · **pull 0.1 ms**.

**R3 landed (one DAG load per round, `docs/round-residual-optimization-spec.md` §3;
commits on `master`).** The round deserialized `version-dag.json` + replayed its
journal three times (`dagNeedsRebuild` + `buildLocalState` + `recordVersionEdges`);
it now loads once via `host.loadDag()` and threads the instance through all three
(`buildLocalState` folds this round's pending ops into a private `clone()`, so the
§3.1 journal-integrity trap can't bite). Layer-2 laptop B1 **L drops 122.5 → 89.4 ms**
(≈33 ms, the two removed load-equivalents at 10k nodes), M/S/XS flat-to-better, and the
device-independent counts are unchanged (`sha256=2`, `fileReads=1`) — pinned by
`__tests__/round-dag-load-dedup.test.ts`. **Native-ARM re-measure confirmed on device**
(Termux native Node v26, drained B1 L, `BENCH_ONLY=b1 BENCH_PROFILES=l`): **308 → 207 ms
(−33%)**, heap 28.5 MB, counts flat (`sha256=2`, `fileReads=1`) — the proportional fall
the laptop drop predicted (the DAG-load laps are pure CPU/parse; 207 ms is ~2.3× the
89.4 ms laptop, the same ~3× ARM penalty). The residual O(F) iteration (capture stat-scan
+ `buildLocalState` loop) and the *one* remaining DAG load are R4/R2′ territory —
deferred (§4/§7), not warranted yet.

**Residual + R2 (spec §4/§7, Phase 2 — CLOSED as not-warranted).** The decomposition
answers the R2 gate directly: `buildLocalState` is 38 ms of the 118 ms and its
byte-staging (the only thing R2 removes) is ~8 ms — R2 would trade a risky
merge-input-completeness change for ~7% of the round. Its spec trigger ("*O(F) reads
dominating*") is not met (reads = 1). What *does* remain is O(F) **iteration** (the
capture stat-scan + the buildLocalState loop) and O(DAG) **load** each round — neither
is what R2 addresses. **R2 is not pursued.** If the steady-state round is optimized
further, the targets are the capture/buildLocalState entry iteration and the per-round
DAG deserialization, not byte-staging.

> **Superseded on device — see "The A2 fix" below.** This "R2 not warranted" call
> measured byte-staging at ~8 ms *on the laptop with in-memory fake fs* (a Map hit). On
> the real Capacitor filesystem the same staging is thousands of file reads and was
> **52 s — 92% of a converged round** at F≈8388. A2 (essentially R2) was re-justified by
> the device numbers and **landed**.

---

## The A2 fix — scoped `buildLocalState` content-staging (on-device confirmed)

Landed on `master` (commits `7147e41`…`f5838c9`; `docs/build-local-state-perf-spec.md`).
R1 removed the per-round *re-hash*, but `buildLocalState` still **staged the bytes of
every live file** into the round's content map (plus each head's DAG-reachable bases).
A2 splits the host into `buildLocalIdentity` (before the pull: entries + the R1 hash
correction, **no** byte staging) and `stageContent(state, hashes)`, and moves staging
into the round *after* the pull, scoped to the files the merge reconciles + the pending
ops' own content (for the push). Enabled by dropping the dead `send_remote.content`.

**On-device (Obsidian WebView, Android, F≈8388 notes, `perfLog`), per-phase ms:**

| phase | first-ever sync | converged 2nd round |
|---|--:|--:|
| keycheck+dag-guard | 270 | 366 |
| **buildLocalIdentity** | **99** | **30** |
| pull | 274 | 2,474 |
| fetchBlobs | 1.4 | 3.4 |
| push | 94,487 | 0.3 |
| recordVersionEdges | 368 | 8.6 |
| **stageContent** | **5.8** | **5.7** |
| merge | 12 | 12 |
| applyMerge | 611 | 182 |
| reconcileConcurrentHeads | 1.0 | 3.8 |
| saveCursor | 63 | 50 |
| **total** | **96,192** | **3,136** |

**The converged round is the case A2 targeted.** It dropped from the spec's measured
**56,254 ms → 3,136 ms (~18×)**, and the staging work specifically from **~51,928 ms
(92% of the round) → 36 ms** (identity 30 + stage 5.7 — a ~1450× cut on that phase). The
round is now **pull-bound** (2,474 ms, 79%), exactly the floor
`build-local-state-perf-spec.md` §6 predicted. `stageContent = 5.7 ms` confirms a
converged round stages ~nothing.

**Why the laptop shelved this (R2) and the device revived it (A2).** The bench uses
in-memory fake fs, so byte-staging read as a Map hit (~8 ms) and looked not-worth-it. On
the device each staged byte is a real Capacitor filesystem read, so the same work was
52 s. This is the sharpest instance of the Layer-3 lesson (§4): a cost negligible on the
laptop can be 92% of the round on the phone — the fake fs hid it completely. Pinned by
`__tests__/scoped-content-staging.test.ts` (staging is O(touched), constant across vault
size).

**The first sync is push-bound, as expected.** 94.5 s of the 96 s first-ever sync is
`push` — the one-time baseline upload of the whole vault's blobs + ops (already batched,
`26af94b`/`b6230d2`); it does not recur. Note the first sync's identity is 99 ms and
staging 5.8 ms — the A2 phases are cheap even here.

**Next on-device target: startup capture (was 184 s).** The cold-start
`captureOfflineChanges` on this 8.4k-file vault (`startup … total heapMB=77/1940
184027.5ms`) dominated the whole session — bigger than either sync round. Post the O(F²)
batching fix it was no longer a *cliff* but still a long O(F) native-I/O pass. **This became
the A3 optimization series (`docs/startup-capture-optimization-spec.md`): instrument →
C2 (no-op) → C4 (direct write, −49%) → C1 next. Full breakdown + the per-call-latency finding
in "The A3 capture phase split" immediately below; status in "Still to do".** The append-only
registry journal / persisted-identity snapshot idea helps *subsequent* cold starts, not this
first-enable pass (nothing is persisted yet on first enable), so it is out of A3's scope.

### The A3 capture phase split — on-device, measured (`docs/startup-capture-optimization-spec.md` §3 step 1)

Instrumented `captureOfflineChanges` to return a read/hash/put split and re-ran a
**first-enable** (`.vault-sync/` deleted → empty registry, O1 gate never fires) on the same
Android WebView vault, F = **8389** files:

| phase | ms | share | per-file | what it is |
|---|--:|--:|--:|---|
| **readMs** | 36,214.8 | 18.2% | 4.32 ms | Σ `files.read` — one native fs read/file |
| **hashMs** | 1,335.3 | **0.67%** | 0.16 ms | Σ `hashContent` — SHA-256, the only pure-CPU phase |
| **putMs** | 147,522.1 | **74.2%** | 17.59 ms | Σ `contentStore.put` — `exists` stat + base64 encode + fs write |
| otherMs | 13,737.7 | 6.9% | 1.64 ms | registry flush + loop overhead |
| **total** | **198,809.9** | 100% | 23.70 ms | `heapMB=68/1940` |

**Hypothesis confirmed — the cost is fs-round-trip-bound, not CPU-bound.** Hashing (the only
CPU phase) is **0.67%**; `read + put` (native fs round-trips) are **92.4%**. `put` alone is
**74%** and is ~4× a `read` per file (17.6 ms vs 4.3 ms) — consistent with `put` doing **two**
round-trips (the `exists` stat + the write) plus a base64 encode, vs `read`'s one. (This run's
198.8 s vs the earlier 184 s is device variance; same order.)

**What the split decides** (spec §3.2): `readMs + putMs` dominate; `hashMs` negligible → no
hashing offload. The initial read of this pointed at C2 (drop the `exists` probe) + C1
(concurrency). **Both the C2 estimate and the C3 rationale turned out wrong on re-measure — see
below.**

### C2 landed and was a **no-op on device** — the `exists` probe was ~free

`ContentStore.putNew` (skips the fresh-store `exists` dedup) shipped; re-measured `putMs` was
**146.7 s** vs 147.5 s — flat within device noise. The "exists ≈ ⅓ of put" estimate was wrong:
Obsidian answers a cold negative existence check from an in-memory index (no byte I/O), so the
probe cost ~0. **Lesson (again): measure the sub-structure, don't estimate it.** C2 is harmless
and correct (keep it), just not a win.

### The `putMs` sub-split — the decisive measurement (rename ≈ write, both latency-bound)

Instrumented `MetadataStore.write`'s atomic ceremony (scoped to content blobs) + the base64
encode. Third first-enable run, F = 8389, `putMs` = **145,788 ms**:

| put sub-phase | ms | % of put | per-file | what it is |
|---|--:|--:|--:|---|
| **renameMs** | 65,588 | **45.0%** | 7.82 ms | `adapter.rename(tmp→target)` — **moves zero bytes** |
| **writeTmpMs** | 63,041 | **43.2%** | 7.51 ms | `adapter.write(tmp, data)` — the actual byte write |
| existsMs | 14,460 | 9.9% | 1.72 ms | `adapter.exists(target)` inside the ceremony |
| otherMs | 1,768 | 1.2% | 0.21 ms | ensureShard + memCache |
| encodeMs | 755 | **0.5%** | 0.09 ms | base64 encode |
| removeMs | 176 | 0.1% | 0.02 ms | `adapter.remove` (target rarely pre-exists) |

**The finding that settles the strategy: `rename` (7.82 ms/file) costs as much as the byte
`write` (7.51 ms) while transferring no data.** So every native fs call on the Android/Capacitor
bridge is ~pure latency (~2–8 ms), independent of payload — the cost is the *number* of native
calls, not their size. Consequences:

- **The atomic-write ceremony is 3 native calls (write-tmp + exists + rename); a direct write is
  1.** Eliminating exists + rename + remove = **~80 s of pure ceremony**, with the 63 s
  byte-write the only irreducible part. The ceremony is crash-safety the **disposable,
  hash-addressed** content store doesn't need (obtainable far cheaper via hash-verify-on-read →
  F1). **This is the primary cut (C4, direct blob write): putMs 146 s → ~65 s, total → ~120 s.**
- **C3 (raw-binary / drop base64) is dead.** `encodeMs` is 0.5 s and writes are latency- not
  bandwidth-bound (rename proves it), so a 1.33× smaller payload saves almost nothing. Dropped —
  not worth the port + adapter + on-disk-format change.
- **C1 (bounded concurrency) still compounds** — overlap the remaining ~99 s of serial
  read + direct-write round-trips; ~40–50 s total plausible at K=8.

Curiosity (doesn't change the plan): the `exists` C2 removed was ~free, yet `exists(target)`
*inside* `write` costs 1.72 ms — a cold negative lookup is cached, but the stat *after*
`write(tmp)` hits disk. The direct write deletes that expensive one too.

### C4 landed — on-device confirmed (`putMs` 146 s → 56 s, total 200 s → 102 s)

`MetadataStore.writeDirect` (a single non-atomic write; `ContentStore.putNew` uses it, made safe
by hash-verify-on-read in `get`) re-measured on the same first-enable, F=8389:

| phase | pre-C4 | **post-C4** | note |
|---|--:|--:|---|
| **putMs** | 145,788 | **55,767** | −90 s |
| — put.writeMs (direct) | — | 52,934 | the byte-write, now to target |
| — put.renameMs | 65,588 | **0** | ceremony gone |
| — put.existsMs | 14,460 | **0** | ceremony gone |
| — put.writeTmpMs | 63,041 | **0** | → `writeMs` |
| — put.encodeMs | 755 | 584 | base64 (0.6%) |
| readMs | 36,215 | 31,612 | faster run (device variance) |
| hashMs | 1,335 | 1,323 | — |
| otherMs | 13,738 | 13,540 | checkpoint atomic writes (registry + oplog) |
| **total** | ~199,000 | **102,242** | **−49%** |

Ceremony confirmed eliminated (`rename/exists/writeTmp` = 0). The remaining profile is now two
serial native-I/O phases — **write 55.8 s + read 31.6 s = 87 s** — plus **otherMs 13.5 s** (the
per-200-op registry+oplog checkpoints, which correctly *keep* the atomic write — durable
singletons). Both dominant phases are latency-bound serial round-trips → **C1 (bounded
concurrency)** was the hypothesised last lever: overlap the 87 s K-wide.

### C1 measured — concurrency REGRESSED; the bridge serializes fs (K defaulted to 1)

C1's bounded-concurrency scan (K=8) re-measured on the same first-enable, F=8389:

| phase | C4 serial | **C1 K=8** (Σ workers) | per-call | note |
|---|--:|--:|--:|---|
| readMs | 31,612 | **391,577** | 3.8 → 46.7 ms | inflated ~12× — see below |
| putMs | 55,767 | **459,804** | 6.6 → 54.8 ms | writeMs 436,647 of it |
| hashMs | 1,323 | 1,632 | — | CPU, unchanged |
| otherMs | 13,540 | −732,735 | — | negative-residual tell (Σ > wall) |
| **wall total** | **102,242** | **120,278** | | **+18 s REGRESSION** |

**The bridge does not parallelize native fs.** The 851 s of aggregate read+put "busy" crammed into
120 s wall is not parallelism — it is the *same serialized-bridge throughput* as C4, with each
worker's `await` clock inflated ~8–12× because it now spends most of its time **blocked waiting for
the other K−1 in-flight calls to drain through a single-threaded bridge** (the shared serial queue
double-counted across workers). Real parallelism would have driven wall *down* toward ~15–25 s; it
rose by 18 s (contention + per-chunk barrier + scheduling). **This settles the open A3 question and
is a load-bearing environment constraint: Android/Capacitor native fs is a serial resource — cut
call COUNT (batching), never call OVERLAP.** Same dead end as C3.

**Disposition:** the C1 pipeline was **reverted** — `captureOfflineChanges` is back to the serial
C4 loop (concurrency = complexity + risk for a measured regression). The finding is the deliverable.
The write half's next lever is **pack-writes** (A3 endgame step 3 — batch many blobs per native
write; parallelism-independent, so it works despite the serial bridge), targeting the ~56 s of
serial `put.writeMs`. Full analysis: `docs/capture-concurrency-spec.md` §7/§9.

### Pack-writes — append measured O(delta); write phase ~56 s → ~1.1 s (implemented)

The load-bearing unknown (does the bridge's `append` rewrite the whole file?) was measured FIRST
via an on-device micro-bench (`src/core/append-bench.ts`, "Measure append cost" command):

| probe | what | result |
|---|---|---|
| **A · growth** | append 4 KB × 200 to ONE file; per-append curve | **ratio 0.4** (last-Q 2.7 ms < first-Q 7.6 ms) → **`append` is O(delta)**, flat in file size |
| **B · baseline** | `writeDirect` 4 KB × 200 (status-quo loose) | **6.7 ms/call** → 8389 blobs ≈ **56 s** (matches measured `put.writeMs`) |
| **C · packed** | append one ~800 KB (200-blob) chunk × 42 (per-chunk pack) | **25.7 ms/chunk** → 42 chunks ≈ **1.08 s** |

So the capture **write phase collapses ~56 s → ~1.1 s** (+~0.6 s base64 encode). Nuance: a large
800 KB append is not pure latency (25.7 ms vs 4.2 ms for 4 KB — a real per-byte component at size),
but the call-count cut (42 vs 8389) dominates; small `index` appends are flat, so append-per-chunk
index was kept. **Implemented as per-chunk packs** (git loose-vs-packed): `putNew` buffers, `flushPack`
appends one pack + one index delta per 200-blob checkpoint, `get` falls back to a whole-pack read that
caches every blob it holds (reads stay constant in blob count), C4 hash-verify preserved per blob,
whole-pack retention GC. See `docs/pack-writes-spec.md` (Landed).

**On-device CONFIRMED (2026-07-24, F=8389):** total **102 s → 46 s (−55%)**. New split — readMs
**30.4 s** (floor), otherMs **12.1 s** (checkpoint rewrites), hashMs 1.2 s, and the whole write phase
**buffered putMs 0.8 s + flushMs 1.3 s ≈ 2.1 s** (was 50–56 s; `put.writeMs = 0` → zero per-blob
writes). `flushMs 1.3 s` == probe C (1.08 s + index) — the pre-build measurement predicted it exactly.
The write half is done; next-dominant is the read floor (30.4 s, deferred) and the checkpoint
`otherMs` (12.1 s of per-200-op registry+oplog atomic rewrites → append-only-oplog-journal spec).

### Read-path probe — `cachedRead` vs `readBinary` (measured; a modest, deferred win)

The read phase (~31.6 s, 31%) is all `vault.readBinary` (disk). Hypothesis: since Obsidian reads
every markdown file on startup to build its metadata cache, `vault.cachedRead` might serve content
from a warm in-memory cache by the time capture runs. A/B diagnostic measured **both** paths per
file in one first-enable run (cachedRead+encode timed first, then readBinary; bytes compared), F=8389:

| metric | value | note |
|---|--:|---|
| read.mismatches | **0** | `encode(cachedRead)` byte-identical to disk across all 8016 md files — **hash-safe** |
| read.cachedMs (8016 md) | 22,374 | 2.79 ms/file |
| read.binaryMs (8016 md + 373 bin) | 31,721 | 3.78 ms/file avg |
| read.binOnly (attachments) | 373 | stay on `readBinary` (cachedRead would corrupt binary) |

**Isolating markdown: cachedRead 22.4 s vs ~30.3 s readBinary → ~8 s / ~25% off reads** (read phase
~31.6 → ~24 s; total ~102 → ~94 s, ~8%). **Byte-safe** (0 mismatches).

**The hypothesis was half-wrong, and that's the durable finding:** 2.79 ms/file is still
**disk-read territory, not memory** — a warm-content-cache hit would be microseconds. Obsidian's
metadata cache holds *parsed metadata* (links/tags/headings), **not raw file content**, so on a
cold first-enable `cachedRead` still hits the filesystem; the ~25% is just a lighter read path
(cached string vs binary ArrayBuffer marshalling), not a warm cache. So **reads are a ~24–31 s floor**
even with cachedRead — there is no large read win to be had on first-enable.

**Disposition: deferred, diagnostic reverted.** ~8 s for a one-time cost, and `cachedRead` adds a
cache-coherence dependency (can return content Obsidian hasn't re-read after an unprocessed
`modify`) to a data-safety tool — not worth it now relative to pack-writes' ~50 s. If revisited, wire
cachedRead **capture-path-only** (keep the sync round on fresh `readBinary`). The A/B instrumentation
was removed after this measurement.

### The oplog append-journal — on-device confirmed (`oplogSaveMs` 5.37 s → 1.25 s; the append write 3.82 s → 0.21 s)

With pack-writes solving the blob-write half, the residual **otherMs 12.1 s** was the per-200-op
checkpoint metadata rewrites: `registry.flush()` **+** `saveOpLog()`. The Step-1 split (above /
`docs/oplog-append-journal-spec.md` §3.3) attributed it near-evenly — **reg 5.73 s, oplog 5.37 s** —
with **~86% of each being the native write**, not the serialize. The oplog half was the clean,
ready-to-land cut: `saveOpLog` re-serialized + re-wrote the **whole** growing `pendingOps` array every
checkpoint (200, 400, … 8389 ops) → **triangular O(N²)** bytes over the pass. The fix
(`docs/oplog-append-journal-spec.md` §4, landed): make `oplog.json` a **line-oriented NDJSON journal**
and **append only the delta ops** since the last checkpoint (`metadata.append`), mirroring pack-writes'
per-chunk append — O(delta), not O(N²). The two rare shrink events (`clearOps`, create/delete-pair
prune) keep a full rewrite; `load()` replays the journal line-by-line, dropping a torn trailing line.

**On-device re-measure (2026-07-24, same first-enable, F=8389, `perfLog`):**

| oplog line | Step-1 (rewrite) | **Step-2 (append)** | Δ |
|---|--:|--:|--:|
| **oplogSaveMs** (whole persist, ×~42 checkpoints) | 5,371.9 | **1,247.1** | **−77%** |
| — `oplog.stringifyMs` (serialize) | 576.5 | **20.8** | −96% (only the delta ops serialized) |
| — `oplog.writeMs` (native write/append) | 3,823.2 | **208.9** | **−18×** (only the delta *bytes* appended) |
| — residual (dir-`exists` + `hlcStore.save` + notify) | ~971 | ~1,017 | ~flat — the **new floor** |
| regFlushMs (registry half — **untouched**) | 5,730.3 | 5,760.2 | unchanged |
| **otherMs** | 12,122.4 | **8,047.8** | −34% |
| **total** (heap 68/1940 MB) | 46,850.0 | **37,724.3** | (readMs also −5 s this run — floor variance) |

**The O(N²)→O(delta) cut landed exactly as predicted.** The append-specific work (stringify + write)
collapsed **4.40 s → 0.23 s (~19×)**; `oplog.writeMs` alone did the predicted **3.82 s → 0.21 s (~18×)**.
`oplogSaveMs` is 1.25 s rather than "well under 1 s" only because **~1.0 s of it is now the per-checkpoint
`hlcStore.save` (an atomic small-file write) + dir-`exists` probe + change-notify** — a fixed
~24 ms × ~42 checkpoints that lived inside `saveOpLog` all along (Step-1's "residual 1.0 s") and is
untouched by this spec. A possible micro-follow-up (persist the HLC once at end / cache the dir-exists)
would reclaim it, but it is small against the read floor — noted, not pursued.

**What this leaves as the next lever.** `regFlushMs` is **unchanged at 5.76 s** (the registry rewrite was
not touched) and is now **72% of the 8.05 s otherMs** (was 47% of 12.1 s). So the **registry-checkpoint
rewrite is the unambiguous next cut** — its own spec (below). Pinned by
`__tests__/oplog-append-journal.test.ts` (round-trip, O(delta) linearity guard, torn-tail, clearOps-truncate,
prune-compaction). *(The design memo's provisional option A — raise the flush cadence — was superseded:
the chosen fix was **option B, an append-journal mirroring the oplog**, which attacks the byte volume
itself rather than the write frequency. See the next section.)*

### The registry append-journal — on-device confirmed (`regFlushMs` 5.76 s → 0.34 s; the registry is no longer a lever)

The registry half of `otherMs` was the twin of the oplog problem, one step harder: the registry is a
**keyed map mutated in place** (not a pure append), sits on the crash-safety spine (registry-before-oplog),
and is the rebaseline anchor. The design memo (`docs/registry-checkpoint-cost-spec.md`) weighed three
directions and **graduated to option B — a keyed append-journal, last-write-wins + snapshot compaction** —
sharpened by three code findings that shrank its cost: it is a **persistence-layer-only** change (nothing
outside `file-registry.ts` reads the registry file, so every consumer reads the same in-memory `Map` and is
untouched as long as `load()` rebuilds it identically), the pattern already ships twice in-repo
(`ContentStore.pack/index`, the version-DAG journal), and the `append`/atomic-`write` primitives are
purpose-built. The rollout spec `docs/registry-append-journal-spec.md` (**landed**): `flush()` **appends
only the touched entries** to `file-registry.journal` (full-entry line = LWW upsert, `{"del":id}` line =
hard Map-delete) instead of rewriting the whole snapshot; `load()` replays the journal over the snapshot
(torn-tail-tolerant); `compact()` folds it back (snapshot-write-**then**-truncate, both atomic) at
capture-end / merge-end / opportunistically-on-load / a live-path size-valve — **never at a checkpoint**, so
the O(N²) rewrite can't sneak back in.

**On-device re-measure (2026-07-25, same first-enable, F=8389, `perfLog`):**

| line | oplog-run (Step-2) | **registry-run (Step-3)** | Δ |
|---|--:|--:|--:|
| **regFlushMs** (registry persist, ×~42 checkpoints) | 5,760.2 | **336.3** | **−94% (~17×)** |
| — `reg.stringifyMs` (serialize) | ~780 | **29.1** | only the touched delta serialized |
| — `reg.writeMs` (native write/append) | ~4,860 | **227.7** | only the delta *bytes* appended (O(delta)) |
| oplogSaveMs (untouched) | 1,247.1 | 1,232.4 | unchanged |
| otherResidualMs | ~1,017 | 1,009.4 | ~flat — the standing floor |
| **otherMs** | 8,047.8 | **2,578.1** | **−68%** |
| readMs (floor) | ~26,000 | 27,782.0 | floor variance |
| hashMs / putMs / flushMs | — | 1,213 / 836 / 1,232 | write phase, all small |
| **total** (heap 68/1940 MB) | 37,724.3 | **33,641.2** | −4.1 s (read variance offsets part of the −5.5 s otherMs cut) |

**The O(N)→O(delta) cut landed as predicted, and beat the < 1 s target by 3×.** `regFlushMs` fell to
**336 ms** — `reg.writeMs` 4.86 s → 0.23 s and `reg.stringifyMs` 0.78 s → 0.03 s: the per-checkpoint appends
are near-free versus the old triangular whole-registry write. The capture-end `compact()` (one full snapshot
write, ~0.2 s) runs in the `finally` **after** `stats.totalMs` is stamped, so it is off the hot path and
excluded from the reported total — exactly the off-checkpoint placement the spec intended.

**Both write-side O(N²) checkpoint costs are now solved.** `otherMs` is down to **2.58 s** — its remaining
pieces are `oplogSaveMs` 1.23 s (the per-checkpoint `hlcStore.save` + dir-probe floor, *not* the append —
the standing micro-follow-up), residual 1.0 s, and `regFlushMs` 0.34 s. **`readMs` 27.8 s is now ~83% of the
33.6 s total** — the read floor overwhelmingly dominates, and per the A3 read-probe above it is a genuine
disk-bound floor (deferred: cachedRead was only ~25% cheaper with a cache-coherence risk). Pinned by
`__tests__/registry-append-journal.test.ts` (round-trip, LWW, hard-delete `{del}` line, intra-window 1-line
collapse, torn-tail, compaction + no-pretty-print, crash-order idempotent replay, migration, opportunistic
load-compact), the §4-Q3 durability gate in `__tests__/capture-crash-safety.test.ts` (registry-ahead-not-
orphaned; torn-registry-journal strands-not-orphans), and the O(delta) append-volume guard in
`__tests__/perf-timing.test.ts`.

---

## Judged against the provisional budgets (spec §6)

These budgets are for the **Layer-3 mobile** numbers. Only first-enable capture has a
recorded device run so far (above); the other rows still show the Layer-1 laptop time
as a *hypothesis* for the on-device pass to confirm.

| Operation | Budget (mid-range) | Laptop L1 (M) | On phone |
|---|---|--:|---|
| routine sync (1-file delta) | < 1 s | 153 ms | **converged round measured on device: 3.1 s at F≈8388, pull-bound** (2.5 s pull); the round's *compute* is now sub-second — buildLocalIdentity 30 ms + stage 5.7 ms + merge/apply ~200 ms. Over budget only because of the 8.4k-op backlog pull, not the delta. See "The A2 fix" |
| first-enable capture | < 4 s | 4.2 s → **0.26 s** post-fix | pre-fix: CONFIRMED over (cliff at ~3.2k files). Post-fix removes the O(F²) churn — re-confirm on device |
| resident RAM, long session | not monotonic | +8.1 MB/50 rounds | **fails the qualitative bar** (monotonic; the on-device cliff is consistent with the same unbounded cache) |

---

## Native-ARM (Termux) full sweep — on-device CPU/heap

The Layer-3 section above is a *partial* WebView run (first-enable capture only). This
is the complement: the **whole B1–B9 sweep**, run on the phone's real ARM cores via
**Termux native Node** — so it captures the genuine mobile CPU and heap for every
scenario at once, unattended, in ~3 minutes. It is the fastest way we have to get a
real-silicon number for the *algorithms*.

| | |
|---|---|
| Commit | current branch HEAD (post-`b5d1204` — B7 shows the bg-vault variant) |
| Machine-readable | `bench/results/2026-07-23_termux-arm_xs-s-m.json` |
| Host | Android phone, **Termux native Node v26 (ARM64)** — *not* the Obsidian WebView |
| fs | in-memory fakes (Maps) — **not** the Capacitor filesystem |
| Runtime | 189 s, profiles XS/S/M, K-sweep `[20,50]` (no `BENCH_FULL`) |

**What this is and isn't (read before trusting a number):** native Node V8 on the phone
is *close to but not* the Obsidian WebView (Android's WebView is also V8 but runs under
app memory caps + lifecycle throttling; iOS is JavaScriptCore, untestable via Termux).
And fs is the in-memory fakes, so **Capacitor filesystem latency is not measured here** —
that is still the WebView Layer-3 pass's job. So treat every wall-time below as a **floor
for the WebView, CPU-only**: the real in-app figure is this, plus the WebView tax, plus
real fs. Its value is the *ratio* it pins (below) and the two CPU cliffs it exposes.

**The ~3× hardware penalty is confirmed on real silicon.** Across the paths whose code is
unchanged between the laptop `post-capture-fix` baseline and this run — B1, B3, B4, B9 —
the phone lands at a consistent **2.4–3.7×** the laptop wall-time. §4 hypothesised
"~3–5× slower single-thread" for mobile; the native-ARM half of that is now measured, not
assumed. (Ignore B2/B2b for this ratio: the laptop baseline above predates the
reconcile-spin fix, so its B2 rows time the old 62×-slower spin — on this HEAD the phone
does B2 K=50 in **711 ms**, not a regression.)

### Phone absolute wall-times vs the §6 budgets (native ARM, CPU-only floor)
| Operation | Phone | §6 budget | verdict |
|---|--:|---|---|
| B1 routine sync, S (500) | 121 ms | < 400 ms | **passes** |
| B1 routine sync, M (2000) | 484 ms | < 1 s | **passes** (WebView + real fs could push M to the line) |
| B3 first-enable, S | 125 ms | < 1 s | **passes** |
| B3 first-enable, M | 914 ms | < 4 s | **passes** — the capture-batching fix holds on device (B5 M: 27 MB, writesPerFile 1.0, matching the laptop post-fix) |
| B4 cold pull, H≈1020 | 173 ms | < 5 s | **passes** |

### The two CPU cliffs the sweep exposes
1. **diff3 low-unique O(L²) is a multi-second UI freeze (B8, A8).** On the phone a
   repetitive/low-unique file merges at **4,000 lines → 2.38 s**, **8,000 lines →
   6.72 s** (5–7.6× the laptop). A normal unique-line 1 MB file is fine (**226 ms**). This
   is the most concrete "would actually hurt a user" result: a single generated/tabular
   file merge stalls the mobile UI for seconds.
2. **The unbounded `memCache` grows on-device too (B6, A3).** Post-GC retained heap over
   50 rounds: XS **+0.5 MB**, S **+2.3 MB**, M **+8.3 MB** (RSS flat/negative → it's live
   heap, the never-cleared steady-state cache). Slow at these sizes, but monotonic — the
   one hard qualitative bar, confirmed broken on the real device.

### B7 (bg-vault) on-device
The per-fold `buildLocalState` rebuild, now measured with a 200-file background vault:
C=3 → **862 ms**, C=5 → **949 ms**, C=10 → **1,366 ms**. Real on mobile, but
wide-concurrency stays rare — the §9 gate on shipping the fold optimization holds.

**Bottom line from the phone:** the *routine* paths (B1/B3/B4) pass their budgets even
with the ~3× ARM penalty — the capture and DAG fixes already landed are doing their job.
The two remaining CPU hazards are the **diff3 low-unique cliff** (a real, seconds-long
freeze) and the **steady-state `memCache`** (slow monotonic growth). Neither is fs-bound,
so both would reproduce in the WebView.

---

## The multi-head reconcile O(N²) — on-device confirmed (`reconcile:precheck` 29.6 s → 23 ms; round 36.6 s → 7.8 s)

Once the write side was solved, a **first sync that pulls a peer op for each of many files** exposed a
second-order cliff in `reconcileConcurrentHeads` (step 4b) — invisible on the laptop's fast RAM, dominant on
device. A device that had its `.vault-sync/` state wiped and re-pushed (so the server accumulated repeated
whole-vault op sets under fresh ids) re-pulled the **entire ~67,104-op log** in one round (server totals for
this vault: **67,104 ops · 8,356 blobs · 22.3 MiB** — the 8,356 blobs are the vault's real ~8.4k unique files;
the 67k ops are the accumulated wipe-generations). Of the pulled ops, **16,776 distinct fileIds** were touched
by *peer* ops (the `reconcile:touchedFiles` metric — a fileId count, **not** an op count). The reconcile lap
ran **29.6 s** with **zero** files actually multi-head and **zero** folds. The new per-phase `reconcile:*`
instrumentation (perfLog, gated, fires only on a round that pulled peer ops) pinned it precisely:

| `reconcile:*` line | before | after | note |
|---|--:|--:|---|
| `touchedFiles` (count) | 16,776 | 16,776 | files a peer touched this round |
| `multiHeadFiles` (count) | 0 | 0 | none genuinely divergent — nothing to fold |
| `folds` (count) | 0 | 0 | — |
| **`precheck`** | **29,586 ms** | **23 ms** | the whole cost |
| `reconcileConcurrentHeads` (lap) | 29,601 ms | **47 ms** | — |
| **round total** | **36,597 ms** | **7,821 ms** | **4.7×** |

**Two independent O(N²) shapes, both fixed:**

1. **The pre-check** (the on-device 29.6 s). It called `VersionDag.leaves(fileId)` **once per touched file**,
   and each `leaves()` rebuilds the whole child-set with a full graph scan of **every DAG node** — so the "is
   anything multi-head?" check was **O(touched files · nodes)** = 16,776 touched × ~67,104 nodes ≈ **1.1·10⁹**
   node-visits (the DAG holds one node per op). Worse, since *no* file was multi-head
   the production `.some()` never short-circuited. Fixed with a new `VersionDag.leavesByFile()` that resolves
   **every** file's leaves in **one O(nodes) pass**, then an O(1) lookup per touched file. `leaves()` is now
   called **zero** times on this path (pinned by `__tests__/reconcile-multihead-rebuild-perf.test.ts`).
2. **The fold loop** rebuilt the **whole-vault** `buildLocalIdentity` **once per fold** and `break`ed after a
   single file — O(folds·vault) when history genuinely interleaves. Fixed by folding **every** foldable file
   per pass (each fileId is independent), turning O(folds) rebuilds into O(passes) (≈ max concurrent leaves,
   normally 1). Unit-proven 23 → 4 rebuilds at N=20 (same test); the device run above had 0 folds so this half
   is not separately isolated on device. See `docs/multi-head-reconciliation.md` §3.

## Pull and push are the remaining levers (network-bound, and we have the concurrency pattern already)

With reconcile fixed, the 7.8 s round is now **almost entirely the wire**, and these are the standing
optimization candidates — flagged here because, unlike the read-floor above, **there is a concrete lever**:

| phase | this round | share | shape / lever |
|---|--:|--:|---|
| **pull** | 4,895 ms | 63% | `pullAll` fetches op pages **serially** (`await pullOps` per page) and decrypts **each op serially** in a loop (`await decryptOp`) — here **~67,104 ops**, ≈73 µs/op. Fully sequential — no worker pool. |
| **push** | 1,343 ms | 17% | blob upload already overlaps via `blobUploadConcurrency`; the **op-append** (`POST /ops`, chunked by `maxOpsPerAppend`) is still issued **serially**. |
| fetchBlobs | 789 ms | 10% | already concurrent (`blobDownloadConcurrency` worker pool) + 3-tier already-held skip. |
| everything else | ~800 ms | 10% | buildLocalIdentity / recordVersionEdges / stage / merge / applyMerge / reconcile — all sub-second. |

**The lever is the bounded-worker-pool pattern already shipping on the blob paths** (`fetchRemoteBlobs`,
blob upload — `blobDownloadConcurrency`/`blobUploadConcurrency`, default 8). Pull has *no* equivalent: its
per-op AES-GCM decrypt is CPU-bound and serial, and its page fetch is latency-bound and serial. Applying the
same pattern — overlap page prefetch with decrypt, and/or a bounded decrypt pool — plus overlapping the
op-append chunks in push, is the obvious next cut.

**Crucially, this is NOT the C1 case.** C1's capture-side concurrency *regressed* because the Android/Capacitor
bridge **serializes native fs**, so overlap couldn't win. Pull and push are **network** round-trips
(`requestUrl`/HTTP), where the blob pools already prove concurrency *does* win on device — so the lever is
expected to pay off here, exactly where it didn't for local fs.

**Caveat on the absolute numbers:** the ~67,104-op log (vs the vault's 8,356 real files ≈ 8× duplication) is
inflated by the wipe-and-re-push test methodology — each wipe of `.vault-sync/` regenerates fresh fileIds for
every file and re-pushes them, so the server accumulates whole-vault op sets under new ids (that is also why
`touchedFiles` is 16,776, not the op count). A real vault syncs a single op set, and a steady-state round
pulls only new ops — so pull's *absolute* cost is smaller in practice, but its **serial O(ops) structure** is
the real, general lever regardless of the count (a genuine ~8.4k-file first sync still decrypts ~8.4k+ ops
one-at-a-time).

---

## Still to do (spec §9)

- [ ] **Pull/push concurrency (the network lever)** — pull decrypts ops **serially** and fetches pages
      **serially**; push appends op chunks **serially**. Apply the bounded-worker-pool pattern already proven
      on the blob paths (`blobDownloadConcurrency`/`blobUploadConcurrency`) — a decrypt pool + page-prefetch
      overlap for pull, chunk overlap for push. Network round-trips, so (unlike C1's local-fs case) concurrency
      is expected to win. See "Pull and push are the remaining levers" above.
- [x] **Multi-head reconcile O(N²)** — `leavesByFile()` single-pass pre-check (O(files·nodes) → O(nodes),
      **29.6 s → 23 ms on device**) + batched-pass folding (O(folds) → O(passes) rebuilds). Round **36.6 s →
      7.8 s**. See "The multi-head reconcile O(N²)" above.
- [x] **First on-device run** — B3 first-enable capture, ~8.4k-file Android vault
      (recorded above; found the ~3.2k-file cliff + two capture bugs).
- [x] **Confirm the cliff's cause** — Node probe: per-file cost is linear in F
      (O(F²) registry re-serialization), turned into a GC cliff on-device.
- [x] **Fix the O(F²) capture** — registry batching + memCache clearing (74× fewer
      bytes at M); crash-safety checkpointing.
- [x] **Fix the O(F·B) steady-state round (R1, A1/B1)** — mtime/size gate in
      `buildLocalState`; B1 sha256 F+1 → 2, fileReads F → 1, counts flat-in-F confirmed
      native-ARM. Decomposition closed R2 as not-warranted and found B1 was measuring the
      post-convergence backlog-drain round, not steady state (now drained; see "The R1
      fix" above). Steady-state native-ARM L round = **308 ms** (Termux), not the 2346 ms
      artifact. Fully recorded.
- [x] **Native-ARM (Termux) full sweep** — B1–B9 at XS/S/M on the phone's real cores
      (recorded above; ~3× CPU penalty confirmed, routine budgets pass, diff3 low-unique
      + steady-state memCache flagged as the CPU hazards).
- [x] **A2 scoped `buildLocalState` staging — on-device confirmed.** WebView, F≈8388:
      converged round **56.3 s → 3.1 s**, staging **52 s → 36 ms**; now pull-bound. The
      laptop's "R2 not warranted" (~8 ms on fake fs) was overturned by the real fs (52 s).
      See "The A2 fix" above.
- [~] **Startup `captureOfflineChanges` — A3 optimization, in progress** (`docs/startup-capture-
      optimization-spec.md`, then `docs/capture-concurrency-spec.md`). 8.4k-file WebView vault,
      first-enable:
  - [x] **Instrument** the read/hash/put split, then the `putMs` sub-split (see "The A3 capture
        phase split" above). Found the cost is native-fs-**call-count**-bound (rename ≈ write
        despite moving 0 bytes), not CPU or payload.
  - [x] **C2** (skip the fresh-store `exists` dedup) — **no-op on device** (exists is ~free); kept.
  - [x] **C4** (direct non-atomic blob write, replacing the atomic temp+rename ceremony; safe via
        hash-verify-on-read) — **200 s → 102 s (−49%)**, `putMs` 146 s → 56 s. Confirmed on device.
  - [x] **C3** (raw-binary / drop base64) — **dropped**; writes are latency- not bandwidth-bound.
  - [x] **C1** (bounded-concurrency capture pipeline) — **MEASURED + REVERTED.** K=8 = 120 s vs C4's
        102 s (+18 s): the Android/Capacitor bridge serializes native fs, so overlap can't win — cut
        call COUNT, not overlap. See "C1 measured" above + `docs/capture-concurrency-spec.md`.
  - [x] **Pack-writes** (batch blobs into per-chunk packs — parallelism-independent) — **DONE + CONFIRMED.**
        Write phase 50–56 s → ~2.1 s; total **102 s → 46 s (−55%)**. See "Pack-writes" above.
  - [x] **Oplog append-journal** (NDJSON, append the delta not the whole array) — **DONE + CONFIRMED.**
        `oplogSaveMs` 5.37 s → 1.25 s (the append write 3.82 s → 0.21 s, ~18×); otherMs 12.1 s → 8.05 s;
        total 46.85 s → 37.72 s. See "The oplog append-journal" above.
  - [x] **Registry append-journal** (keyed NDJSON journal + snapshot compaction — the design memo's option
        B, superseding the provisional option A) — **DONE + CONFIRMED.** `regFlushMs` 5.76 s → **0.34 s
        (~17×, beat the < 1 s target)**; otherMs 8.05 s → **2.58 s**; total 37.72 s → **33.64 s**. Both
        write-side O(N²) checkpoint costs now solved. See "The registry append-journal" above.
  - **Write side is done.** `readMs` (27.8 s ≈ 83% of the 33.6 s total) is now the whole remaining
    first-enable cost — a genuine disk-bound floor (the A3 read-probe's ~25% cachedRead win is deferred for
    cache-coherence risk). The only sub-second scraps left are the `oplogSaveMs` per-checkpoint HLC/dir floor
    (~1 s) and loop residual (~1 s); neither is worth pursuing against the read floor.
- [ ] **Re-confirm the cliff is gone on device** — DONE in substance: the 8.4k-file vault now completes
      first-enable in **33.6 s** with `heapMB=68/1940` (no GC cliff, no OOM); the O(F²) churn that caused
      the original ~3.2k-file cliff is fully removed (registry + oplog + blob writes all O(delta)).
- [ ] **Full Layer-3 matrix** — B1/B3/B4 at profiles S and M on a mid-range and a
      low-end phone, record device model + real wall-times (add device columns).
- [ ] Re-run and append a new baseline before each release and after any change to the
      sync round, the DAG, persistence, or the merge.
