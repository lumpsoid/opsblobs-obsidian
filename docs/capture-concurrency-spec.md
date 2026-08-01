# Vault Sync — First-Enable Capture Concurrency Spec (C1)

**Status:** Implemented, measured, and **REVERTED** — the on-device re-measure REGRESSED
(102 s → 120 s: the Android/Capacitor fs bridge does not parallelize). The concurrency code was
removed; `captureOfflineChanges` is back to the serial C4 loop. This doc is retained as the
**decision-of-record + environment evidence** (§7). · **Date:** 2026-07-24 · **Owner:**
client/perf · **Next lever: pack-writes** (§7.2), not concurrency.

**One sentence:** the first-enable `captureOfflineChanges` pass is now a serial chain of
~17,000 latency-bound native fs round-trips (read + write, one file at a time); this spec
overlaps them with a bounded worker pool so wall time falls toward `serial / K`, while every
ordering / crash-safety invariant stays in a single-writer serial consumer.

This document is written to be picked up **cold**, with no prior conversation context.

**Parent / companions:** `docs/startup-capture-optimization-spec.md` (A3 — the umbrella; C1 is
its step 5, extracted here because it is the most invariant-sensitive cut). Read that first for
how we got here (instrument → C2 no-op → **C4 direct write, 200 s → 102 s** → C3 dropped → C1).
`docs/perf-baseline-2026-07-23.md` → "C4 landed" (the current 102 s breakdown this optimizes).
`docs/sync-engineering-guide.md` §4 (round anatomy), **§5 (invariants — the data-safety spine)**,
§7 (capture gotchas) — **must not break**. `docs/mobile-perf-baseline-spec.md` (Layer-1/2/3
measurement doctrine).

**Ground rule (from A3 §0):** no published release, no users. `.vault-sync/` is disposable
(delete + re-enable, or **Rebuild sync metadata**). Build for the clean end-state; write no
migration code.

---

## 1. Context — where this sits (the current 102 s)

`captureOfflineChanges` (`src/core/operation-logger.ts`) is the first-enable pass: for every
file present before the plugin's listeners attached, it reads the bytes, hashes them, stores the
blob, registers the file, and emits a `create` op. On first enable the registry is empty so the
O1 stat-gate never fires and every file takes the full path.

After **C4** (direct non-atomic blob write; `docs/startup-capture-optimization-spec.md` §4.3a),
the on-device first-enable at F=8389 is **102 s**, split:

| phase | s | % | nature |
|---|--:|--:|---|
| **putMs** (`contentStore.putNew` → one `adapter.write`) | 55.8 | 55% | **serial** native writes |
| **readMs** (`files.read` → one `vault.readBinary`) | 31.6 | 31% | **serial** native reads |
| otherMs (per-200-op registry+oplog checkpoints) | 13.5 | 13% | serial, atomic — **not** touched by C1 |
| hashMs (SHA-256) | 1.3 | 1% | CPU |

**The finding that motivates C1** (A3 measurement): on the Android/Capacitor bridge, a native
fs call is ~pure latency (~2–8 ms), independent of payload — `rename` cost as much as a byte
write while moving no bytes. So the **write (55.8 s) + read (31.6 s) = 87 s** are ~17k serial
round-trips run back-to-back. They have no cross-file data dependency; overlapping K of them at
a time is the lever.

**Read is unbatchable** (each is a `readBinary` on a distinct user note; no bulk-read API), so
concurrency is the *only* lever for the read half. Write *could* also be batched by a pack format
(A3 endgame step 3) — but that is a storage-format change deferred behind this measurement; C1
overlaps both halves with no format change.

---

## 2. The problem — the loop is fully serial

Today (`operation-logger.ts` `captureOfflineChanges`), per file, in one `for` loop:

```
await files.read(path)      // native round-trip  (readMs)
await hashContent(content)  // CPU                 (hashMs)
await contentStore.putNew(hash, content)   // native round-trip (putMs)
hlc.now(); registry.registerFile / updateContentHash; pendingOps.push; registry.setHeadVersion
// … checkpoint every 200 emitted ops: registry.flush + saveOpLog + clearMemCache
```

Each `await` blocks the next file. At 8389 files that is ~17k native round-trips issued one at a
time — the 87 s. CPU (hash) is 1%, so the loop is almost entirely idle waiting on the bridge.

---

## 3. Design — concurrent read/hash/put stage + serial bookkeeping consumer, chunked

Split the per-file work into a **concurrent stage** (no shared mutable state) and a **serial
stage** (all ordered/single-writer bookkeeping), processed in **chunks** so checkpoint cadence
and memory stay bounded.

### 3.1 The two stages

**Concurrent stage** (up to K files in flight) — per file produces one *outcome*, doing only:
`files.read` → `hashContent` → O1-gate/drift decision → `contentStore.putNew`. It touches only
the file and the content store (content-addressed: two workers writing distinct hashes never
collide; `putNew`'s memCache dedup is a synchronous `has`→`set` with no `await` between, so it is
race-free). It also does the synchronous, atomic-under-single-threaded-JS bookkeeping
`onDisk.add(path)` and `stats.files++`. It **reads** the registry (`getByPath`) but never mutates
it. The outcome is one of:

- `null` — excluded, O1-gate-elided, `read` returned null, or content unchanged with no stat
  drift. Nothing for the serial stage.
- `{ kind: 'restat', path, ref }` — content unchanged but `mtime/size` drifted → serial
  `registry.recordStat` (self-heal). No op.
- `{ kind: 'emit', path, ref, hash, existed, wasPlaceholder, entryId, parentVersion }` — a new or
  changed file. The blob is **already** `putNew`'d in this stage; the serial stage does the
  registry/op work. The snapshot fields (`existed`/`wasPlaceholder`/`entryId`/`parentVersion`) are
  captured **here**, before any mutation, exactly as the current serial code captures them before
  `updateContentHash` mutates the entry in place.

**Serial stage** (single consumer, drains the chunk's outcomes in list order): `hlc.now()` →
`registry.registerFile` / `updateContentHash` → `pendingOps.push` → `registry.setHeadVersion`,
`stats.opsEmitted++`, `changed = true`; or `recordStat` for a `restat`. Single-writer, so ids
stay unique, the HLC stays monotonic, and the registry-then-oplog checkpoint ordering holds. Per
file the blob `put` (concurrent) always **precedes** its op (serial), preserving
blob-before-op-checkpoint.

### 3.2 Chunking + checkpoint

Process the live list in chunks of `CHUNK = CAPTURE_CHECKPOINT_EVERY (200)` files:

```
for each chunk of CHUNK files:
  if signal.aborted → flush + saveOpLog(if changed) + return partial stats   // BEFORE the chunk
  // concurrent stage: K workers over the chunk, filling outcomes[0..chunk.len)
  await Promise.all(K workers pulling a shared next++ cursor)                 // barrier
  // serial stage: drain outcomes in order, replicating the ORIGINAL per-file cadence
  for i in 0..chunk.len:
    if signal.aborted → flush + saveOpLog(if changed) + return partial stats  // per-file, drives the exact-count abort
    if onProgress && ++scanned % CAPTURE_PROGRESS_EVERY === 0 → onProgress(scanned, total)
    apply outcomes[i]  (restat | emit | skip null)
  registry.flush(); if (changed) saveOpLog()                                   // one checkpoint / chunk
  if (start + CHUNK < total) contentStore.clearMemCache()   // ⚠ NOT after the last chunk (see §5.1)
// then: delete-detection (phantom-delete guard) + final flush — UNCHANGED
```

The concurrent stage of chunk N fully resolves (Promise.all barrier) before its serial drain, and
the next chunk starts only after this chunk's checkpoint — so the concurrent and serial stages
**never overlap in time**, and no two files in a chunk share a path. Memory is bounded to one
chunk of outcomes (content bytes are on disk after `putNew`; only hash + snapshot are held).

**Why chunked, not a streaming producer-consumer:** a fully-streaming pipeline (workers feed a
bounded queue drained by one checkpointing consumer) maximises parallelism but needs hand-rolled
backpressure. Chunking is simpler and preserves today's checkpoint cadence exactly; the only cost
is a small barrier (the slowest of the last K files) at each of ~42 chunk boundaries — negligible
vs the win.

### 3.3 The concurrency mechanism (mirror `uploadBlobs`)

Reuse the bounded worker-pool already proven for the first-sync blob upload
(`server-sync.ts` `uploadBlobs`): a shared `next++` cursor, K workers each looping
`for (;;) { const i = next++; if (i >= chunk.length) return; outcomes[i] = await scanFile(chunk[i]); }`,
then `await Promise.all(Array.from({ length: Math.min(K, chunk.length) }, worker))`. A worker that
throws rejects the chunk → propagates → the `finally` runs `resumeSaves`, leaving disk at the last
checkpoint (registry + oplog consistent there), same as today's early-throw path.

### 3.4 The K knob

`K` (concurrency) is a parameter, default `DEFAULT_CAPTURE_CONCURRENCY = 8` (matching
`DEFAULT_BLOB_UPLOAD_CONCURRENCY`). Expose it as an optional argument on
`captureOfflineChanges(onProgress?, signal?, concurrency = DEFAULT_CAPTURE_CONCURRENCY)` — the
test hook (K=1 gives the deterministic serial baseline; a fake recording concurrent depth asserts
≤ K). `main.ts` and the coordinator use the default. Tune on device.

---

## 4. Invariants that must not break (guide §5/§7, A3 §5)

All of these are preserved by keeping every mutation of ordered/shared state in the **serial
consumer**; the concurrent stage is read-only against shared state except for hash-addressed blob
writes and synchronous-atomic counters.

- **Blob-before-op checkpoint.** `putNew` (concurrent) completes before the chunk's serial stage
  pushes its op (Promise.all barrier). A crash between them strands a blob with no op (recoverable),
  never an op referencing an unwritten blob.
- **Registry-then-oplog ordering.** Unchanged — the checkpoint (`flush` then `saveOpLog`) runs once
  per chunk in the serial stage.
- **Unique ids + monotonic HLC.** `hlc.now()` and `pendingOps.push` are single-writer (serial
  consumer). No two ops share an id; logical time never regresses. **The pending-op *set* is
  identical to the serial baseline; order may differ** (a later chunk's ids are still later).
- **O1 gate + self-heal** (`operation-logger.ts`). The `mtime+size` decision and the
  content-identical-but-stat-drifted branch are per-file decisions in the concurrent stage; the
  registry *mutation* (`recordStat`) is deferred to the serial stage. Behaviour per file is
  byte-identical to today.
- **Phantom-delete guard** (`operation-logger.ts`). `onDisk` is populated for every scanned
  non-excluded file (concurrent stage). The delete-detection pass runs **after** the loop,
  unchanged; an abort returns **before** it (a partial `onDisk` never drives a vault-wide delete).
- **Abort / cancel** (plugin disabled mid-capture). Checked at each chunk boundary *and* per-item
  in the serial drain (see §5). Persists a consistent checkpoint and returns partial stats before
  the delete pass. In-flight concurrent `putNew`s may complete (harmless — content-addressed).
- **Idempotent content-addressed writes + hash-verify-on-read (C4).** Unchanged. Concurrent
  `putNew`s to distinct hashes are independent; a duplicate-content race dedups via the synchronous
  memCache `has`→`set`.

---

## 5. The exact-count abort constraint (do not regress)

`__tests__/capture-cancellation.test.ts` pins **exact** op counts: it aborts when the progress
callback reports `scanned >= 100` and asserts **exactly 100** pending ops (and that the un-scanned
tail is deferred, no phantom deletes). Today this works because the loop checks `signal.aborted` at
the **top** of each per-file iteration, then fires progress, then does the work — so abort at
`scanned=100` stops the *next* iteration.

**C1 must preserve this in the serial drain.** The drain replicates the original cadence exactly:
`abort-check → progress-tick → apply-outcome`, per outcome, with a global `scanned` counter. So an
abort fired at `scanned=100` stops the serial drain at exactly 100 emitted ops — even though the
concurrent stage already `putNew`'d the rest of the chunk's blobs (wasted but harmless: no op, no
registry entry, re-captured next enable). **Abort granularity is per-item in the serial drain, not
per-chunk** — the chunk-boundary check is an additional early-out, not the only one.

---

## 5.1 The warm-memCache tail (a property the serial loop already has — surfaced by C1)

The reverted-to serial loop clears `contentStore.clearMemCache()` only when crossing a
**200-emitted-op** boundary, so on a vault of < 200 files (and on the sub-200 tail of any vault) it
**never** clears — the just-captured blobs stay in the memCache. The sync round that runs
immediately after capture (`buildLocalIdentity` → `stageContent`) reads exactly those blobs, and a
memCache hit **skips the C4 hash-verify-on-read**; the **round stat-gate** suite
(`round-stat-gate.test.ts`) pins this (a converged post-capture round hashes **0** files).

C1's chunked variant briefly broke this — its per-chunk `clearMemCache` fired after the *final*
chunk too, cooling the tail and forcing a disk read + SHA-256 per blob in that next round (caught
by the same suite). That was a bug *introduced by* the chunking, not a property of the serial loop.
With C1 reverted, the warm tail is **inherent** and needs no special-casing: the per-200-op counter
simply never reaches the threshold again on the final window. Recorded here so any future re-clearing
of the memCache (a pack-writes rewrite, a chunked retry) preserves it.

**Bounded cache (2026-08-01).** The memCache now evicts LRU past a byte budget (perf-baseline B6),
so the warm tail is warm *up to the budget* rather than unconditionally: a capture whose tail exceeds
8 MiB of content loses its oldest blobs and pays the disk read + C4 verify for those in the next
round. That is the intended trade (the alternative was dropping the tail entirely every round), and
`round-stat-gate.test.ts` still pins the sub-budget case — the one the property was written for.

## 6. Testing plan

Drive the **real** device stack (TestDevice over the in-memory fakes; guide testing doctrine) —
never a reimplementation.

- **Existing capture suite green, unchanged:** `offline-capture`, `capture-stat-gate`,
  `capture-crash-safety`, **`capture-cancellation` (the exact-count pins §5)**, `round-stat-gate`,
  the phantom-delete guard, the C2/C4 tests.
- **Set equivalence to the serial baseline:** capture the same seeded vault at K=1 and K=8; the
  pending-op set is identical (compare by `type:path:contentHash`; order may differ), and all op
  ids are unique.
- **Bounded depth:** a fake `files.read` recording concurrent in-flight depth asserts `maxInFlight
  ≤ K` and `> 1` (actually concurrent) for K≥2.
- **Mid-pass abort under concurrency:** abort at `scanned=100` over a >CHUNK vault → exactly 100
  ops, no delete ops, registry/oplog checkpoint consistent, tail re-captured on the next pass.
- **Crash-safety cadence:** oplog persisted per chunk (loss bounded to < CHUNK + K in-flight).
- **On-device re-measure:** repeat A3 §3.2 (first-enable reset); record the new total + split.

---

## 7. Projection vs. measured — the device settled it (K=8 REGRESSED)

**Projection (K=8):** overlapping the 87 s of serial read+write → ~25 s total (102 s → ~25 s), *if
the bridge parallelizes*.

**Measured on device (2026-07-24, F=8389, first-enable reset):** **120.3 s wall — an ~18 s
REGRESSION vs C4's 102 s.** No parallelism materialised.

| phase | C4 serial | C1 K=8 (Σ workers) | per-call |
|---|--:|--:|---|
| readMs | 31.6 s | **391.6 s** | 3.8 → **46.7 ms** |
| putMs (writeMs-dominated) | 55.8 s | **459.8 s** (writeMs 436.6) | 6.6 → **54.8 ms** |
| hashMs (CPU) | 1.3 s | 1.6 s | unchanged |
| **wall total** | **102 s** | **120.3 s** | **+18 s** |

The aggregate busy sums (read 392 s + put 460 s = 851 s crammed into 120 s wall) are **not**
parallelism — they are the same serialized-bridge throughput as C4, with each worker's `await`
clock inflated ~8–12× because it now includes the time spent **blocked waiting for the other K−1
in-flight calls to drain through a single-threaded native bridge** (the shared queue is
double-counted across workers). Had the bridge truly parallelized, wall would have fallen toward
~15–25 s; it rose. `otherMs` = 120.3 − 851 = **−733 s**, the documented negative-residual tell of
overlapping phase sums (§CaptureStats note).

**What the device settled (answering the §7-prior questions):**
1. **Does the Android/Capacitor bridge parallelize native fs? — NO.** Reads and writes are serviced
   one at a time. Concurrency is the wrong lever here: best case break-even, actual case +18 s of
   contention + per-chunk-barrier (wait-for-slowest-of-K) + scheduling overhead. Same dead end as
   C3, and the earlier per-call-latency finding (call *count*, not payload, is the cost) now also
   explains *why concurrency can't help* — you cannot overlap calls on a serial resource.
2. **The write half must be cut by native-call COUNT, not overlap → pack-writes** (A3 endgame step
   3: batch many blobs into few large native writes; parallelism-independent, so it works despite
   the serial bridge). Writes (~56 s serial-equivalent, `put.writeMs`-dominated) remain the #1
   target — pack-writes is the next cut, not concurrency.
3. **Disposition:** C1's concurrent pipeline was **reverted** — `captureOfflineChanges` is back to
   the serial C4 loop. Concurrency added complexity + risk for a measured regression, so it earns no
   place in the tree; this doc preserves the finding. See §9.

---

## 8. Open questions

- **Optimal K.** The blob upload uses 8; capture also hashes (CPU) between round-trips, so the
  sweet spot may differ. Knob it; tune on device (try 4 / 8 / 16).
- **Bridge write parallelism** — §7.1; the real unknown. If disappointing → pack-writes.
- **Checkpoint cadence under concurrency.** An abort loses ≤ CHUNK + K in-flight (same bound as
  today, slightly larger constant). Confirm acceptable.
- **Chunk-boundary barrier cost.** ~42 barriers × (slowest of the last K files) — expected
  negligible; confirm it doesn't show up in the re-measure.

---

## 9. Implementation status (2026-07-24) — built, measured, REVERTED

The chunked concurrent-stage + serial-consumer design was implemented, measured on device, and
**reverted**. `src/core/operation-logger.ts` `captureOfflineChanges` is back to the serial C4 loop;
no `concurrency` arg, no worker pool, no `CaptureOutcome` type, no `DEFAULT_CAPTURE_CONCURRENCY`.
Full suite green (283 pass), typecheck clean.

**Why reverted — the on-device re-measure regressed (§7): 102 s → 120 s. The bridge serializes
fs.** K=8 bought no wall win and cost ~18 s of contention/scheduling. Concurrency is complexity +
risk for a measured loss, so it earns no place in the tree. **The finding is the deliverable:
critical evidence for all later perf work — on Android/Capacitor, native fs is a single-threaded,
serial resource, so optimise call COUNT (batching / pack-writes), never call OVERLAP.** The next
lever for the write half is pack-writes (A3 endgame step 3), not concurrency.

**Two things the build surfaced (worth keeping even though the code is gone):**

1. **No `uploadBlobs` to mirror (§3.3).** The bounded worker-pool the spec cited as "already
   proven for the first-sync blob upload (`server-sync.ts uploadBlobs`)" and
   `DEFAULT_BLOB_UPLOAD_CONCURRENCY` **do not exist in this TS repo** — the concurrent upload lives
   in the Go server. Had it landed, the pool would have been written from scratch, not reused.
2. **Warm-memCache tail (§5.1).** The chunked variant cleared the memCache every chunk including the
   last, cooling the just-captured tail and regressing the round stat-gate. That was a bug the
   *chunking* introduced; the serial loop keeps the tail warm inherently (§5.1). Noted so a future
   memCache-touching rewrite (pack-writes) preserves it.

**Tests:** the serial revert leaves the capture suite exactly as it was pre-C1 (the one relaxed
per-phase assertion in `offline-capture.test.ts` — `totalMs >= readMs + hashMs + putMs` — was
restored, since serial phase sums cannot exceed wall; the `capture-concurrency.test.ts` file was
deleted). Had C1 stayed, that assertion would have needed relaxing (concurrent phase sums are
aggregate busy-time and can exceed wall) — noted for anyone who revives the pipeline. The
exact-count mid-pass abort stays pinned by `capture-cancellation.test.ts` (abort at scanned=100 over
500 files), which the serial loop satisfies as it always did.
