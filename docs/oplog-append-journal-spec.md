# Vault Sync — First-Enable Oplog Append-Journal Spec (the checkpoint-rewrite cut, oplog half)

**Status:** Step 1 DONE (measured on device 2026-07-24) · **Step 2 (§4) DONE + ON-DEVICE CONFIRMED
(2026-07-24)** — append-journal landed (300 unit tests green incl. round-trip / O(delta) linearity /
torn-tail / clearOps-truncate / prune-compaction, `__tests__/oplog-append-journal.test.ts`);
**oplogSaveMs 5.37 s → 1.25 s**, the append write itself **3.82 s → 0.21 s (~18×)** — see §7. **Owner:** client/perf

**This spec leads with instrumentation.** §3 Step 1 splits the measured **12.1 s `otherMs`**
(the per-checkpoint metadata rewrites left after pack-writes solved the blob-write half) into
its **registry** vs **oplog** halves — and, within each, **serialize (JSON.stringify) time vs
native write time** — so we cut the half that actually dominates and know whether the cost is
CPU or the bridge. Only then §4 lands the oplog fix. The registry half is deliberately split
into its own, more cautious spec (`docs/registry-checkpoint-cost-spec.md`) because it is *not*
a clean append and needs more design thought; **this** spec is the clean, ready half.

**Step-1 result (measured, §3.3):** `otherMs` = 12.1 s splits **near-evenly** —
**registry 5.73 s (47%)**, **oplog 5.37 s (44%)**, residual 1.0 s (8%) — so *both* checkpoint
rewrites are real, comparable levers (neither is a no-op). Within **both**, the **native write
dominates the serialize** (oplog write 3.82 s vs stringify 0.58 s; reg write 4.86 s vs stringify
0.78 s): the cost is the **MB-scale bridge write, not CPU**, so §4's append-only fix — which
appends only the *delta bytes* each checkpoint instead of rewriting the whole growing file — is
the right cut. Land §4 (clean + ready); the registry half is co-primary (marginally larger) and
proceeds under its own spec.

This document is written to be picked up **cold**, with no prior conversation context.

---

**One sentence:** at each of ~42 first-enable checkpoints the capture rewrites the **entire**
growing `pendingOps` array to `oplog.json` (`JSON.stringify(this.pendingOps, null, 2)` — full
serialize + full write, from scratch, every time), so the bytes written over the pass are
**triangular / O(N²)**; this spec appends only the *delta* ops since the last checkpoint to a
line-oriented journal, turning the oplog write from O(N²) into O(N) — exactly the
parallelism-independent, fewer-calls-and-fewer-bytes shape that pack-writes just proved wins on
this bridge.

**Parent / companions:** `docs/pack-writes-spec.md` (the sibling that solved the blob-write half
and named this as the next lever: *"the append-only-oplog-journal / fewer-checkpoints spec"*;
its on-device re-measure is where the 12.1 s `otherMs` figure comes from).
`docs/startup-capture-optimization-spec.md` (A3 — the umbrella; the per-call-latency finding and
the C1 "bridge serializes fs" finding both apply here). `docs/registry-checkpoint-cost-spec.md`
(the **other half** of `otherMs`, gated on this spec's Step-1 measurement).
`docs/sync-engineering-guide.md` §5 (invariants — the blob-before-op / registry-before-oplog
ordering this **must not break**), §7 (capture gotchas). `src/core/operation-logger.ts`
(`saveOpLog`, `load`, `clearOps`, the capture checkpoint) — the code this reshapes.

**Ground rule (from A3 §0):** no published release, no users. `.vault-sync/` is disposable
(delete + re-enable, or **Rebuild sync metadata**). Build for the clean end-state; write **no
migration code** — the oplog may change on-disk format freely.

---

## 1. Context — where this sits (the 46 s total, and why `otherMs` is next)

Pack-writes (`docs/pack-writes-spec.md`) collapsed the blob-write phase **~56 s → ~2.1 s** and
the first-enable total **102 s → 46 s** on-device (F=8389). The remaining split:

| phase | s | % | nature |
|---|--:|--:|---|
| readMs (`files.read`) | 30.4 | 66% | serial native reads — a floor, deferred (A3 read-probe) |
| **otherMs** (per-200-op registry+oplog checkpoint rewrites) | **12.1** | **26%** | **serial atomic rewrites — this spec + the registry one** |
| flushMs (pack + index append) | 1.3 | 3% | solved (pack-writes) |
| hashMs (SHA-256) | 1.2 | 3% | CPU |
| putMs (buffered `putNew`) | 0.8 | 2% | solved (pack-writes) |

`otherMs` is defined by exclusion (`main.ts:561`):
`otherMs = totalMs − readMs − hashMs − putMs − flushMs`. With the per-file registry writes
already batched away (`suspendSaves`, see §2), everything remaining in `otherMs` is the
**checkpoint rewrites** — `registry.flush()` **plus** `saveOpLog()` — plus loop overhead. Step 1
attributes it between those two so we don't guess. The read floor (30.4 s) is deferred (A3);
`otherMs` is the addressable next lever.

**Two prior findings fence the cut** (both from A3, load-bearing):
1. **Per-call-latency finding:** a native fs call is ~pure latency (~2–8 ms) *independent of
   payload* at small sizes — but the pack-writes measurement caught that at **~MB scale there is
   a real per-byte component** (an 800 KB append cost 25.7 ms vs 4.2 ms for 4 KB). A late-capture
   `oplog.json` holding 8389 pretty-printed ops is multi-MB, so both the serialize CPU **and** the
   native write have a per-byte cost that grows with N. That is why the whole-array rewrite is
   quadratic on *two* axes at once (§2).
2. **C1 "the bridge serializes fs":** overlap can't help; the only win is **fewer / smaller**
   native calls. Append-only delivers exactly that.

---

## 2. The problem (diagnosis) — the oplog rewrite is O(N²)

The first-enable loop (`operation-logger.ts:166`–`288`) pushes one op per changed file into the
in-memory `this.pendingOps`, and at every checkpoint persists the batch:

```ts
// operation-logger.ts:276 — checkpoint, every CAPTURE_CHECKPOINT_EVERY (=200) emitted ops
if (++sinceCheckpoint >= CAPTURE_CHECKPOINT_EVERY) {
  await this.contentStore.flushPack();   // blobs (solved — flushMs)
  await this.registry.flush();           // the OTHER half — registry-checkpoint-cost-spec.md
  await this.saveOpLog();                // ← THIS spec
  this.contentStore.clearMemCache();
  sinceCheckpoint = 0;
}
```

```ts
// operation-logger.ts:656 — saveOpLog: full serialize + full write, every call
private async saveOpLog(): Promise<void> {
  if (!(await this.metadata.exists(OPLOG_DIR))) { await this.metadata.mkdir(OPLOG_DIR); }
  await this.metadata.write(OPLOG_PATH, JSON.stringify(this.pendingOps, null, 2));  // ALL ops, pretty-printed
  await this.hlcStore?.save(this.hlc.getCurrent());
  this.changeListener?.();
}
```

**Why it is quadratic.** `pendingOps` grows monotonically during first capture (nothing drains
it until the post-capture push). Over ~42 checkpoints it is re-serialized-from-scratch and
re-written at sizes 200, 400, 600, … 8389 ops. The total work is the **triangular sum**
≈ N²/(2·200) — for N=8389 that is **~176k op-serializations** and the same shape in bytes
written, on *both* the `JSON.stringify` (CPU/alloc, with `null, 2` indentation overhead) and the
native `metadata.write` (per-byte at MB scale). Neither the serialize nor the write is a
delta — every checkpoint pays for **all** prior ops again.

**What it is NOT:** it is **not** a read-modify-write cycle. `saveOpLog` never reads the file
back; it serializes the in-memory array and overwrites. So the fix is purely on the write side —
no read to eliminate, just the redundant re-serialization of already-persisted ops.

**Note the shape is identical to the blob-write bug pack-writes just fixed** (one full write per
unit of work, growing). The fix is the same shape too: **append the delta, don't rewrite the
whole.**

---

## 3. Rollout — **instrumentation leads**

### Step 1 (DONE 2026-07-24) — split `otherMs` into registry vs oplog, serialize vs write

**Goal:** one device run that writes, to `.vault-sync/perf-log.txt`, the attribution of the
12.1 s `otherMs` so both this spec and the registry one act on numbers, not the estimate. This is
**the shared metrics-split deliverable** both specs depend on. **Landed** (`CaptureStats`
+ `OperationLogger.captureOplogPerf` / `FileRegistry.captureFlushPerf`, sink-gated the same way
put/write perf is; emitted by `captureOfflineWithPerf`). **Result: §3.3.**

**Why before the fix:** the estimate is that oplog and registry are *roughly* comparable halves
(both grow to 8389, registry entries are richer per-record, oplog is a flatter object), but A3's
whole history is "measure the sub-structure, don't estimate it" (C2 was estimated at ⅓ of `put`
and measured as a **no-op**). If the oplog turns out to be, say, 2 s of the 12 s, this spec is
still correct but the *registry* spec is the priority — and Step 1 is what tells us.

#### 3.1 Implementation (obsidian-free core + existing perf sink)

Arm the accumulators **only when the perf sink is on** — the same pattern `captureOfflineWithPerf`
already uses for `capturePutPerf` / `captureWritePerf` (`main.ts:513`–`516`), so a normal enable
pays nothing.

1. **`operation-logger.ts` — extend `CaptureStats`** with the four checkpoint sub-fields and total
   them at each `saveOpLog` / `registry.flush` call site inside the capture (checkpoint, abort,
   final):

   ```ts
   // added to CaptureStats
   oplogSaveMs: number;   // Σ saveOpLog wall time (serialize + write) at capture checkpoints
   regFlushMs: number;    // Σ registry.flush wall time at capture checkpoints
   ```

   Wrap the two checkpoint calls (`operation-logger.ts:283`–`284`, and the abort path `:181`–`182`,
   and the final `:340`–`341`) with `nowMs()` deltas into `stats.regFlushMs` / `stats.oplogSaveMs`.
   Do **not** count the per-op `saveOpLog` from live `recordOp` — this is the capture path only.

2. **Serialize-vs-write sub-split (the load-bearing question — is it CPU or the bridge?):** arm two
   sink-gated accumulators the way put/write perf is armed. In `saveOpLog`, time the
   `JSON.stringify` separately from the `metadata.write`:

   ```ts
   const ts = nowMs(); const json = JSON.stringify(this.pendingOps, null, 2);
   this.captureOplogPerf && (this.captureOplogPerf.stringifyMs += nowMs() - ts);
   const tw = nowMs(); await this.metadata.write(OPLOG_PATH, json);
   this.captureOplogPerf && (this.captureOplogPerf.writeMs += nowMs() - tw);
   ```

   Mirror the same two-timer split inside `registry.flush()` (`file-registry.ts:67`) behind a
   sink-gated `captureFlushPerf` handle set by `captureOfflineWithPerf`. This decides magnitude,
   not direction: append-only cuts **both** the stringify (only the delta ops are serialized) and
   the write (only the delta bytes are appended), so the fix is right either way — but the split
   confirms the ~12 s is real and predicts the post-fix floor (as the append-bench did for
   pack-writes).

3. **`main.ts` `captureOfflineWithPerf` — emit the fields.** Alongside the existing
   `readMs/hashMs/putMs/flushMs/otherMs` lines (`main.ts:540`–`561`), add:

   ```ts
   sink?.(`captureOfflineChanges regFlushMs`, stats.regFlushMs);
   sink?.(`captureOfflineChanges oplogSaveMs`, stats.oplogSaveMs);
   // and, when the sub-split handles were armed:
   sink?.(`captureOfflineChanges oplog.stringifyMs`, oplogPerf.stringifyMs);
   sink?.(`captureOfflineChanges oplog.writeMs`, oplogPerf.writeMs);
   sink?.(`captureOfflineChanges reg.stringifyMs`, flushPerf.stringifyMs);
   sink?.(`captureOfflineChanges reg.writeMs`, flushPerf.writeMs);
   ```

   After the split, `otherMs − regFlushMs − oplogSaveMs` is the residual loop overhead — expect it
   ≈ 0, confirming the two rewrites *are* the whole of `otherMs`.

4. **Tests:** the capture suite stays green (`offline-capture.test.ts`, the multi-checkpoint
   write-count test pack-writes added, `round-interruption-durability`, the abort/cancel test,
   the phantom-delete guard). Add one assertion that a capture over N>CHECKPOINT seeded files
   returns `regFlushMs ≥ 0` and `oplogSaveMs ≥ 0` and that the fake metadata store recorded
   **more than one** `oplog.json` write (i.e. the checkpoints fired). Run
   `npm run build && npx vitest run` — all green.

#### 3.2 On-device procedure (hand to the user — same as pack-writes §, abbreviated)

Force a first-enable (delete `.vault-sync/` with Obsidian closed, or **Rebuild sync metadata**),
turn on **Diagnostics → Performance logging**, reload the plugin, wait for *"vault prepared."*,
and paste back the `captureOfflineChanges regFlushMs / oplogSaveMs / oplog.stringifyMs /
oplog.writeMs / reg.stringifyMs / reg.writeMs / otherMs / total` lines.

**What the split decides:**
- **oplog ≳ registry** → this spec is the priority; land §4.
- **registry ≳ oplog** → land §4 anyway (it's cheap and clean) but escalate
  `docs/registry-checkpoint-cost-spec.md` to primary.
- **stringifyMs dominates writeMs** → the cost is serialize CPU (quadratic `JSON.stringify`);
  append-only removes it by serializing only the delta.
- **writeMs dominates** → the cost is the MB-scale native write; append-only removes it by
  appending only the delta bytes. Either way §4 is the fix.

#### 3.3 Result — measured on device 2026-07-24 (F=8389, first-enable)

The Step-1 build, run once on-device with **Diagnostics → Performance logging** on:

| line | ms | share |
|---|--:|--:|
| readMs (`files.read`, 8389 files) | 31462.6 | 67% of total |
| **otherMs** | **12122.4** | **26% of total** |
| — `regFlushMs` (registry checkpoint rewrites) | 5730.3 | **47% of otherMs** |
| — `oplogSaveMs` (oplog checkpoint rewrites) | 5371.9 | **44% of otherMs** |
| — `otherResidualMs` (hlc save + exists + loop overhead) | 1020.2 | 8% of otherMs |
| flushMs (pack + index append) | 1199.4 | solved (pack-writes) |
| hashMs (SHA-256) | 1243.6 | CPU |
| putMs (buffered `putNew`; put.encodeMs 543, rest 0) | 822.0 | solved (pack-writes) |
| **total** (heap 68/1940 MB) | **46850.0** | |

Serialize-vs-write sub-split (the load-bearing "CPU or the bridge?" question):

| rewrite | stringifyMs (CPU) | writeMs (bridge) | write share |
|---|--:|--:|--:|
| oplog (`saveOpLog`) | 576.5 | **3823.2** | **87%** |
| registry (`flush`) | 776.2 | **4861.1** | **86%** |

**What the split decided (both questions answered):**
1. **oplog ≈ registry** (5.37 s vs 5.73 s) — the pre-measure estimate that they're *roughly
   comparable halves* held. Neither is a C2-style no-op; both are worth cutting. Registry is
   marginally larger, so per §3.2 it is **co-primary** and escalates under
   `docs/registry-checkpoint-cost-spec.md`; this spec's §4 lands regardless (cheap + clean).
2. **writeMs dominates stringifyMs on BOTH** (~86–87% of each rewrite is the native write, not
   the serialize). So the cost is the **MB-scale bridge write**, exactly the axis append-only
   removes: a checkpoint appends only the delta *bytes* instead of re-writing the whole growing
   file. The stringify (CPU) half is small but also becomes O(delta) for free. §4 is the fix.
3. **Residual ≈ 1.0 s (8%)** — small but not zero: the `hlcStore.save` + `exists` probe +
   `clearMemCache` + loop overhead that live inside `otherMs` but outside the two rewrites. Not
   addressed here; noted so the post-§4 `otherMs` floor isn't mistaken for 0.

Prediction for §4: `oplogSaveMs` 5.37 s → **well under 1 s** (O(N) appends, mirroring pack-writes'
`flushMs` at 1.2 s). With the registry spec, target `otherMs` **12.1 s → ~1–2 s** → first-enable
total **~35 s**, at which point the **read floor (31.5 s)** is essentially the whole remaining
cost and the A3 read-probe becomes the last lever.

### Step 2 (DONE + ON-DEVICE CONFIRMED 2026-07-24) — landed the append-journal (§4). Re-measured: `oplogSaveMs` 5.37 s → 1.25 s, the append write itself 3.82 s → 0.21 s (~18×). Full numbers + the "HLC-save is now the floor" finding in §7.

---

## 4. Design — the append-only oplog journal

### 4.1 The shape

Replace the single pretty-printed JSON *array* at `OPLOG_PATH` with a **line-oriented journal**
(NDJSON): one op per line, `JSON.stringify(op) + '\n'`. During capture, a checkpoint **appends**
only the ops emitted since the previous checkpoint — never re-serializing or re-writing the ops
already on disk. This is the exact analogue of pack-writes' per-chunk pack append, and it inherits
the same measured property: `append` is **O(delta)** on this bridge (pack-writes §, growth ratio
0.4 — cost does not grow with existing file size).

- **Hot path (capture checkpoint):** `metadata.append(OPLOG_PATH, deltaOps.map(o => JSON.stringify(o)).join('\n') + '\n')`.
  The delta is the ops pushed since `sinceCheckpoint` last reset — track an index/marker into
  `pendingOps` (e.g. `oplogPersistedCount`) so the checkpoint knows the unwritten tail. One append
  per checkpoint, O(delta) bytes — total over the pass is **O(N)**, not O(N²).
- **Load (`operation-logger.ts:103`):** read the file, split on `\n`, `JSON.parse` each non-empty
  line into `pendingOps`. Tolerate a torn trailing line (crash mid-append) by dropping a final
  line that doesn't parse — the same torn-tail tolerance pack-writes' pack reader already has, and
  safe here because a half-written op simply re-captures next enable (its blob is blob-before-op
  durable or it isn't, and either way no *persisted* op references an unwritten blob).

### 4.2 The rare full-rewrite events (off the hot path — keep them a full rewrite)

`pendingOps` is not append-only for its *whole* lifecycle — two operations mutate/shrink it. Both
happen **outside** the capture loop, so they can afford a full rewrite (compaction) with no perf
concern:

- **`clearOps()` (`:614`)** — drain to empty after a successful push. For a journal this is a
  **truncate to empty file** (one small write). Cheap.
- **`removeOpsForFile` / the `filter` at `:682`** — drops a file's ops (used off the capture path).
  This is a **compaction**: rewrite the journal from the in-memory `pendingOps` (now filtered).
  Also `recordOp` from live editing (`:651`) can keep appending single lines — a live edit is one
  op, one append.

**Rule:** *append* during capture and live single-op record; *full-rewrite* only on the two
shrink events. Reset `oplogPersistedCount` to `pendingOps.length` after any full rewrite. This
keeps the hot path append-only while the (rare, small) shrink events stay simple and correct.

### 4.3 A `MetadataStore.append` may already exist

Pack-writes added an append path for the pack index, and `main.ts:493` uses
`this.metadata.append('.vault-sync/perf-log.txt', …)`. Confirm the port exposes `append(path,
text)` with create-if-absent semantics on both the Capacitor (mobile) and Node (desktop/test)
adapters; if the pack-writes work only added a private append inside `ContentStore`, promote it to
the `MetadataStore` port (the oplog is written through `metadata`, not the content store). The
fake store used in tests must implement it (append = read-or-empty + concat + write is fine for the
fake — it only needs to be *correct*, not fast).

---

## 5. Invariants — **must not break** (sync-engineering-guide §5)

1. **Blob-before-op ordering (spec §4 / guide §5).** The checkpoint already flushes the pack
   **before** the oplog (`:277`–`284`) so no persisted op references an unwritten blob. Preserve
   the order exactly: `flushPack()` → `registry.flush()` → **oplog append**. The append changes
   *how* the oplog persists, not *when* relative to blobs and registry.
2. **Registry-before-oplog ordering (`:262`–`269`).** On disk the registry must never lag the
   oplog — a crash in the gap must strand files (registry ahead, recoverable via rebaseline), never
   orphan ops (oplog ahead, referencing unregistered files). The append happens *after*
   `registry.flush()`, same as today. Do not reorder.
3. **Crash-tolerant load.** A crash mid-append leaves a torn trailing line; the loader drops it
   (§4.1). A crash between registry-flush and oplog-append loses ≤ the last delta's ops — bounded
   by CHECKPOINT_EVERY, identical to today's guarantee, and those files re-capture next enable
   (their registry entry may be ahead → rebaseline heals; never an orphan op).
4. **Idempotent re-append is not required, but no duplicates.** `oplogPersistedCount` must advance
   only after a *successful* append, so a failed/retried checkpoint re-appends the same delta once,
   not twice, and never skips it. (If `append` throws, leave the marker un-advanced.)
5. **`getPendingOps()` / push semantics unchanged.** The in-memory `pendingOps` and its public API
   (`getPendingOps`, `clearOps`, the push round) are untouched — this spec only changes the
   *persistence* representation. The push round reads `pendingOps` from memory, not disk.

---

## 6. Tests

- **Round-trip:** append K ops across multiple checkpoints, reload, assert `pendingOps` equals
  what was emitted (order preserved).
- **O(delta) — the win, asserted structurally:** capture N > several×CHECKPOINT files with an
  instrumented fake `append` counting **bytes appended**; assert total appended bytes are
  **linear** in N (within a constant), i.e. the last checkpoint appends ~the same bytes as the
  first — not growing. This is the regression guard that the O(N²) rewrite does not creep back.
- **Torn-tail tolerance:** write a journal with a truncated final line; load drops it and returns
  the intact prefix; no throw.
- **`clearOps` truncates:** after `clearOps`, the on-disk journal is empty and a reload yields `[]`.
- **`removeOpsForFile` compacts:** after removing a file's ops, reload yields exactly the remaining
  ops; `oplogPersistedCount` reset so a subsequent append doesn't duplicate.
- **Existing suite green:** `offline-capture.test.ts` (incl. the multi-checkpoint write-count test),
  `round-interruption-durability`, abort/cancel, phantom-delete guard. Update any test that reads
  `oplog.json` expecting a JSON array to read the NDJSON journal instead.

---

## 7. Outcome — predicted, then verified on device (2026-07-24, F=8389)

**Prediction (pre-fix):** `oplogSaveMs` 5.37 s → O(N) appends, **well under 1 s**, by appending only
the delta *bytes* each checkpoint (§3.3 showed the cost was 86% native write — 3.82 s of the 5.37 s).

**Verified (same first-enable, F=8389, `perfLog`):** the mechanism held exactly; the headline figure
was slightly optimistic because it conflated the append with per-checkpoint overhead the fix never
touched:

| oplog line | Step-1 (rewrite) | **Step-2 (append)** | Δ |
|---|--:|--:|--:|
| **oplogSaveMs** (whole persist, ×~42 checkpoints) | 5,371.9 | **1,247.1** | **−77%** |
| — `oplog.stringifyMs` (serialize) | 576.5 | **20.8** | −96% (only the delta ops serialized) |
| — `oplog.writeMs` (native write) | 3,823.2 | **208.9** | **−18×** (only the delta *bytes* appended) |
| — residual (dir-`exists` + `hlcStore.save` + notify) | ~971 | ~1,017 | ~flat — **the new floor** |

**The O(N²)→O(delta) cut landed as predicted:** the append-specific work (stringify + write) collapsed
**4.40 s → 0.23 s (~19×)**; `oplog.writeMs` alone did the predicted **3.82 s → 0.21 s (~18×)**. The
reason `oplogSaveMs` is 1.25 s and not "well under 1 s" is that **~1.0 s of it is now the per-checkpoint
`hlcStore.save` (an atomic small-file write) + the dir-`exists` probe + the change-notify** — a fixed
~24 ms × ~42 checkpoints that lived inside `saveOpLog` all along (§3.3's "residual 1.0 s") and is
untouched by this spec. That ~1 s is a *possible* micro-follow-up (persist the HLC once at end / cache
the dir-exists), small relative to the read floor; noted, not pursued here.

**Full-pass numbers** (this run's readMs came in ~5 s lower than Step-1 — read-floor variance, not this
change): otherMs **12.12 s → 8.05 s**; total **46.85 s → 37.72 s**. Holding readMs constant, the oplog
change alone accounts for the **−4.07 s** in `otherMs`.

**What this leaves as primary:** `regFlushMs` is **unchanged at 5.76 s** (registry untouched) and is now
**72% of the 8.05 s otherMs** (was 47% of 12.1 s). So `docs/registry-checkpoint-cost-spec.md` is now the
**unambiguous next lever** — cutting it (option A, raise the flush cadence) targets `otherMs` 8.05 s →
~2–3 s → first-enable total → **~32 s**, at which point the **read floor (~26–31 s)** is essentially the
whole remaining cost and the A3 read-probe (deferred) becomes the last lever. Recorded in
`docs/perf-baseline-2026-07-23.md` ("The oplog append-journal" subsection).
