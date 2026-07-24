# Vault Sync — First-Enable `captureOfflineChanges` Optimization Spec (A3)

**Status:** Draft / decision-of-record · **Date:** 2026-07-24 · **Owner:** client/perf

**This spec leads with instrumentation.** The first deliverable is *not* an optimization
— it is an on-device measurement that splits the 184 s first-enable capture into its
read / hash / store phases, so we cut the phase that actually dominates (the A2 lesson:
the laptop's fake filesystem hid a 52 s cost as ~8 ms). §3 (Rollout) step 1 is the whole
near-term task; §4 (Design) is reference for the cuts that follow the measurement.

This document is written to be picked up **cold**, with no prior conversation context.

Companion docs: `docs/capture-optimization-spec.md` (the O1 mtime/size gate this builds
on), `docs/build-local-state-perf-spec.md` (A2, the round-staging fix that made the round
pull-bound and left this as the top hotspot), `docs/perf-baseline-2026-07-23.md` (the
numbers + the O(F²)→O(F) registry-batching fix already landed),
`docs/sync-engineering-guide.md` (§4 round anatomy, §5 invariants, §7 capture gotchas —
**must not break**), `docs/mobile-perf-baseline-spec.md` (the Layer-1/2/3 measurement
doctrine).

---

## 0. Ground rule: no users, no release yet

**No published release, no users.** The `.vault-sync/` cache and the on-disk
content-store layout are disposable (delete + re-enable, or **Rebuild sync metadata**).
Build for the clean end-state; write no migration code for old on-disk state. This change
touches only the capture path and (optionally, C3) the content-store storage format —
nothing durable a real user's vault depends on exists yet.

---

## 1. Context — where this sits (what just landed, and the current numbers)

The sync engine is an E2E-encrypted vault sync against an untrusted server; correctness
lives in obsidian-free modules behind ports, driven in tests by fakes (see the
engineering guide). A **sync round** is build → pull → push → merge → apply → cursor. A
separate **startup capture** (`captureOfflineChanges`) turns a pre-existing vault into a
synced baseline on first enable.

**A2 just landed** (`docs/build-local-state-perf-spec.md`, commits `7147e41`…`f5838c9`):
the round's `buildLocalState` used to stage the bytes of *every* live file every round
(O(vault)); it now builds only identity before the pull and stages content *scoped* to
the files the merge touches. Confirmed on device (Android WebView, F≈8388 notes):

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

The converged round dropped **56 s → 3.1 s** and is now **pull-bound**. The first sync's
94.5 s is the one-time baseline blob+op **upload** (`push`) — already batched, does not
recur. What is left as the single largest number in a first-run session is the line that
*precedes* all of the above:

```
startup captureOfflineChanges total heapMB=77/1940 184027.5ms
```

**184 seconds** of "building sync index" before the vault syncs at all — the subject of
this spec (A3). Full breakdown recorded in `docs/perf-baseline-2026-07-23.md` → "The A2
fix".

---

## 2. The problem (diagnosis)

`captureOfflineChanges` (`src/core/operation-logger.ts:116`) is the first-enable pass: for
every file present before the plugin's listeners attached (no `create` event fires for
pre-existing files) it reads the bytes, hashes them, stores the blob, registers the file,
and emits a `create` op to push.

It is **already correct and O(F)** (not O(F²)):

- **Registry batching** (`suspendSaves` → checkpoint `flush`) killed the O(F²)
  whole-registry-rewrite-per-file — the 1.96 GB / GC-cliff bug (perf baseline B3/B5).
- **Crash-safety checkpointing** every 200 ops (registry-then-oplog) bounds an
  interrupted capture's loss (`operation-logger.ts:222`).
- **The O1 stat gate** (`operation-logger.ts:168`) means *subsequent* startups skip the
  read+hash of any unchanged file — a converged cold start is fast.

What remains is the **first pass**: on the *first* enable the registry is empty, so the O1
gate never fires and **every** file takes the full path. Per file
(`operation-logger.ts:170`–`207` + `content-store.ts:58` `put`):

| Step | Cost | Kind |
|---|---|---|
| `files.read(path)` | 1 Capacitor fs read | native round-trip |
| `hashContent(content)` | 1 SHA-256 | CPU (single-thread) |
| `contentStore.put`: `metadata.exists(path)` (`content-store.ts:61`) | 1 fs stat | native round-trip |
| `contentStore.put`: `metadata.write(path, base64(content))` | 1 fs write + base64 encode | native round-trip + CPU/alloc |
| `registerFile` + `setHeadVersion` + `pendingOps.push` | amortized (batched) | in-memory + periodic flush |

So each file is **~3 serial Capacitor round-trips** (read + exists + write) plus a hash
and a base64 encode, and **the whole loop is serial** — each `await` blocks the next file.
At 8388 files that is **~25,000 native fs round-trips issued one at a time**. At 184 s that
is **~22 ms/file (~7 ms/round-trip)** — consistent with a mobile WebView→native bridge
crossing, not with CPU (a few-KB note hashes in <0.1 ms).

**Hypothesis: the cost is fs-round-trip-bound and serialization-bound, not CPU-bound.**
§3 step 1 measures the split to confirm it before we optimize.

**Scope note — a one-time onboarding cost.** Every *subsequent* cold start is O1-gated, so
this 184 s is paid **once**, at first enable. That lowers its severity vs. a per-round cost
— but three minutes of an unusable, not-yet-syncing vault is a real onboarding cliff, and
the fix is cheap. This spec targets first-enable specifically.

---

## 3. Rollout — **instrumentation leads**

### Step 1 (the near-term task) — instrument the capture's internal phases, then measure on device

**Goal:** a single device run that produces, in `.vault-sync/perf-log.txt`, the split of
the capture total into `readMs`, `hashMs`, `putMs` (+ file/op counts), so the dominant
phase is known before any optimization. Measure, then cut (`mobile-perf-baseline-spec.md`
§4).

#### 3.1 Implementation (obsidian-free core + thin main wiring)

`captureOfflineChanges` is in the obsidian-free `operation-logger.ts`; keep it that way
(no new port, no `obsidian` import). Surface the split by **returning a stats object** the
`main.ts` caller logs through the existing perf sink.

1. **`operation-logger.ts` — accumulate + return.** Add a small result type and total the
   three awaits with `performance.now()` deltas:

   ```ts
   export interface CaptureStats {
     files: number;        // files scanned (post-exclusion)
     opsEmitted: number;   // create/update/delete ops pushed
     readMs: number;       // Σ files.read
     hashMs: number;       // Σ hashContent
     putMs: number;        // Σ contentStore.put (exists + write + base64)
     totalMs: number;      // wall time of the whole pass
   }
   ```

   Wrap each measured call in the scan loop, e.g.
   `const t = nowMs(); const content = await this.files.read(path); readMs += nowMs() - t;`
   (reuse the `nowMs()` helper shape from `perf-timer.ts` — `performance.now()` with a
   `Date.now()` fallback). Change the method to `Promise<CaptureStats>` and return the
   totals (an interrupted/aborted return path returns the partial totals too). The
   accumulation is a handful of `performance.now()` calls per file (~sub-ms over 8388
   files) — negligible; leave it always-on rather than threading a flag, but do not *log*
   unless the caller has a sink.

2. **`main.ts` `captureOfflineWithPerf` — log each field.** It already holds
   `const sink = this.perfSink('startup')` and emits
   `sink?.('captureOfflineChanges total…', …)`. Capture the returned stats and emit one
   line per field so they land in `perf-log.txt`:

   ```ts
   const stats = await this.opLogger.captureOfflineChanges(cb, this.captureAbort.signal);
   sink?.(`captureOfflineChanges readMs (${stats.files} files)`, stats.readMs);
   sink?.(`captureOfflineChanges hashMs`, stats.hashMs);
   sink?.(`captureOfflineChanges putMs`, stats.putMs);
   sink?.(`captureOfflineChanges otherMs`, stats.totalMs - stats.readMs - stats.hashMs - stats.putMs);
   sink?.(`captureOfflineChanges total${heapNote()}`, stats.totalMs);
   ```

   (`otherMs` captures registry flush + base64 + loop overhead not in the three phases.)

3. **Optional finer split (only if `putMs` dominates and we want the exists-vs-write
   breakdown for C2 in the *same* run):** thread a tiny accumulator into
   `ContentStore.put` (or add a `put` variant that also returns `{ existsMs, writeMs }`),
   and fold those into `CaptureStats`. Not required — C2 (§4.2) is obviously safe
   regardless — so keep it out unless the primary split says put is the bottleneck.

4. **Tests:** the existing capture suite must stay green (`offline-capture.test.ts`,
   `capture-stat-gate`, `round-interruption-durability`, the phantom-delete guard, the
   abort/cancel test). The return-type change ripples to those call sites (they ignore the
   value). Add one assertion that a capture over N seeded files returns
   `stats.files === N` and `stats.opsEmitted === N` and non-negative phase totals. Run
   `npm run build && npx vitest run` — all green.

#### 3.2 On-device measurement procedure (hand this to the user)

The agent builds the instrumented plugin; the user runs it on the phone and pastes back
the log lines. **Reproduce a first-enable** (empty registry) so the O1 gate does not elide
the vault — either a fresh large vault, or reset the existing one:

1. **Build:** `npm run build` (produces `main.js`). Copy `main.js`, `manifest.json`, and
   `styles.css` into the device vault's
   `.obsidian/plugins/obsidian-vault-sync/` (the existing on-device install workflow).
2. **Force a first-enable** on the ~8k-file vault: with Obsidian closed, delete the
   vault's **`.vault-sync/`** folder (this drops the registry, oplog, cursor, and content
   cache — a full re-onboard; it will re-push on the next sync, which is fine for
   measurement). Alternatively use the in-app **Rebuild sync metadata** command, or a
   fresh copy of the vault.
3. **Enable the diagnostic:** Obsidian → Settings → (community plugin) Vault Sync →
   expand **Diagnostics** → turn on **Performance logging**. (It writes
   `.vault-sync/perf-log.txt`.)
4. **Trigger the capture:** reload the plugin (toggle it off/on in Community Plugins) or
   restart Obsidian — the first-enable capture runs on layout-ready. A notice
   *"preparing N files for first sync"* appears and the status bar shows *Indexing
   x/N…*. Wait for *"vault prepared."*
5. **Read the log:** open `.vault-sync/perf-log.txt` (in the vault, via a file manager or
   Obsidian itself). Copy the lines containing `captureOfflineChanges readMs / hashMs /
   putMs / otherMs / total` (and the `heapMB=…/…` on the total line). Paste them back.
6. **(No sync needed** to get the number — the capture total + split is already written
   when *"vault prepared"* shows. Syncing afterward is optional.)

**What the split decides:** if `readMs + putMs` dominate → C1 (concurrency) + C2 (drop the
redundant `exists`) are the cuts, and C3 (raw storage) is likely worth it. If `hashMs`
turns out large (a vault heavy in big binaries) → a hashing offload (WebWorker) joins the
plan. If `otherMs` is large → the registry flush cadence is the target instead.

### Later steps (after the measurement — see §4 for design detail)

2. **C2** — drop the redundant `exists` probe on a first-enable bulk write path (§4.2).
   Small, isolated, obviously safe; land first among the cuts.
3. **C1** — bounded-concurrency capture pipeline (§4.1). The primary cut. Behind a
   K-concurrency knob (test hook, sane default), serial consumer for ordered bookkeeping.
4. `npm run build && npx vitest run` green + coverage glance; **re-measure on device**
   (repeat 3.2), record the new breakdown in `docs/perf-baseline-2026-07-23.md`.
5. **Decide on C3** (raw-binary storage, §4.3) from the re-measured split.
6. Update `docs/sync-engineering-guide.md` §7 (capture gotcha) and the perf baseline's
   "Still to do".

---

## 4. Design (reference for the post-measurement cuts)

Two independent, low-risk cuts (C1 + C2), both attacking the fs-round-trip count/latency
the §3.1 measurement is expected to confirm as dominant. A larger storage-format change
(C3) is scoped but deferred.

### 4.1 C1 — bounded-concurrency capture pipeline (the primary cut)

The scan loop is fully serial: `await files.read`, then `await hashContent`, then
`await contentStore.put`, one file at a time, so ~25,000 native round-trips run
back-to-back. Overlap them with a **bounded worker pool** — the *same* pattern already
proven for the first-sync blob upload (`server-sync.ts` `uploadBlobs`,
`DEFAULT_BLOB_UPLOAD_CONCURRENCY = 8`), which turned the latency-bound upload from serial
into ⌈N/K⌉ waves.

Split the per-file work into a **concurrent stage** and a **serial stage**:

- **Concurrent (I/O + CPU, no shared mutable state):** `files.read(path)` →
  `hashContent` → O1-gate/drift decision → `contentStore.put(hash, content)`. These touch
  only the file and the content store (content-addressed, so two workers writing distinct
  hashes never collide). Up to K in flight.
- **Serial (ordered bookkeeping):** `hlc.now()`, `registry.registerFile` /
  `updateContentHash` / `setHeadVersion`, `pendingOps.push`, and the checkpoint. Drained
  from a single consumer so ids stay unique, the HLC stays monotonic, and the
  registry-then-oplog checkpoint ordering holds. Per file the blob `put` completes in the
  concurrent stage **before** its op reaches the serial stage, preserving
  blob-before-op-checkpoint.

Expected win: the dominant fs-round-trip wall time falls toward `total / K`, bounded below
by the single-thread SHA-256 sum and native-bridge saturation — realistically ~4–6× on a
phone (not a clean 8×). 184 s → ~30–45 s before C2.

**Why safe:** the concurrent stage has no cross-file dependency (content is
hash-addressed; the O1 gate is a per-file decision); everything order-sensitive stays in
the serial consumer. The phantom-delete guard is untouched (it runs after the scan over
`onDisk`, which each worker adds its path to). `AbortSignal` cancellation still checks
between serial-stage items.

### 4.2 C2 — drop the redundant `exists` probe on first-enable writes

`ContentStore.put` guards every write with `if (!(await metadata.exists(path)))`
(`content-store.ts:61`) to dedup. On a **fresh** store that probe is *always false* —
~8388 guaranteed-miss round-trips of pure waste. Add a bulk write path
(`putNew(hash, content)`, or an "assume-absent" flag) that writes **unconditionally**: a
content-addressed write is idempotent (a duplicate hash overwrites byte-identical bytes),
so skipping the check is safe for the first-enable pass. Removes ~1/3 of the per-file
round-trips (3 → 2: read + write). The steady-state `put` keeps its `exists` dedup — the
new path is used only where the store is known-empty.

### 4.3 C3 — raw-binary blob storage (deferred, secondary)

`MetadataStore.write` is text-only (`metadata-store.ts:16`), so every blob is
base64-encoded — a **1.33× size inflation** on every write plus the encode CPU/allocation
(material for large attachments, and churn the checkpoint `clearMemCache` already fights).
Extending the port with a binary `writeBinary`/`readBinary` (Capacitor supports it) and
storing blobs raw removes both. Larger change — port + Obsidian adapter + on-disk
content-dir format + `get`/`has`/GC read paths — so **scoped here but deferred**; land
C1+C2 and re-measure before deciding whether C3 is warranted.

### 4.4 Considered and rejected

- **Skip the blob-write, rely on `stageContent`'s disk fallback.** Removes ~8388 writes,
  but breaks content-store **base retention** (Step 8): the store must hold DAG-reachable
  merge bases so a future divergence three-way merges instead of degrading to a conflict
  (F1), and on first enable every blob is a future base. Also risks a capture→push drift
  window. **Rejected** — data-safety over speed.
- **Defer the whole capture to a background pass so the vault is usable immediately.** A
  syncable baseline must exist before the first sync (or it pushes a partial vault).
  Backgrounding is a UX option (a progress panel exists, `main.ts:65`) but does not reduce
  the *work* and is higher-risk (a sync racing an unfinished capture). Orthogonal; not
  pursued here.
- **Persisted-identity snapshot / append-only registry journal.** Helps *subsequent* cold
  starts and the round's identity build — but on *first* enable nothing is persisted and
  every file must still be read+hashed once. Out of scope for this cliff.

---

## 5. Invariants that must not break (guide §5/§7)

- **Crash-safety checkpoint ordering** — registry-then-oplog, and blob-before-op. The
  serial consumer preserves both; the concurrent stage only ever *precedes* the op it
  feeds. (Instrumentation-only step 1 does not touch ordering at all.)
- **Phantom-delete guard** (`operation-logger.ts:249`) — the empty/partial-listing
  backstop and the deferred `onLayoutReady` timing are untouched; `onDisk` is still
  populated for every scanned file.
- **Deterministic ids + monotonic HLC** — `hlc.now()` and `pendingOps` stay single-writer
  (serial consumer). No two ops share an id; logical time never regresses.
- **O1 gate + self-heal** (`operation-logger.ts:168`,`174`) — the mtime/size gate and the
  stat-drift-record branch run per file exactly as today; behavior for an unchanged or a
  content-identical-but-stat-drifted file is byte-identical.
- **Idempotent content-addressed writes** — C2's unconditional write is safe only because
  a hash names its exact bytes; a re-write is an identical-bytes overwrite.
- **Abort/cancel** (`main.ts:292`, disable-mid-capture) — still persists a consistent
  checkpoint and returns before the delete pass; step 1 returns partial stats on that path.

---

## 6. Testing plan

- **Step 1 (instrumentation):** existing capture suite green; add a stats-shape assertion
  (`files`/`opsEmitted` counts, non-negative phase totals) over N seeded files. The
  return-type change ripples to call sites (they ignore the value).
- **Concurrency correctness (C1):** existing tests green, plus a large-N capture asserting
  (a) every file yields exactly one create op with a unique id, (b) the pending-op *set*
  is identical to the serial baseline (order may differ, ids must not collide), (c) a
  mid-pass abort still leaves a consistent registry/oplog checkpoint, and (d) at most K
  reads are in flight at once (a fake recording concurrent depth).
- **Bounded fs (C2):** through the real stack (mirror `first-sync-registry-batching`),
  assert first-enable `metadata.exists` calls during capture drop to ~0.
- **C2 idempotence:** a vault with duplicate-content files writes each distinct hash once,
  never corrupting an existing blob.
- **On-device re-measure:** repeat §3.2 after C1/C2; record the new total + split.

---

## 7. Open questions

- **The real read/hash/put split on device** — the whole plan assumes fs round-trips
  dominate. §3 step 1 settles it. A binary-heavy vault could shift weight to hash/put.
- **Optimal K** for C1 — the blob upload uses 8; capture also hashes (CPU) between
  round-trips, so the sweet spot may differ. Make it a knob; tune on device.
- **Checkpoint cadence under concurrency** — with K reads racing ahead, an abort loses at
  most the K in-flight plus <N since the last checkpoint (same bound, larger constant).
  Confirm acceptable.
- **Interaction with the first sync's push** — after capture the first sync re-reads the
  content store to upload (94 s push). If C3 lands, the push's encrypt/encode also
  benefits — worth a joint re-measure.
