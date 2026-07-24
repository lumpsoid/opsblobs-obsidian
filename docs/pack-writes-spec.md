# Vault Sync — First-Enable Pack-Writes Spec (the write-count cut)

**Status:** IMPLEMENTED (per-chunk packs) · **Date:** 2026-07-24 · **Owner:** client/perf

**Landed (2026-07-24).** The append micro-measurement ran on-device FIRST (§8's
load-bearing unknown) and confirmed the plan: `append` is **O(delta)** — the append-bench
growth ratio was **0.4** (last-quartile per-append 2.7 ms < first-quartile 7.6 ms; cost does
NOT grow with file size). Head-to-head at 200×4 KB: loose `writeDirect` **6.7 ms/call**
(→ 8389 blobs ≈ 56 s, matching the measured `putMs`), vs **per-chunk pack append 25.7 ms**
for a 200-blob (~800 KB) chunk (→ 42 chunks ≈ **1.08 s**). So the write phase collapses
**~56 s → ~1.1 s**. One nuance recorded: a large 800 KB append is NOT pure latency
(25.7 ms vs 4.2 ms for 4 KB) — there's a real per-byte component at that size — but the
call-count cut (42 vs 8389) dominates. Small `index` appends are flat, so **append-per-chunk
index** was chosen (no deferred single write). Design landed as **per-chunk packs** (§8's
leaning), which also de-risks the append answer: each pack is written once.

**Implementation:** `src/core/append-bench.ts` (the measurement, run via the
"Measure append cost (diagnostic)" command → console + `perf-log.txt`).
`src/core/content-store.ts` (buffered `putNew` → `flushPack`, pack format §3.1, `get`/`has`/
`listHashes` pack fallback with whole-pack caching, index load on `init()`, whole-pack
retention GC, `delete` drops the index entry). `src/core/operation-logger.ts` (`flushPack`
before `saveOpLog` at checkpoint/abort/final + `CaptureStats.flushMs`). Tests:
`__tests__/content-store-pack.test.ts` (round-trip, whole-pack-read amortisation, torn-tail,
coexistence, whole-pack GC, index rebuild, pack-id resume) + the multi-checkpoint write-count
and updated C2 assertion in `__tests__/offline-capture.test.ts` + `__tests__/append-bench.test.ts`.

**On-device re-measure — CONFIRMED (2026-07-24, F=8389).** First-enable **total 102 s → 46 s
(−55%)**. Split: readMs **30.4 s** (the floor, unchanged), otherMs **12.1 s** (checkpoint
registry+oplog rewrites), hashMs 1.2 s, **buffered putMs 0.8 s + flushMs 1.3 s = ~2.1 s** for the
whole write phase (was 50–56 s — a **~26× cut**). `put.writeMs = 0` confirms zero per-blob writes.
`flushMs 1.3 s` lands exactly on probe C (1.08 s packs + ~0.25 s index appends) — the measurement
predicted the outcome. **The write half is solved.** Next-dominant: the read floor (30.4 s, deferred)
and the **checkpoint `otherMs` (12.1 s)** — the append-only-oplog-journal / fewer-checkpoints spec.

---

**One sentence:** the first-enable capture writes one content blob per native fs call (~8389
serial `writeDirect`s ≈ 50–56 s); this spec batches many blobs into a few large **pack** files
appended once per checkpoint, cutting the write phase from ~8389 native calls to ~tens — a
parallelism-independent win, which is the only kind that helps now that C1 proved the bridge
serializes fs.

This document is written to be picked up **cold**, with no prior conversation context.

**Parent / companions:** `docs/startup-capture-optimization-spec.md` (A3 — the umbrella; this is
the endgame step, promoted to primary after C1). Read it for how we got here (instrument → C2
no-op → **C4 direct write, 200 s → 102 s** → C3 dropped → **C1 concurrency built & REVERTED: the
bridge serializes fs** → read-probe deferred → **pack-writes**). `docs/capture-concurrency-spec.md`
(C1 — the measured proof the bridge won't parallelize; §7 is the load-bearing evidence).
`docs/perf-baseline-2026-07-23.md` → "C4 landed" (the 102 s split), "C1 measured", "Read-path
probe". `docs/sync-engineering-guide.md` §5 (invariants — the data-safety spine), §7 (capture
gotchas) — **must not break**. `src/core/content-store.ts` (the store this reshapes).

**Ground rule (from A3 §0):** no published release, no users. `.vault-sync/` is disposable
(delete + re-enable, or **Rebuild sync metadata**). Build for the clean end-state; write **no
migration code** — the store may change on-disk format freely.

---

## 1. Context — where this sits (the current 102 s, and why writes are the target)

After C4 (direct non-atomic blob write), the on-device first-enable at F=8389 is **102 s**:

| phase | s | % | nature |
|---|--:|--:|---|
| **putMs** (`contentStore.putNew` → one `writeDirect`) | 50–56 | ~52% | **serial** native writes — **this spec** |
| readMs (`files.read`) | 31.6 | 31% | serial native reads — a floor (read-probe §, no cut) |
| otherMs (per-200-op registry+oplog checkpoints) | 13.5 | 13% | serial atomic rewrites — next spec |
| hashMs (SHA-256) | 1.3 | 1% | CPU |

Two prior measurements fence this in:

1. **The per-call-latency finding (A3):** on the Android/Capacitor bridge a native fs call is
   ~pure latency (~2–8 ms) **independent of payload** — `rename` cost as much as a byte write while
   moving no bytes. So the write cost is native-call **count**, not bytes or CPU. `put.encodeMs`
   (base64) is 0.5 s / 0.6% — the bytes are free; the ~8389 round-trips are the cost.
2. **C1 settled that overlap can't help** (`docs/capture-concurrency-spec.md` §7): K=8 concurrency
   **regressed** 102 → 120 s because the bridge services fs calls one at a time. So the write half
   cannot be parallelised; it can only be made to issue **fewer calls**. That is exactly what
   packing does, and it works *because* the bridge is serial.

**Conclusion:** cut the write-call count. ~8389 blob writes → ~42 pack appends (one per
200-blob checkpoint) is the lever.

---

## 2. The problem — one native write per blob

`ContentStore.putNew(hash, content)` (`src/core/content-store.ts`) does, per file:

```
if (memCache.has(hash)) return;      // in-session dedup, no I/O
memCache.set(hash, content);
ensureShard(hash);                   // ≤256 mkdirs total, amortised
b64 = uint8ToBase64(content);        // CPU, 0.6%
await metadata.writeDirect(content/<h[0:2]>/<h>.bin, b64);   // ← ONE native write per blob
```

On first enable the registry is empty, so every file reaches the `writeDirect` — ~8389 serial
native writes, back-to-back, at ~6 ms each ≈ the 50–56 s. No cross-blob dependency; they are
issued one at a time only because each is its own file.

---

## 3. Design — append blobs into packs, one native write per checkpoint

Follow the **git loose-vs-packed** model, adapted to the string-based `MetadataStore` and its
existing **`append`** primitive (already O(delta) / one native call — the version-DAG journal uses
it; port doc line 28–32).

### 3.1 Pack format (text, append-framed)

A pack is a text file `content/pack/<packId>.pack`. Blobs are appended as length-framed records:

```
<hash> <charLen>\n      ← header line: 64-hex hash + the base64 payload's char length
<base64 payload>\n      ← the C4 base64 body, unchanged
```

base64 is ASCII, so char offset == byte offset; the header's `charLen` lets the reader slice the
body without a delimiter scan. The **index** maps `hash → { packId, offset, len }` where `offset`
is the char position of the payload within the pack. (`append` concatenates, so offsets are stable
and monotonic within a pack.)

### 3.2 Write path — buffer per chunk, append once

`putNew` in **capture (pack) mode** buffers instead of writing:

```
putNew(hash, content):
  if memCache.has(hash) return           // unchanged in-session dedup
  memCache.set(hash, content)
  buffer.push({ hash, b64: uint8ToBase64(content) })   // no I/O — just CPU encode + RAM
```

At each capture checkpoint (every `CAPTURE_CHECKPOINT_EVERY = 200`, aligned with the existing
registry+oplog checkpoint), `flushPack()`:

```
flushPack():
  if buffer empty return
  packBody = ""; idxDelta = ""
  for {hash, b64} in buffer:
    off = packCharLen + header.length
    packBody += `${hash} ${b64.length}\n${b64}\n`
    idxDelta += `${hash} ${packId} ${off} ${b64.length}\n`
    index.set(hash, {packId, off, len: b64.length}); packCharLen += record.length
  await metadata.append(content/pack/<packId>.pack, packBody)   // ← ONE native write / chunk
  await metadata.append(content/pack/index,          idxDelta)  // ← ONE native write / chunk
  buffer = []
```

So a 200-blob chunk costs **2 native writes** (pack + index) instead of 200. ~8389 blobs → ~42
chunks → ~84 native writes. Memory is bounded to one chunk of buffered base64 (~a few MB), the same
bound the current per-chunk `clearMemCache` already accepts.

**Ordering (blob-before-op-checkpoint — §4):** `flushPack()` runs **before** the chunk's
`saveOpLog()` in the checkpoint, so every blob an op references is durable before that op is
journalled.

### 3.3 Read path — loose first, then packs

`get(hash)` gains a pack fallback after the loose-blob check:

```
get(hash):
  if memCache has → return (unchanged)
  if loose content/<h[0:2]>/<h>.bin exists → read + hash-verify (C4, unchanged)
  else if index.has(hash):
    pack = await metadata.read(content/pack/<packId>.pack)     // whole-pack read (no ranged read)
    body = pack.substr(offset, len)
    content = base64ToUint8(body)
    if hashContent(content) !== hash → return null             // C4 hash-verify, per blob
    memCache.set(hash, content); return content
  return null
```

**Whole-pack read on `get`** is the cost of no ranged-read primitive (§8). Mitigations: (a) the
`memCache` — reading a pack can cache *all* its blobs, so a sync round that uploads every blob reads
each pack once; (b) blob `get`s are otherwise rare (merge bases, on conflict); (c) cap pack size
(§8). This is a steady-state/merge read cost, **not** on the capture hot path (capture only writes).

### 3.4 Coexistence — loose (steady-state) + packed (capture)

- **Capture bulk** (`putNew`, first-enable) → **packed** (this spec).
- **Steady-state single edits** (`put`, one blob per debounced save) → stay **loose** `.bin`
  (unchanged; low volume, keeps the simple atomic-ish path, no pack churn per keystroke).
- `has(hash)` → loose `exists` **or** `index.has(hash)`.
- `listHashes()` → the 256-shard loose sweep **plus** the index's keys.
- On store load, rebuild the in-memory `index` by reading `content/pack/index` (append-only; a torn
  trailing line is dropped, exactly like the DAG journal reader).

### 3.5 GC — the open hard part (§8)

`gc(keepHashes, retentionMs, now)` deletes unreferenced loose blobs by mtime today. A blob inside a
pack **cannot be deleted individually** (no in-place edit). Options, deferred to §8: (a) whole-pack
retention (keep a pack until *all* its blobs are unreferenced, then delete the file); (b)
mark-and-compact (rewrite a pack without its dead blobs during GC). Since first-enable packs are
mostly all-referenced (every captured file is live), (a) is likely enough for now.

---

## 4. Invariants that must not break (guide §5/§7)

- **C4 hash-verify-on-read.** Preserved per blob: a packed blob is extracted, hashed, and verified
  against its name on every `get`; a mismatch reports **missing** (F1), never corrupt bytes into a
  merge. A torn trailing `append` (crash mid-flush) leaves a short/unparseable final record → that
  blob reads as missing, same safety as a torn loose `writeDirect`.
- **Blob-before-op checkpoint.** `flushPack()` (pack + index appends) completes **before** the
  chunk's `saveOpLog()`. A crash between strands blobs with no op (recoverable), never an op
  referencing an unwritten blob. Buffered-but-unflushed blobs at a crash have **no** saved op either
  (op save is after flush), so the chunk simply re-captures.
- **Registry-then-oplog ordering.** Unchanged — `flushPack` slots *before* `registry.flush()` /
  `saveOpLog()` in the same checkpoint.
- **Idempotent content-addressed writes.** A hash names its exact bytes; re-appending an
  already-packed hash is avoided by the in-session `memCache` dedup and, across sessions, by the
  loose/index `has` check (skip if already stored). Disposable store + no-migration means no
  cross-format reconciliation is owed.
- **`listHashes` completeness (GC safety).** Must return loose **and** packed hashes, or GC would
  delete live loose blobs it thinks are unreferenced / miss packed ones. The union in §3.4 covers
  both under the one-level-`list` device semantics (the shard sweep) and the index.
- **Memory bound.** One chunk of buffered base64 (~MB), released at each `flushPack`. No worse than
  today's per-chunk `clearMemCache`.

---

## 5. Testing plan

Drive the **real** stack (TestDevice over the in-memory fakes; guide testing doctrine).

- **Round-trip:** capture a seeded vault → every file's blob reads back by its registry hash
  (`get` extracts from the pack, C4-verifies) with byte-identical content, incl. duplicate-content
  files sharing one packed hash.
- **Write-count assertion:** the fake `MetadataStore` counters (`io.writesDirect`, `io.appends`)
  show ~`ceil(F/200)` pack appends + index appends and **~0 per-blob** blob writes on first-enable
  (the whole point) — contrast the pre-pack `writesDirect ≈ F`.
- **Torn-pack safety:** truncate a pack's trailing record on disk → that blob's `get` returns null
  (missing, not corrupt); earlier blobs in the pack still read fine.
- **Crash-safety cadence:** oplog + pack + index all persisted per chunk; an abort/crash loses
  < CHUNK blobs *and* their ops together (consistent), tail re-captured next enable — extend
  `capture-crash-safety` / `capture-cancellation`.
- **Loose + packed coexistence:** a steady-state `put` after capture writes a loose blob; `get`,
  `has`, `listHashes` all see both loose and packed hashes; `gc` keeps referenced ones.
- **Index rebuild on reload:** after capture, drop the in-memory index and reload from
  `content/pack/index`; all packed hashes resolve.
- **Existing suites green:** `offline-capture`, `capture-stat-gate`, `content-store-gc`,
  `round-stat-gate` (the warm-memCache tail still holds — packed blobs stay in memCache across the
  final chunk).
- **On-device re-measure:** repeat A3 §3.2 (first-enable reset); record the new total + split.

---

## 6. Projection & what this settles

If `append` is one native call (~6 ms) like every other bridge write: ~84 appends ≈ **~0.5 s** +
`encodeMs` ~0.6 s ≈ **~1 s** for the write phase (from 50–56 s). Total **~102 s → ~52 s**.

**What the device run settles:**
1. **Is `append` truly O(delta) / one native call on Capacitor?** The whole win rests on it (§8).
   If `append` secretly rewrites the whole file, packs regress like a growing registry — verify
   first (a micro-measurement: append 200× and time it).
2. **Confirms the next-dominant cost.** Post-pack the top lines are the **read floor (~24–31 s)**
   and the **checkpoint `otherMs` (~13 s)**. The checkpoints (serial O(F²) atomic registry+oplog
   rewrites) become the next spec (append-only oplog journal / fewer checkpoints); reads are a floor
   (read-probe deferred).

---

## 7. Scope / non-goals

- **In:** the capture write path (pack format, buffered `putNew`, `flushPack` at checkpoint), the
  `get`/`has`/`listHashes` pack fallback, index persistence + reload, whole-pack retention GC.
- **Out:** steady-state single `put` (stays loose); ranged reads; pack compaction (whole-pack
  retention first); the read phase (a floor); the checkpoint `otherMs` (next spec).

---

## 8. Open questions

- **`append` semantics on device** — §6.1. The load-bearing assumption. Micro-measure before
  building.
- **No ranged read → whole-pack `get`.** Acceptable given memCache + rarity? Or cap pack size (e.g.
  one pack per checkpoint = ≤200 blobs, already bounded) so a `get` reads ≤ one chunk. Is a
  per-chunk pack (~42 packs) better than one big pack (1 file, but every `get` reads all of it)?
  Leaning **per-chunk packs**.
- **GC compaction** — §3.5. Whole-pack retention vs mark-and-compact. Whole-pack likely suffices
  for first-enable (all-referenced); revisit when steady-state churn packs.
- **Index format & torn-append recovery.** One append-only `index` file mirroring the DAG journal's
  drop-unparseable-trailing-line reader; or self-describing packs (scan headers on load, no separate
  index). Leaning **append-only index** for O(1) load without scanning pack bodies.
- **Encode-then-buffer memory.** Buffering a chunk of base64 (~MB) is fine; confirm it doesn't
  interact with the mobile GC cliff the checkpointing already guards.
