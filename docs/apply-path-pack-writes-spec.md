# Vault Sync — Apply-Path Pack-Writes Spec (the applyMerge write-count cut)

**Status:** PROPOSED · **Date:** 2026-07-25 · **Owner:** client/perf

**One sentence:** a first full pull of an 8k-note vault spends **~200 s of a 230 s sync round
inside `applyMerge`** because the applicator writes each pulled blob through the per-blob
loose `put` (one native write + one `exists` probe per file, ~8k serial) — the exact
write-count problem A3 solved for capture with packs but never wired into apply; this spec
routes the applicator's blob writes through the **buffered pack path** and flushes **once per
apply**, collapsing ~8k native blob writes into ~tens of pack appends.

This document is written to be picked up **cold**, with no prior conversation context.

**Parent (do first):** `docs/unify-on-packs-spec.md` — makes packs the single blob format and
defines the buffered write primitive (`putBuffered`) + `flushPack()` this spec calls. Land
that first; this spec is the payoff that makes the bulk-apply case fast.

**Companions:** `docs/pack-writes-spec.md` (A3 — same lever, applied to capture: 8389 writes →
42 appends, 56 s → 1.1 s; §1's per-call-latency finding — bridge cost is native-call **count**,
not bytes). `docs/sync-engineering-guide.md` §5 (data-safety invariants) / conflict lifecycle —
**must not break**. `src/network/sync-applicator.ts` (`applyActions` — the reshaped path).
`src/network/vault-sync-host.ts` `applyMerge` (`:164`, delegates here).

**Ground rule (A3 §0):** no users, disposable `.vault-sync/`, **no migration code**.

---

## 1. Measured problem — the round is applyMerge, applyMerge is loose blob writes

On-device, a desktop pulling a full 8k-note vault (mobile's first push to the server), per
the round perf log:

| phase | ms | share |
|---|--:|--:|
| **applyMerge** (`applyActions`) | **199 840** | **87%** |
| fetchBlobs | 28 467 | 12% |
| reconcileConcurrentHeads | 1 212 | 0.5% |
| pull | 702 | — |
| recordVersionEdges / merge / stageContent / saveCursor | < 250 total | — |
| **total** | **230 297** | |

`applyMerge` is the whole round. ~200 s / 8 000 files ≈ **25 ms/file**, and the apply loop
(`sync-applicator.ts:101`) is **fully serial** — one `await` at a time.

Every pulled file is a `write_local` action. Per file the applicator does (`applyAction`,
`:165`):

1. `driftedSinceSnapshot` — no local snapshot for a brand-new remote file ⇒ returns without a
   read (`:373`). ~free on first pull.
2. `hashContent(action.content)` — SHA-256, CPU, cheap.
3. `files.write(path, content)` (`obsidian-vault-files.ts:28`) — the note itself. **Unavoidable**
   (it is the payload) — but `ensureDir` does an `adapter.exists(dir)` **per file** (`:64`),
   *not* memoized ⇒ ~8k redundant dir stats.
4. **`contentStore.put(hash, content)` (`:185`)** — writes the content a **second** time as a
   base64 loose `.bin`, preceded by a per-blob `metadata.exists` dedup probe (`content-store.ts:141`).
   ⇒ ~8k extra native writes + ~8k extra stats.

So three of the four per-file disk operations are overhead the pack format already eliminates
for capture. Step 4 is the big one — it is A3's exact "one native write per blob" problem, on
the apply path, never fixed. Five applicator call sites take this path: `write_local` (`:185`),
`write_merge` (`:228`), `conflict` markers (`:289`), `delete_conflict` keep (`:318`),
`binary_conflict` (`:348`).

**Why this also caused the "applying 8390 changes forever" bug** (already noted at `:80`): the
registry writes were batched to fix an O(N²), but the blob writes were left per-blob O(N) — 200 s
is long enough that a user force-closes mid-apply, the round never reaches `saveCursor`, and the
whole vault re-pulls next launch. Cutting the 200 s removes the trigger, not just the symptom.

---

## 2. Design — buffer blobs across the apply, flush once

The applicator already batches the *registry* across the whole apply (`suspendSaves` →
`applyActions` → one `flush()` in `finally`, `:85`/`:147`). Do the identical thing for blobs,
using the unify-on-packs buffered primitive.

### 2.1 Swap the five `put` calls for `putBuffered`

In `applyAction`, replace each `await this.contentStore.put(hash, X)` with the buffer-only
`await this.contentStore.putBuffered(hash, X)` (no I/O — CPU encode + RAM push). No other logic
changes; hashes, registry `adoptRemote`, and merge-node minting are untouched.

### 2.2 One `flushPack()` per apply, ordered before the op boundary

In `applyActions`, flush the blob buffer once, in the existing structure, **before** ops are
cleared/recorded and before the registry flush — preserving blob-before-op (guide §5):

```
applyActions(actions, local, remote):
  opLogger.stopListening()
  registry.suspendSaves()
  try {
    try {
      for (action of actions) { ... applyAction ... }   // now putBuffered, no per-blob I/O
    } finally {
      await contentStore.flushPack()   // ← NEW: all buffered blobs durable as packs, ONCE
      await opLogger.clearOps()        // (unchanged) — ops that reference them come after
      await sleep(0); opLogger.startListening()
    }
    await updateSyncedPaths(...)
    for (r of resolutions) recordMergeOp/recordMergeDelete(...)   // re-emitted ops — blobs already flushed
    for (fileId of deferred) recaptureLocalEdit(...)
  } finally {
    try { await registry.flush() } finally { registry.resumeSaves() }
    await registry.compact()
  }
```

`flushPack()` slots at the **top of the inner `finally`**, so it runs on both the clean path
and any mid-apply throw — every blob written this apply is durable before `clearOps` and before
the resolution/merge ops (which reference merge-node hashes) are recorded. A 200-action apply →
**1** pack append + **1** index append instead of 200 loose writes + 200 exists probes. An 8k
first pull → ~1 pack + index append for the whole apply (buffer is one apply's blobs; see §4
memory note), or a handful if we choose to flush per N to bound memory (§4).

### 2.3 Memoize `ensureDir` (the secondary win)

Independently of packs, give `ObsidianVaultFiles` an `ensuredDirs: Set<string>` and skip the
`adapter.exists` when a dir is already ensured — mirroring `ContentStore.ensuredShards` /
`packDirEnsured`. Kills ~8k redundant dir stats. Small, self-contained, no data-safety surface.
(Clear it never within a session; dirs don't get un-created under us mid-apply.)

After §2.1–2.3 the only remaining per-file disk op is the **note write itself** (`createBinary`)
— the irreducible payload — plus the amortised pack appends.

---

## 3. Invariants that must not break (guide §5)

- **Blob-before-op.** `flushPack()` completes before `clearOps` and before any `recordMergeOp`/
  `recordMergeDelete` for re-emitted resolutions/merge nodes — so no op ever references an
  unflushed blob. A crash between flush and op-record leaves durable blobs with no op (the round
  simply re-pulls; cursor not yet saved) — never an op citing missing bytes.
- **Runs on throw.** `flushPack()` is in the inner `finally`, alongside the existing
  `clearOps`; a mid-apply error still flushes what was written and restores listeners.
- **C4 hash-verify preserved.** Reads still go through `getFromPack`'s per-blob verify; a torn
  final pack/index append reads the affected blob as missing (F1), never corrupt.
- **Deferred/conflict paths unchanged.** F5 drift defer, S5 conflict defer, marker writes, and
  merge-node minting keep their exact semantics; only the *blob store call* under them changes
  from `put` to `putBuffered`. `conflict`-marker and `keep_modified`/`binary` writes buffer the
  same bytes they wrote loose before.
- **Registry batching untouched.** The `suspendSaves`/`flush`/`compact` structure and its
  ordering (registry then oplog) are unchanged; the pack flush is added strictly before them.

---

## 4. Memory & flush granularity

One apply buffers its blobs as base64 in `packBuffer` before the single `flushPack`. For an 8k
first pull that is the whole vault's base64 (~vault size × 1.33) resident at once — the same
material the round already holds (the pulled `action.content` for every action is in `actions`
already), so it is not new peak memory, but it *is* held until the flush.

If that peak is a concern on mobile, flush **per K actions** inside the loop (e.g. every 200,
reusing `CAPTURE_CHECKPOINT_EVERY`) instead of once at the end — each flush is still ~2 native
writes, ordering is preserved (all flushes precede `clearOps`), and peak buffer drops to K
blobs. **Leaning: single end-of-apply flush** for simplicity (the `actions` array already pins
the same bytes); switch to per-K only if a device measure shows a memory cliff. Record which was
chosen in the on-device re-measure.

---

## 5. Testing plan (drive the real stack — TestDevice; guide doctrine)

- **Write-count assertion (the point):** apply a synthetic first-pull of F `write_local`
  actions; the fake `MetadataStore` shows ~**1** (or `ceil(F/K)`) pack append + index append and
  **0** loose blob writes — contrast the pre-change `writesDirect ≈ F`.
- **Round-trip after apply:** every applied file's blob reads back by its registry hash
  (C4-verified) with byte-identical content; duplicate-content files share one packed hash.
- **Blob-before-op ordering:** assert `flushPack` resolves before the first `clearOps`/
  `recordMergeOp` in an apply that includes a clean `write_merge` (which re-emits a merge node
  whose hash must already be packed).
- **Throw mid-apply:** inject a failing action; buffered blobs up to that point are still
  flushed (inner `finally`), listeners restored, registry flushed.
- **Conflict/defer paths:** `conflict` markers, `delete_conflict` keep, `binary_conflict` keep
  all store via packs; F5/S5 defers still skip writes and hold the cursor.
- **`ensureDir` memoization:** an apply touching many files in one dir issues one `adapter.exists`
  for that dir, not one per file (fake adapter counter).
- **Existing suites green:** `sync-applicator*`, `sync-integration` first-pull, `content-store-pack`.
- **On-device re-measure:** repeat the 8k first-pull; record new `applyMerge` ms + round total,
  and which flush granularity (§4) was used. Target: `applyMerge` from ~200 s into tens of
  seconds, dominated by the irreducible 8k note writes + the 28 s `fetchBlobs`.

---

## 6. Scope / non-goals

- **In:** swap the five applicator `put`→`putBuffered`; one (or per-K) `flushPack` in
  `applyActions`; `ensureDir` memoization in `ObsidianVaultFiles`.
- **Out:** the unify-on-packs storage change + mark-and-compact GC (parent spec — prerequisite);
  parallelising the apply loop (measure after this — the bridge serializes fs, so fewer *calls*
  is the proven lever, not overlap — pack-writes-spec §1); `fetchBlobs` (network-bound, 12%,
  separate); the note-write itself (irreducible payload).

---

## 7. Open questions

- **Flush granularity** — §4. Single end-of-apply vs per-K. Decide from a device memory measure;
  default single.
- **Post-fix next-dominant.** With `applyMerge` cut, `fetchBlobs` (28 s) becomes the largest
  remaining line — likely network/serialization of 8k blob downloads. Out of scope here; flag
  for a follow-up (batched/streamed blob fetch) once this lands.
- **Parallel note writes.** After the pack fix, the residual is 8k serial `createBinary` calls.
  Whether bounded-concurrency chunking helps depends on the same bridge-serialization question
  C1 answered for capture (it did not). Measure before attempting; likely a floor.
