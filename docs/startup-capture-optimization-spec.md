# Vault Sync — First-Enable `captureOfflineChanges` Optimization Spec (A3)

**Status:** Draft / decision-of-record · **Date:** 2026-07-24 · **Owner:** client/perf

The next on-device hotspot after A2. With the round's `buildLocalState` staging fixed
(A2, `docs/build-local-state-perf-spec.md`) and the steady-state round now pull-bound
(~3s), the **single largest number in a first-run session is the first-enable capture**:

```
startup captureOfflineChanges total heapMB=77/1940 184027.5ms
```

**184 seconds** — three minutes of "building sync index" before the vault syncs at all,
on an F≈8388-note Android vault (Obsidian WebView, on-device `perfLog`, 2026-07-24).
Bigger than either sync round in the same session.

Companion docs: `docs/capture-optimization-spec.md` (the O1 mtime/size gate this builds
on), `docs/perf-baseline-2026-07-23.md` (the numbers + the O(F²)→O(F) registry-batching
fix already landed), `docs/sync-engineering-guide.md` (§4 round anatomy, §5 invariants,
§7 the capture gotchas — **must not break**).

---

## 0. Ground rule: no users, no release yet

Same as A1/A2 §0. **No published release, no users.** The `.vault-sync/` cache and the
on-disk content-store layout are disposable (delete + re-enable, or **Rebuild sync
metadata**). Build for the clean end-state; write no migration code for old on-disk
state. This change touches only the capture path and (optionally) the content-store
storage format — nothing durable a real user's vault depends on exists yet.

---

## 1. The problem

`captureOfflineChanges` (`src/core/operation-logger.ts:116`) is the first-enable pass
that turns a pre-existing vault into a synced baseline: for every file present before the
plugin's listeners attached (no `create` event ever fires for those) it reads the bytes,
hashes them, stores the blob, registers the file, and emits a `create` op to push.

It has **already** been made correct and O(F) (not O(F²)):

- **Registry batching** (`suspendSaves` → checkpoint `flush`) killed the O(F²)
  whole-registry-rewrite-per-file — the 1.96 GB / GC-cliff bug (perf baseline B3/B5).
- **Crash-safety checkpointing** every 200 ops (registry-then-oplog) bounds an
  interrupted capture's loss.
- **The O1 stat gate** (`operation-logger.ts:168`) means *subsequent* startups skip the
  read+hash of any unchanged file — a converged cold start is fast.

What remains is the **irreducible-looking first pass**: on the *first* enable the
registry is empty, so the O1 gate never fires and **every** file takes the full path.
That path is, per file (`operation-logger.ts:170`–`207` + `content-store.ts:58` `put`):

| Step | Cost | Kind |
|---|---|---|
| `files.read(path)` | 1 Capacitor fs read | native round-trip |
| `hashContent(content)` | 1 SHA-256 | CPU (single-thread) |
| `contentStore.put`: `metadata.exists(path)` | 1 fs stat | native round-trip |
| `contentStore.put`: `metadata.write(path, base64(content))` | 1 fs write + base64 encode | native round-trip + CPU/alloc |
| `registerFile` + `setHeadVersion` + `pendingOps.push` | amortized (batched) | in-memory + periodic flush |

So each file is **~3 serial Capacitor round-trips** (read + exists + write) plus a hash
and a base64 encode, and **the whole loop is serial** — each `await` blocks the next
file. At 8388 files that is **~25,000 native fs round-trips issued one at a time**. At the
measured 184 s that is **~22 ms/file (~7 ms/round-trip)** — consistent with a mobile
WebView→native bridge crossing, not with CPU (a few-KB note hashes in <0.1 ms).

**The cost is fs-round-trip-bound and serialization-bound, not CPU-bound.**

### Scope note: this is a one-time onboarding cost

Every *subsequent* cold start is O1-gated (unchanged files skip read+hash+write), so this
184 s is paid **once**, at first enable. That lowers its severity vs. a per-round cost —
but three minutes of an unusable, not-yet-syncing vault is a real onboarding cliff, and
the fix is cheap and low-risk. This spec targets first-enable specifically.

---

## 2. Where the time goes (measure before cutting)

The 184 s is a single total; the on-device **split** between read / hash / put / registry
is not yet recorded. The perf-baseline doctrine (`docs/mobile-perf-baseline-spec.md` §4)
is *measure, then cut* — so **rollout step 1 is to instrument the pass's internal phases**
(sum of `files.read` ms, sum of `hashContent` ms, sum of `contentStore.put` ms — the put
further split into `exists` vs `write`) under `perfLog`, and record the split.

The hypothesis from the counts (B3: read=hash=write=F) and the per-round-trip arithmetic
above is: **fs round-trips (read + exists + write) dominate; SHA-256 and base64 are
secondary.** The instrumentation confirms or refutes that before we optimize the wrong
thing (exactly the A2 lesson — the laptop's fake fs hid the real cost).

---

## 3. Constraints that make this non-trivial

Any fix must preserve the capture's hard-won correctness (guide §5/§7):

- **Crash-safety ordering.** The checkpoint persists the **registry first, then the
  oplog** (`operation-logger.ts:222`), so on-disk the registry is never behind the oplog
  — a crash strands files (recoverable via rebaseline), never orphans ops. And a blob
  must be written **before** the op referencing it is checkpointed, or a crash leaves an
  op whose local content is absent.
- **The phantom-delete guard** (`operation-logger.ts:249`). An empty/partial
  `files.list()` during the cold-start window must NOT be read as a vault-wide delete.
  The delete-detection pass runs *after* the scan and is skipped when the listing looks
  untrustworthy. Concurrency must not reorder a file into "vanished".
- **Deterministic ids + monotonic HLC.** Each op's id is `hlcToString(hlc.now())`; ids
  must stay unique and the HLC monotonic. `hlc.now()` and `pendingOps` ordering are
  shared mutable state — they cannot be driven from parallel workers without
  serialization.
- **The O1 gate's self-heal** (`operation-logger.ts:174`–`182`). A stat-drifted but
  content-identical file records its fresh stat and emits no op; that branch must survive.
- **Content-store base retention (Step 8).** The blob-write is not pure overhead — the
  content store must hold DAG-reachable merge bases so a future divergence three-way
  merges instead of degrading to a conflict (F1). On first enable every blob is a future
  base, so blobs cannot simply be dropped.

---

## 4. Proposed design

Two independent, low-risk cuts (C1 + C2), both attacking the fs-round-trip count/latency
the §2 measurement is expected to confirm as dominant. A larger storage-format change
(C3) is scoped but deferred.

### 4.1 C1 — bounded-concurrency capture pipeline (the primary cut)

The scan loop is fully serial: `await files.read`, then `await hashContent`, then
`await contentStore.put`, one file at a time, so 25,000 native round-trips run
back-to-back. Overlap them with a **bounded worker pool** — the *same* pattern already
proven for the first-sync blob upload (`server-sync.ts` `uploadBlobs`,
`DEFAULT_BLOB_UPLOAD_CONCURRENCY = 8`), which turned the latency-bound first-sync upload
from serial into ⌈N/K⌉ waves.

Split the per-file work into a **concurrent stage** and a **serial stage**:

- **Concurrent (I/O + CPU, no shared mutable state):** `files.read(path)` →
  `hashContent` → decide gate/drift → `contentStore.put(hash, content)`. These touch only
  the file and the content store (content-addressed, so two workers writing distinct
  hashes never collide). Run up to K in flight.
- **Serial (ordered bookkeeping):** `hlc.now()`, `registry.registerFile` /
  `updateContentHash` / `setHeadVersion`, `pendingOps.push`, and the checkpoint. Drained
  from a single consumer so ids stay unique, the HLC stays monotonic, and the
  registry-then-oplog checkpoint ordering holds. Per file, the blob `put` completes in the
  concurrent stage **before** its op reaches the serial stage, preserving
  blob-before-op-checkpoint.

Expected win: the dominant fs-round-trip wall time falls toward `total / K`, bounded below
by (a) the single-thread SHA-256 sum and (b) native-bridge saturation. Realistically
~4–6× on a phone (not a clean 8×) — a 184 s pass toward ~30–45 s before C2.

**Why this is safe:** the concurrent stage has no cross-file dependency (content is
hash-addressed; the O1 gate is a per-file decision), and everything order-sensitive stays
in the serial consumer. The phantom-delete guard is untouched (it runs after the scan over
`onDisk`, which each worker adds its path to). `AbortSignal` cancellation still checks
between serial-stage items.

### 4.2 C2 — drop the redundant `exists` probe on first-enable writes

`ContentStore.put` guards every write with `if (!(await metadata.exists(path)))`
(`content-store.ts:61`) to dedup. On a **fresh** store that probe is *always false* —
8388 guaranteed-miss round-trips of pure waste. Add a bulk write path
(`putNew(hash, content)`, or a "assume-absent" flag) that writes **unconditionally**:
a content-addressed write is idempotent (a duplicate hash overwrites byte-identical
bytes), so skipping the existence check is safe for the first-enable pass. Removes ~1/3 of
the per-file round-trips (3 → 2: read + write).

(The steady-state `put` keeps its `exists` dedup — this new path is used only by the
first-enable bulk capture, where the store is known-empty.)

### 4.3 C3 — raw-binary blob storage (deferred, secondary)

`MetadataStore.write` is text-only (`metadata-store.ts:14`), so every blob is
base64-encoded — a **1.33× size inflation** on every write plus the encode CPU/allocation
(material for large attachments in a mixed vault, and churn the checkpoint `clearMemCache`
already fights). Extending the port with a binary `writeBinary`/`readBinary` (Capacitor
supports it) and storing blobs raw removes both. This is a larger change — port + Obsidian
adapter + the on-disk content-dir format + `get`/`has`/GC read paths — so it is **scoped
here but deferred** to a follow-up; C1+C2 land first and are re-measured before deciding
whether C3 is warranted.

### 4.4 Considered and rejected

- **Skip the blob-write, rely on `stageContent`'s disk fallback.** Tempting (removes
  8388 writes), but it breaks content-store **base retention** (§3): the store must hold
  DAG-reachable bases for future three-way merges, and on first enable every blob is a
  future base. It also risks a capture→push drift window where the disk no longer holds
  the captured bytes. **Rejected** — data-safety over speed.
- **Defer the whole capture to a background pass so the vault is usable immediately.**
  A syncable baseline must exist before the first sync (or the first sync pushes a partial
  vault). Backgrounding the capture is a UX option (a progress panel already exists,
  `main.ts:65`) but does not reduce the *work*; orthogonal to this spec and higher-risk
  (a sync racing an unfinished capture). Not pursued here.
- **Persisted-identity snapshot / append-only registry journal.** Helps *subsequent* cold
  starts and the round's identity build — but on *first* enable there is nothing persisted
  and every file must still be read+hashed once. Out of scope for this cliff.

---

## 5. Invariants that must not break (guide §5/§7)

- **Crash-safety checkpoint ordering** — registry-then-oplog, and blob-before-op. The
  serial consumer preserves both; the concurrent stage only ever *precedes* the op it
  feeds.
- **Phantom-delete guard** — the empty/partial-listing backstop and the deferred
  `onLayoutReady` timing are untouched; `onDisk` is still populated for every scanned file.
- **Deterministic ids + monotonic HLC** — `hlc.now()` and `pendingOps` stay single-writer
  (serial consumer). No two ops share an id; logical time never regresses.
- **O1 gate + self-heal** — the mtime/size gate and the stat-drift-record branch run
  per file in the concurrent stage exactly as today; behavior for an unchanged or a
  content-identical-but-stat-drifted file is byte-identical.
- **Idempotent content-addressed writes** — C2's unconditional write is safe only because
  a hash names its exact bytes; a re-write is a no-op-equivalent overwrite.
- **Abort/cancel** (`main.ts:292`, the disable-mid-capture path) — cancellation still
  persists a consistent checkpoint and returns before the delete pass.

---

## 6. Testing plan

- **Instrumentation first (rollout step 1):** a device run with the per-phase capture
  split recorded in `docs/perf-baseline-2026-07-23.md` — before any code change.
- **Concurrency correctness (C1):** the existing capture tests must stay green —
  `offline-capture.test.ts` (create-per-file + reaches a peer), `capture-stat-gate`,
  `round-interruption-durability`, the phantom-delete guard, and the abort/cancel test.
  Add: a large-N capture asserts (a) every file yields exactly one create op with a
  unique id, (b) the pending-op *set* is identical to the serial baseline (order may
  differ, ids must not collide), (c) a mid-pass abort still leaves a consistent
  registry/oplog checkpoint.
- **Bounded fs (C1/C2):** through the real stack (mirror `first-sync-registry-batching`),
  assert the round-trip counts — with C2, first-enable `metadata.exists` calls during
  capture drop to ~0; with C1, at most K reads are in flight at once (a fake that records
  concurrent depth).
- **C2 idempotence:** capturing a vault with duplicate-content files writes each distinct
  hash once and never corrupts an existing blob.
- **On-device re-measure:** re-run the F≈8388 first enable; record the new total + phase
  split, and confirm the projected ~30–45 s (C1) / further (C2) drop.

---

## 7. Rollout

1. **Instrument** the capture's internal phases (read/hash/put, put→exists/write) under
   `perfLog`; record the on-device split in `docs/perf-baseline-2026-07-23.md`. Confirms
   the fs-bound hypothesis before cutting.
2. **C2** (drop the redundant `exists` on a first-enable bulk write path) — small,
   isolated, obviously safe; land + test first.
3. **C1** (bounded-concurrency pipeline) — the primary cut. Land behind the same
   K-concurrency knob shape as `blobUploadConcurrency` (a test hook, sane default). Keep
   the serial consumer for all ordered bookkeeping.
4. Run `npm run build && npx vitest run` (all green) + glance at coverage for new blind
   spots. Re-measure on device; record the new breakdown.
5. **Decide on C3** (raw-binary storage) from the re-measured split — pursue only if the
   base64 write/encode is still a material share after C1+C2.
6. Update `docs/sync-engineering-guide.md` §7 (capture gotcha) and
   `docs/perf-baseline-2026-07-23.md` "Still to do" once landed.

---

## 8. Open questions

- **What is the real read/hash/put split on device?** The whole plan assumes fs
  round-trips dominate. Step 1 settles it. If SHA-256 turns out to be a large share
  (unlikely from the arithmetic, but a vault heavy in large binaries could shift it), a
  WebWorker offload for hashing becomes a candidate C1 companion.
- **Optimal K.** The blob upload uses 8. The capture also does CPU (hashing) between
  round-trips, so the sweet spot may differ; make it a knob and tune on device.
- **Does C1 change checkpoint cadence semantics?** Checkpoints fire from the serial
  consumer every N ops; with reads racing ahead, the in-flight (read-but-not-yet-booked)
  set is bounded by K, so an abort loses at most the K in-flight plus <N since the last
  checkpoint — same bound, slightly larger constant. Confirm acceptable.
- **Interaction with the first sync's push.** After capture, the first sync re-reads the
  content store to upload (94 s push, separately batched). If C3 (raw storage) lands, the
  push's blob encrypt/encode also benefits — worth a joint re-measure.
