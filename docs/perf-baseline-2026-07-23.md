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
| Commit | `530b330` (baseline code unchanged for perf; this run is on the instrumentation branch) |
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

1. **First-enable of a large vault rewrites the whole registry per file → O(F²) bytes
   (A4, B3/B5).** Capturing a 2000-file vault wrote **1.96 GB** to disk (500 files:
   124 MB; 50 files: 1.4 MB) — the classic O(F²) curve (10× files ⇒ ~90× bytes). Each
   logical registry write is ~3 fs syscalls (atomic temp+remove+rename), so M issues
   **~18,000 metadata syscalls** on first enable. On phone flash this is the single
   most alarming result: latency **and** flash wear. `writesPerFile ≈ 3` is flat
   across sizes — the per-mutation full-registry rewrite is the driver.

2. **Every routine round re-reads + re-SHA-256s the whole live vault (A1, B1).** A
   **1-file** edit round hashed **F+1** files and issued **F** vault reads (M: 2001
   hashes, 2000 reads for a one-file change). Round cost is O(F·B), independent of the
   delta — the dominant per-round cost as a vault grows.

3. **VersionDAG walks scale with per-file history depth (A2/A6, B2).** A merge round
   against a peer with deep lineage did **20,440** `reachableContentHashes` walks and
   **21,522** SHA-256s at K=50 (H≈1000) — and the Layer-1 round took **4.3 s** on the
   *laptop*. `mergeBase`/`isAncestor` are un-memoized and recomputed per differing
   file; the cost climbs steeply with history.

4. **`ContentStore.memCache` grows unbounded across a session (A3, B6).** Post-GC heap
   climbed monotonically with rounds — +8.1 MB over 50 rounds at M, and it is *not*
   reclaimed by GC (the cache holds live references). `clearMemCache()` exists but is
   never called. Over a long mobile session this trends toward total distinct content
   in RAM — a crash risk regardless of the absolute number (spec §6's one hard bar:
   "not monotonically growing").

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

### B3 — cold startup vs F (`captureOfflineChanges`)
| profile | sha256 | fileReads | metaWrites | registryBytes | fsSyscalls² | captureMs¹ |
|---|--:|--:|--:|--:|--:|--:|
| XS (F=50) | 50 | 50 | 152 | 1,389,518 | 456 | 6.7 |
| S (F=500) | 500 | 500 | 1,502 | 124,244,172 | 4,506 | 285 |
| M (F=2000) | 2,000 | 2,000 | 6,002 | **1,959,351,836** | 18,006 | 4,201 |

### B4 — cold pull / DAG rebuild vs H
| variant | aesDecrypt | sha256 | metaWrites | coldPullMs¹ | heapMB¹ |
|---|--:|--:|--:|--:|--:|
| join H≈420 | 441 | 61 | 43 | 25.5 | 10.6 |
| join H≈1020 | 1,041 | 61 | 44 | 56.5 | 23.5 |

### B5 — write amplification per batch capture (L2 only)
| profile | metaWrites | fsSyscalls² | bytesWritten | writesPerFile |
|---|--:|--:|--:|--:|
| XS (F=50) | 152 | 456 | 1,389,518 | 3.0 |
| S (F=500) | 1,502 | 4,506 | 124,244,172 | 3.0 |
| M (F=2000) | 6,002 | 18,006 | 1,959,351,836 | 3.0 |

_The DAG journal is the one delta-sized writer (`metaAppends`); the registry+oplog full
rewrites dominate `bytesWritten` at O(F²)._

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
curve; the *device* is ~flat until ~3,200 files, then a **60–130× cliff**. A flat
region followed by a sudden explosion is the signature of a **memory / GC wall**
(the unbounded `ContentStore.memCache` — B6 — plus the growing in-memory `pendingOps`/
registry filling the WebView heap), not the steady O(F²) registry rewrite. The laptop's
fast RAM and fs hid it entirely — **the whole reason Layer 3 exists** (spec §4). The
`perfLog` line now carries `heapMB=<used>/<limit>`; the next run will confirm whether
the cliff coincides with the heap nearing its ceiling (memory) or is a Capacitor
directory-scaling wall (`.vault-sync/content/` crossing a few thousand files).

**Practical verdict:** first-enable of a multi-thousand-file vault is effectively
**unusable** on mobile today — hours, and likely an OOM before completion.

**Bugs this run surfaced (both real, one already fixed):**
- **Crash-unsafe capture — FIXED** (`fix(sync): checkpoint oplog during offline
  capture`). The registry advanced per-file but the oplog was persisted only at the
  end, so an OOM kill mid-capture stranded every registered-but-un-opped file (they
  skip re-capture and never sync). Now checkpointed every 200 ops.
- **Stale pending count** (same fix) — the status bar showed a stale "217 pending"
  during the multi-minute capture because the count only refreshed on the end-of-pass
  oplog write; the periodic checkpoint now keeps it live.

---

## Judged against the provisional budgets (spec §6)

These budgets are for the **Layer-3 mobile** numbers. Only first-enable capture has a
recorded device run so far (above); the other rows still show the Layer-1 laptop time
as a *hypothesis* for the on-device pass to confirm.

| Operation | Budget (mid-range) | Laptop L1 (M) | On phone |
|---|---|--:|---|
| routine sync (1-file delta) | < 1 s | 153 ms | not yet measured (plausibly over on M once fs latency is real) |
| first-enable capture | < 4 s | 4.2 s | **CONFIRMED over** — ~4 ms/file to ~3.2k files, then a 60–130× cliff; an 8.4k-vault never completes |
| resident RAM, long session | not monotonic | +8.1 MB/50 rounds | **fails the qualitative bar** (monotonic; the on-device cliff is consistent with the same unbounded cache) |

---

## Still to do (spec §9)

- [x] **First on-device run** — B3 first-enable capture, ~8.4k-file Android vault
      (recorded above; found the ~3.2k-file cliff + two capture bugs).
- [ ] **Confirm the cliff's cause** — re-run with the `heapMB=used/limit` progress
      line at a completing size (profile M) to prove memory-pressure vs a Capacitor
      directory wall.
- [ ] **Full Layer-3 matrix** — B1/B3/B4 at profiles S and M on a mid-range and a
      low-end phone, record device model + real wall-times (add device columns).
- [ ] Re-run and append a new baseline before each release and after any change to the
      sync round, the DAG, persistence, or the merge.
