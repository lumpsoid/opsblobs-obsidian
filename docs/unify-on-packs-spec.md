# Vault Sync — Unify-on-Packs Spec (one blob format, packs only)

**Status:** PROPOSED · **Date:** 2026-07-25 · **Owner:** client/perf

**One sentence:** the content store keeps **two** on-disk blob formats — loose `.bin`
(one file per blob, the steady-state write path) and packs (many blobs per file, the
first-enable capture path) — so the optimised format is exercised only at first-enable
while every steady-state and apply write silently takes the slow loose path; this spec
makes **packs the single format**, routes every write through the buffered pack path, and
replaces whole-pack-only GC with **mark-and-compact** so packs can be the sole durable
store without leaking disk.

This document is written to be picked up **cold**, with no prior conversation context.

**Companion (do second):** `docs/apply-path-pack-writes-spec.md` — wires the sync
**applicator** (the `applyMerge` / `applyActions` path) onto the unified buffered pack
write this spec defines, turning a first full pull of an 8k vault from ~8k loose blob
writes (measured **applyMerge ≈ 200 s of a 230 s round**) into ~tens of pack appends. That
spec depends on the write API and GC contract defined here; land this one first.

**Parent / companions:** `docs/pack-writes-spec.md` (A3 — introduced the pack format for
capture; §3.4 "coexistence" and §3.5 "GC — the open hard part" are exactly what this spec
closes). `docs/startup-capture-optimization-spec.md` (A3 umbrella — the per-call-latency
finding: on the Capacitor bridge a native fs call is ~pure latency independent of payload,
so cost is native-call **count**). `docs/sync-engineering-guide.md` §5 (data-safety
invariants) / §7 (capture gotchas) — **must not break**. `src/core/content-store.ts` (the
store this reshapes). `src/main.ts` `clearContentCache` (the one GC caller).

**Ground rule (from A3 §0):** **no published release, no users, no back-compat owed.**
`.vault-sync/` is disposable (delete + re-enable, or **Rebuild sync metadata**). Build for
the clean pack-only end-state; write **no migration code** and **remove the loose format
outright** — do not keep a loose-read fallback "just in case." A dev vault with stale loose
`.bin` files is reset, not migrated.

---

## 1. Context — two formats, and why that is the problem

`ContentStore` (`src/core/content-store.ts`) today stores a blob two ways:

| format | written by | read by | GC |
|---|---|---|---|
| **loose** `content/<h[0:2]>/<h>.bin` (base64, one file/blob) | `put` — steady-state + apply + baseline | `get` loose branch (`:229`) | per-blob mtime (`gc`, `:328`) |
| **pack** `content/pack/<id>.pack` + `content/pack/index` | `putNew`+`flushPack` — first-enable capture only | `get` pack fallback (`getFromPack`, `:250`) | whole-pack only (`gcPacks`, `:355`) |

Three problems follow from keeping both:

1. **The optimised path is barely exercised.** Packs (the A3 win: ~8389 native writes →
   ~42 appends, **56 s → 1.1 s** first-enable) run *only* at first-enable. Every steady-state
   edit, baseline re-assert, and — the expensive one — every **apply** write takes the loose
   path (one native write + one `exists` probe per blob). The fast format is the exception,
   not the rule. It will "silently drift" — bit-rot, lose test coverage, and never benefit the
   paths that need it most (bulk apply).

2. **Loose is never actually cheaper.** Even for a *single* steady-state edit, loose is
   `exists` probe + write ≈ 2 native ops; a 1-blob pack is pack-append + index-append ≈ 2
   native ops. Break-even at one blob; loose *loses* at every count above one (the apply path's
   8k). The §3.4 "keep loose for single edits, no pack churn per keystroke" rationale does not
   survive measurement — there is no write-side regime where loose wins.

3. **Two GC contracts, two `listHashes` branches, two read branches** — every store operation
   forks on format (`get`/`has`/`listHashes`/`delete`/`gc` all have a loose arm and a pack
   arm). Halving that is a real simplification of the data-safety-critical core.

**The one thing loose genuinely buys** is **precise per-blob reclamation**: each blob is its
own file, so `gc` deletes exactly the unreferenced+aged blobs (`:340`). Packs can't delete a
blob individually (no in-place / ranged write), and `gcPacks` today drops a pack only when
**every** blob in it is unreferenced (`:364`). That is fine for first-enable packs ("mostly
all-referenced" — §3.5) but **not** for steady-state churn, where a pack accumulates dead
superseded versions while one cold-but-live blob pins the whole file forever. Closing that
gap — **mark-and-compact** (§4) — is the one piece of genuinely new work this spec adds; it
is the price of dropping loose, and it is what pack-writes-spec §3.5 explicitly deferred.

---

## 2. Design overview — packs are the format

Delete the loose format. Every blob is written by buffering into `packBuffer` and appending
to a pack; every blob is read from the in-memory `index` → its pack; GC works at pack
granularity with a compaction pass to reclaim dead bytes from sparse packs.

### 2.1 The write API — one buffered primitive, two entry points

Keep the existing buffered primitive (`putNew`, `:165`) as the single write mechanism, and
express the durability boundary explicitly:

```
putBuffered(hash, content):        // was putNew — buffer only, NO I/O
  if memCache.has(hash) return
  memCache.set(hash, content)
  packBuffer.push({ hash, b64: uint8ToBase64(content) })

put(hash, content):                // durable single blob (steady-state edits)
  putBuffered(hash, content)
  await flushPack()                // 1-blob pack + index append = 2 native writes

flushPack():                       // unchanged (:200) — append buffer as one pack + index delta
```

- **Bulk writers** (first-enable capture; the **apply** path per the companion spec) call
  `putBuffered` in a loop and `flushPack()` once per batch/checkpoint — amortised to ~2 native
  writes per chunk.
- **Steady-state single edits** call `put`, which flushes immediately for durability. A
  1-blob pack is the cost; mark-and-compact folds the accumulation of these back together.

This is exactly today's `put`/`putNew` split **inverted**: `putNew` becomes the general
mechanism and `put` becomes the thin "flush now" convenience, instead of `put` being a
separate loose code path. All nine current `put` callers keep calling `put` unchanged; they
just get pack-backed durability. (The companion spec then upgrades the five *applicator*
callers to the buffered form for batch amortisation.)

### 2.2 Removals — the entire loose surface

Delete, with no replacement:

- `put`'s loose body (the `metadata.exists` + `metadata.write(contentPath, b64)` at `:141`),
  `contentPath` (`:409`), `ensureShard` / `ensuredShards` (`:400`), `SHARD_PREFIXES` (`:54`),
  `listLooseHashes` (`:307`), the loose branches of `get` (`:229`), `has` (`:269`), `delete`
  (`:279`), and the loose arm of `gc` (`:329`).
- `CONTENT_DIR` stays (the pack dir lives under it); the 256 shard dirs are no longer created.

After this, `get` is `memCache → getFromPack`; `has` is `memCache || index.has`; `listHashes`
is `[...index.keys()]`; `delete` drops the index entry (bytes reclaimed by compaction, §4).

### 2.3 Read path (unchanged semantics)

`getFromPack` (`:250`) already whole-pack-reads and hash-verifies (C4) per blob, caching every
blob in the pack. That becomes the *only* read path. Whole-pack read amortises across a round
(memCache), blob reads are rare (merge bases / conflicts), and packs are bounded to one chunk
(§ pack-writes-spec §3.3). No change needed beyond deleting the loose pre-check.

---

## 3. Durability & crash-safety (guide §5)

- **Content-addressed hash-verify-on-read (C4).** Preserved — `getFromPack` hashes every
  extracted blob against its name and reports a mismatch as **missing** (F1), never corrupt
  bytes into a merge. A torn trailing pack/index `append` (crash mid-flush) drops that blob →
  reads missing → re-captured. Same safety loose `writeDirect` had, now the only path.
- **Blob-before-op ordering.** Unchanged: `flushPack()` runs before the referencing op is
  journalled (capture checkpoint; and per the companion spec, before the apply's `clearOps`/
  `registry.flush()`). A crash between strands blobs with no op (recoverable), never an op
  citing an unwritten blob.
- **Single-edit durability.** `put` flushes synchronously, so a steady-state edit's blob is on
  disk (its own 1-blob pack) before its op is recorded — identical guarantee to the old loose
  write, same ordering point in `flushModify` (`:612` → `:615` recordOp).
- **Idempotent re-append.** A hash names its exact bytes; in-session `memCache` dedups, and a
  re-appended already-packed hash is byte-identical — a duplicate index entry (last wins on
  load) wastes a little space, reclaimed by compaction. Disposable store ⇒ no cross-format
  reconciliation owed.

---

## 4. GC — whole-pack retirement + mark-and-compact (the new work)

`gc(keepHashes, retentionMs, now)` becomes pack-only. Two mechanisms, both off the hot path
(GC runs from `clearContentCache`, user/settings-triggered):

**Retention model.** A blob is *live* if `keepHashes.has(hash)` (registry-referenced: live
content + DAG-reachable merge bases of each live head — `main.ts:737`). An unreferenced blob is
kept while *young* so recent ancestors survive as merge bases. With packs, age is taken at
**pack** granularity (`stat(pack).mtime`) — sound because a pack's blobs are written together
and so age together; compaction writes surviving blobs into a fresh pack, resetting their clock
(and they survive only *because* they are live, so their reset age is immaterial).

**4.1 Whole-pack retirement (keep, tightened).** For each pack: if **no** blob is live AND the
pack file has aged past `retentionMs`, remove the pack file and drop its blobs from `index` +
`memCache`. (This is today's `gcPacks` (`:363`) with the age check — unchanged.)

**4.2 Mark-and-compact (new).** For each pack that is **aged** past `retentionMs` and holds a
**mix** of live and unreferenced blobs, and whose *live fraction* is below a threshold
(`COMPACT_LIVE_FRACTION`, e.g. 0.5 — only repack when enough is dead to be worth it):

```
compactPack(packId):
  live = [h for h in members(packId) if keepHashes.has(h)]   // unreferenced+aged blobs are dropped
  read the old pack once (whole-pack, already cached by getFromPack semantics)
  for h in live: putBuffered(h, bytes(h))                     // re-buffer live blobs
  await flushPack()                                           // → a fresh pack, live blobs only
  remove old pack file; drop old index entries for its members
  (rewriteIndex folds both the new entries and the drops)
```

This reclaims the dead bytes a cold-but-live blob was pinning — the precise reclamation loose
gave, now at pack granularity, batched. Bounded: compaction only touches aged, mostly-dead
packs, and re-buffers ≤ one pack's live blobs at a time.

**4.3 Index rewrite.** After any retirement or compaction, `rewriteIndex` (`:387`) persists the
surviving index atomically (unchanged). Append-only in steady state; wholesale only here.

**Ordering.** Compaction must write the fresh pack + index delta **before** removing the old
pack, so a crash mid-compact leaves the blob reachable via *either* the old or new pack (both
present briefly), never neither. `getFromPack` tolerates the transient duplicate (last index
entry wins; both hold identical bytes).

**Tuning knobs (constants, top of file):** `COMPACT_LIVE_FRACTION` (default 0.5),
reuse `retentionMs` from settings (`ancestorRetentionDays`). No new settings UI.

---

## 5. Invariants that must not break (guide §5/§7)

- **`listHashes` completeness (GC safety).** Must return every stored hash or GC deletes live
  blobs / misses dead ones. Pack-only ⇒ `[...index.keys()]` is complete by construction (the
  index is the durable mirror of every packed blob). Simpler and *more* correct than the old
  loose-sweep-∪-index union.
- **`keepHashes` is authoritative.** Compaction/retirement never drop a blob in `keepHashes`,
  regardless of pack age. A live blob is always carried into the fresh pack.
- **Never delete-then-lose.** Old pack removed only after the new pack + index are durable
  (§4.2 ordering). Dateless/unstattable pack ⇒ kept (conservative, mirrors loose `:340`).
- **C4 hash-verify preserved on the sole read path** (§3).
- **Memory bound.** Write buffers one chunk of base64 (~MB), released each `flushPack`;
  compaction re-buffers ≤ one pack. No worse than today.

---

## 6. Testing plan (drive the real stack — TestDevice over fakes; guide doctrine)

- **Single-edit durability:** a steady-state `put` (one modify) writes a 1-blob pack; `get`
  reads it back C4-verified; the fake `MetadataStore` shows **0** loose `.bin` writes anywhere.
- **No loose format:** after capture + steady edits + an apply, `listHashes`/`has`/`get` all
  resolve purely from packs; assert no `content/<xx>/*.bin` path is ever written.
- **Whole-pack retirement:** a pack whose blobs all go unreferenced + age past retention is
  removed; young or partially-live packs are kept.
- **Mark-and-compact:** seed a pack of N blobs, keep 1 referenced, age it, run GC → a fresh
  pack holds exactly the live blob, the old pack file is gone, `index` lists only survivors,
  the freed hashes read missing, the live hash still reads.
- **Compact crash-safety:** simulate a crash between "new pack written" and "old pack removed"
  → the live blob still resolves (duplicate index entry tolerated); between buffer and flush →
  old pack intact, live blob resolves.
- **Round-trip / dedup:** duplicate-content files share one packed hash; re-`put` of a present
  hash is a no-op write (memCache) or byte-identical re-append.
- **Existing suites green:** `content-store-pack`, `content-store-gc` (rewritten for pack-only),
  `offline-capture`, `capture-crash-safety`, `round-stat-gate`.
- **On-device re-measure:** first-enable unchanged (already packs); confirm steady-state edits
  and (companion) apply now show pack appends, not loose writes.

---

## 7. Scope / non-goals

- **In:** delete the loose format end-to-end; make `putNew`(→`putBuffered`) the sole write
  mechanism with `put` = buffer+flush; pack-only `get`/`has`/`listHashes`/`delete`; GC =
  whole-pack retirement + **mark-and-compact**; update the one GC caller.
- **Out:** the applicator batch wiring (companion spec — depends on this); ranged reads; pack
  size re-tuning (per-chunk packs stay); any migration/back-compat (there are no users);
  network/fetch changes.

---

## 8. Open questions

- **`COMPACT_LIVE_FRACTION` value.** 0.5 is a guess. Too high → churny repacking; too low →
  slow reclamation. Could start conservative (0.25 — only repack near-dead packs) and measure
  disk over a churn simulation. Not load-bearing for correctness.
- **1-blob-pack proliferation between GCs.** Steady-state `put` makes one pack per edit; that
  is the same file count loose had, and compaction folds them — but confirm the `index` append
  per single edit stays flat (append-bench already showed small appends are O(delta)).
- **Compaction trigger cadence.** Today GC is manual (`clearContentCache` from settings). Is
  that frequent enough to keep churn bounded, or should a sync round trigger a cheap
  opportunistic compact when sparse-pack count crosses a threshold? Leaning: keep it in GC for
  now; revisit if disk grows in practice.
- **Whole-pack read on compaction.** Compacting reads each stale pack fully once; fine off the
  hot path, but if many packs compact in one GC, cap the number per pass to bound wall-clock.
