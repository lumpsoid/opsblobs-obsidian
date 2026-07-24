# Vault Sync — Registry Append-Journal (the `otherMs` registry half) — **IMPLEMENTATION SPEC**

**Status:** ✅ **DONE + ON-DEVICE CONFIRMED (2026-07-25).** Landed in `src/core/file-registry.ts` (+
`compact()` wired into the capture and merge-apply `finally`s in `operation-logger.ts` /
`sync-applicator.ts`). Direction chosen — supersedes the three-way A/B/C debate in
`docs/registry-checkpoint-cost-spec.md` (that memo is now the *why*; this is the *how*). · **Date:**
2026-07-24 (built + confirmed 2026-07-25) · **Owner:** client/perf

**Result (F=8389, on device):** `regFlushMs` **5.76 s → 0.34 s (~17×, beat the < 1 s target by 3×)** —
`reg.writeMs` 4.86 s → 0.23 s, `reg.stringifyMs` 0.78 s → 0.03 s. `otherMs` 8.05 s → **2.58 s**; first-enable
total 37.72 s → **33.64 s**. The registry is no longer a lever; `readMs` (27.8 s ≈ 83% of total) is now the
whole remaining cost. Both write-side O(N²) checkpoint costs (this + the oplog) are solved. Tests:
`__tests__/registry-append-journal.test.ts` (round-trip, LWW, hard-delete `{del}`, intra-window 1-line
collapse, torn-tail, compaction/no-pretty-print, crash-order idempotent replay, migration, opportunistic
load-compact), the §4-Q3 durability gate in `__tests__/capture-crash-safety.test.ts`, and the O(delta)
append-volume guard in `__tests__/perf-timing.test.ts`. **312 tests green.** Full readout:
`docs/perf-baseline-2026-07-23.md` → "The registry append-journal — on-device confirmed".

**One-line goal:** replace the whole-registry rewrite at each first-enable checkpoint
(`file-registry.ts:flush`, measured `regFlushMs` **5.76 s = 72% of the remaining 8.05 s `otherMs`**)
with an **append-only, last-write-wins keyed journal + periodic snapshot compaction** — an O(delta)
write per checkpoint instead of an O(N) rewrite, collapsing the triangular O(N²) write volume to
O(F). Target: `regFlushMs` ~5.76 s → **< 1 s**. **Achieved: 0.34 s.**

This document is written to be picked up **cold**. Read
`docs/registry-checkpoint-cost-spec.md` (the design memo it graduates) and
`docs/sync-engineering-guide.md` §5 (registry = data-safety spine) first only if you need the
background rationale; the design and the crash-safety proof below are self-contained.

---

## 0. Why this shape (the decision, compressed)

The design memo listed three families: **A** (write less often — capped, stays O(N²), and can't
safely decouple its cadence from the oplog without re-coupling), **B** (LSM append-journal — the true
asymptotic fix), **C** (oplog-as-truth, reconstruct on crash — largest blast radius). This spec picks
**B**, sharpened by three facts discovered in code that shrink its cost dramatically:

1. **It's a persistence-layer-only change.** `grep` confirms **nothing outside `file-registry.ts`
   reads the registry file** — every consumer (`getById`, `getByPath`, `getActiveEntries`,
   `referencedHashes`, `reconcileWithVault`, and all external readers via `buildLocalIdentity`) goes
   through the in-memory `Map<uuid, FileEntry>`. As long as `load()` rebuilds the **identical** Map,
   **zero consumers change.** This is the fact that refutes the memo's §2 complication #3 ("wider
   blast radius"). The change is contained to `load()`, `flush()`, mutation dirty-tracking, and a new
   `compact()`.
2. **The pattern already ships twice in this repo.** `ContentStore`'s `pack/index`
   (`content-store.ts:113` `loadPackIndex`) and the version-DAG journal are both append-only keyed
   logs replayed last-write-wins into a Map, torn-tail-tolerant, with a wholesale rewrite for
   compaction (`rewriteIndex`). This spec copies that proven machinery; it is not green-field.
3. **The primitives are purpose-built.** `MetadataStore.append` is documented as "a torn trailing
   append is tolerated by the journal reader, which drops an unparseable final line";
   `MetadataStore.write` is atomic (tmp+rename). Journal = `append`, snapshot = `write`.

**Every `flush()` call site already orders it correctly** — the capture loop and the merge applicator
call `flushPack()` → `registry.flush()` → `appendOpLog()` (`operation-logger.ts:222`/`330`/`391`,
`sync-applicator.ts:147`). The registry-before-oplog ordering lives in the *callers* and is
untouched; only what `flush()` *does* changes.

---

## 1. On-disk layout

Two files under `.vault-sync/`:

- **`file-registry.json`** — the **snapshot**. Exactly today's format
  (`{ version: 1, entries: [[uuid, FileEntry], …] }`), written **only by `compact()`**, atomically.
  Drop the `null, 2` pretty-print — it is machine-read and pretty-printing ~doubles the byte volume
  for no benefit (a free ~2× on the compaction write).
- **`file-registry.journal`** — **append-only NDJSON**, one record per line, of every entry mutation
  *since the last snapshot*. Two record shapes:
  - **upsert:** the full `FileEntry` JSON — `{"id":"…","path":"…",…}`. Last line for an id wins.
  - **delete:** `{"del":"<uuid>"}` — a hard removal from the Map (`adoptRemote`'s divergent-duplicate
    drop, `gcPacks`-style). The `deleted:true` *tombstone flag* is an ordinary field on an upsert
    record; `{"del":…}` is the rarer **hard** Map-delete.

Full-entry-per-line (not field-deltas) is deliberate: it makes replay a trivial last-write-wins
`set`, needs no partial-merge logic, and entries are ~200 B so the delta stays O(touched entries) —
mirroring how `pack/index` writes one full locator line per change.

---

## 2. Data-structure change

Replace the single `dirty: boolean` with a **touched-key set**:

```ts
private entries: Map<string, FileEntry>;   // unchanged — the single source of truth for all reads
private pathIndex: Map<string, string>;    // unchanged
private dirtyIds: Set<string> = new Set(); // ids upserted-or-deleted since the last append
private deferSave = false;                  // unchanged (suspendSaves during batches)
```

Every mutation method (`registerFile`, `updatePath`, `updateContentHash`, `recordStat`,
`markDeleted`, `applyRemoteEntry`, `adoptRemote`, `setHeadVersion`, `markConflicted`, `clearConflict`,
`reconcileWithVault`) does exactly what it does today to `entries`/`pathIndex`, then instead of
setting `dirty = true` records **which id it touched**: `this.dirtyIds.add(id)` (and for the two
methods that hard-`delete` from the Map, add the deleted id too). `save()` is unchanged in shape —
mark dirty, and if not deferred, `flush()`.

Resolving upsert-vs-delete at flush time from the live Map (see §3) means a single `Set` handles both
cases and any number of intra-window mutations to the same id (register → setHeadVersion → recordStat
collapse to **one** appended line — strictly better than three).

---

## 3. The three operations

### `flush()` — O(delta) append (was: O(N) rewrite)

```ts
async flush(): Promise<void> {
  if (this.dirtyIds.size === 0) return;
  if (!(await this.metadata.exists('.vault-sync'))) await this.metadata.mkdir('.vault-sync');
  let delta = '';
  for (const id of this.dirtyIds) {
    const e = this.entries.get(id);
    delta += (e ? JSON.stringify(e) : JSON.stringify({ del: id })) + '\n';
  }
  // one native append per checkpoint — the O(delta) win (mirrors ContentStore.flushPack)
  await this.metadata.append(REGISTRY_JOURNAL_PATH, delta);
  this.dirtyIds.clear();
}
```

Resolve each touched id against the live Map: still present → upsert line; gone → `{del}` line. This
is correct for `adoptRemote` (drops `existingId`, adds `id` — one del line + one upsert line) and for
register-then-delete-then-recreate within a window (final Map state wins). Keep the
`captureFlushPerf` sub-split hooks; `stringifyMs` now measures the delta serialize, `writeMs` the
append.

### `load()` — snapshot then journal replay (rebuilds the identical Map)

```ts
async load(): Promise<void> {
  const snapRaw = await this.metadata.read(REGISTRY_PATH);
  this.entries = snapRaw ? new Map((JSON.parse(snapRaw) as SerializedRegistry).entries) : new Map();
  const jrnl = await this.metadata.read(REGISTRY_JOURNAL_PATH);
  if (jrnl !== null) {
    for (const line of jrnl.split('\n')) {
      if (line === '') continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; } // torn trailing line → drop (append only cuts the end)
      if (rec && typeof rec.del === 'string') this.entries.delete(rec.del);
      else if (rec && typeof rec.id === 'string') this.entries.set(rec.id, rec); // last-write-wins
    }
  }
  this.rebuildPathIndex();
  await this.maybeCompactOnLoad(jrnl);   // §3 compaction trigger
}
```

Torn-tail safety is identical to `loadPackIndex`: only the final line can be partial (append cuts the
end); `JSON.parse` fails on it → skipped; interior lines are intact. A dropped tail entry reads as
"registry slightly behind" → strands that file → rebaseline heals (the *safe* direction — see §4).

### `compact()` — snapshot-then-truncate, both atomic

```ts
async compact(): Promise<void> {
  const data: SerializedRegistry = { version: 1, entries: Array.from(this.entries.entries()) };
  await this.metadata.write(REGISTRY_PATH, JSON.stringify(data));   // atomic (tmp+rename), no pretty-print
  await this.metadata.write(REGISTRY_JOURNAL_PATH, '');             // atomic truncate — MUST come second
  this.dirtyIds.clear();
}
```

**Ordering is load-bearing: snapshot first, truncate second, never the reverse.** A crash *after* the
snapshot write but *before* the truncate leaves a redundant journal, which replays idempotently onto
an already-current snapshot (last-write-wins) — no harm. A crash that truncated first would lose every
mutation the journal still held. Both writes are atomic, so neither the snapshot nor the truncate can
tear.

**When `compact()` fires** (all off the per-checkpoint hot path):

1. **End of `captureOfflineChanges`** — after `resumeSaves()` in the `finally`. The first-enable
   journal (~F lines) collapses into one clean snapshot before steady state. This single full write ≈
   **one** of today's 42 per-checkpoint rewrites, vs all 42 — the whole point.
2. **End of the merge-apply batch** — `sync-applicator.ts:147`, alongside the existing
   flush/resumeSaves.
3. **Opportunistically on load** (`maybeCompactOnLoad`) — if the journal that was just replayed is
   large relative to the snapshot (e.g. `journal.length > snapshot.length`, or line count exceeds
   `max(1000, 2 × entries.size)`), rewrite the snapshot and clear the journal. Load already paid the
   read+replay, so this is near-free and **bounds every subsequent load**.
4. **Safety valve inside the live path** — an interactive session that never reloads and never syncs
   could grow the journal unbounded via per-mutation `save()` appends. Add the same size check at the
   tail of a non-deferred `flush()`; when it trips, `compact()`. Amortized O(1) per mutation, off the
   deferred (capture) path entirely.

Note the deliberate asymmetry: **compaction never runs at a capture checkpoint** — checkpoints are
pure appends. That is what keeps the O(N²) rewrite from sneaking back in.

---

## 4. Crash-safety: the registry-before-oplog invariant is preserved (proof)

The invariant (`operation-logger.ts:312`): *on disk the registry must never lag the oplog.* A crash
must strand files (registry ahead → rebaseline heals) and **never** orphan ops (oplog ahead →
referencing unregistered files). Callers still `flush()` before `appendOpLog()`. Enumerate the crash
windows:

| Crash point | Journal state | Oplog state | Result | Safe? |
|---|---|---|---|---|
| After journal append, before oplog append | entries committed | ops not yet written | registry **ahead** → files stranded | ✅ rebaseline heals |
| *During* journal append (torn tail) | trailing entries of this delta dropped | ops not yet written (append is later) | those files' ops were never journalled → **no orphan**; registry ≥ oplog | ✅ re-captured next enable |
| During oplog append (journal already committed) | full | torn oplog tail drops trailing ops | oplog **behind** → registry ahead | ✅ (unchanged from today) |
| During `compact()` snapshot write | old snapshot intact (atomic) + full journal intact | n/a | replay of intact journal = current state | ✅ nothing lost |
| After `compact()` snapshot, before truncate | new snapshot + redundant journal | n/a | journal replays idempotently (LWW) | ✅ no double-apply harm |

Every failure lands in the **safe** direction (registry ahead-or-equal → strand → rebaseline), never
the orphan-op direction. This is the *same* guarantee today's full rewrite gives — achieved with
O(delta) appends. The one genuinely new failure mode, a torn journal tail, is torn-tail-tolerant by
construction (identical to `pack/index`) and drops in the safe direction. **§4-Q3 of the memo (the
"does the new persistence preserve registry-before-oplog?" gate) is answered here and must be
locked by the durability test in §6 before merge.**

---

## 5. Migration (zero code)

On the first load after upgrade there is an old `file-registry.json` (flat, possibly pretty-printed)
and **no** journal. `load()` reads the snapshot, finds no journal, and produces exactly today's Map —
identical behaviour. The first `flush()` creates the journal; the next `compact()` rewrites the
snapshot un-pretty-printed. The old file *is* a valid snapshot; nothing to migrate. `version` stays 1
(snapshot schema is unchanged — only a sibling journal file is added).

---

## 6. Test plan

**Unit (`__tests__/registry-append-journal.test.ts`, new):**
- **Round-trip:** mutate N entries → `flush()` → new `FileRegistry.load()` → Map deep-equals the
  live one (and `pathIndex` rebuilt).
- **Last-write-wins:** append two states for one id across two flushes → reload → later state wins.
- **Hard delete:** `adoptRemote` divergent-duplicate drop → reload → dropped id absent, kept id
  present; assert a `{del}` line was written.
- **Intra-window collapse:** `registerFile` + `setHeadVersion` + `recordStat` on one id in a
  suspended batch → single `flush()` writes exactly **one** line for that id.
- **Torn tail:** append a delta, then corrupt the file by cutting the final line mid-JSON → reload →
  that entry dropped, all prior entries intact (mirrors the pack-index torn-tail test).
- **Compaction:** `compact()` → journal is empty, snapshot holds everything → reload identical; assert
  snapshot is **not** pretty-printed.
- **Compaction ordering under crash:** simulate crash between snapshot write and truncate (leave the
  redundant journal) → reload → state correct, no double-apply.
- **Migration:** seed an old pretty-printed `file-registry.json`, no journal → load identical → first
  flush appends a journal.

**Durability (extend `round-interruption-durability`-style, the memo's §4-Q3 gate):**
- Abort a capture between `registry.flush()` and `appendOpLog()` at a checkpoint → assert on-disk
  registry ⊇ what the on-disk oplog references (**no orphan op**).
- Inject a torn journal append at a checkpoint → assert stranded-not-orphaned (files re-captured next
  enable, no op references an unregistered file).

**Perf (reuse the A3 first-enable harness, `docs/perf-baseline-2026-07-23.md`):**
- Assert `regFlushMs` drops from ~5.76 s toward **< 1 s** on the F=8389 device profile.
- Assert append-volume is O(F) not O(F²) (the `captureFlushPerf.writeMs` should be ~flat per
  checkpoint, not triangular).

The full unit suite (`getById`/`getByPath`/`getActiveEntries`/`referencedHashes`/`reconcileWithVault`
and every integration test that drives the real registry) is the **regression guard for the "Map is
identical" claim** — if load() rebuilds the same Map, they stay green untouched.

---

## 7. Explicitly deferred (NOT in v1)

**The `mtime`/`size` stat-cache split** (the memo's last-turn idea: move the disposable stat cache to
a separate loss-tolerant file so it stops churning the durable journal). Deferred because it does
**not** help the first-enable target: on first enable the registry starts empty, so `recordStat`
(which fires only on the *content-unchanged, stat-drifted* self-heal path) runs ~never during capture
— the first-enable journal churn is entirely `registerFile` + `setHeadVersion`, which the plain
full-entry journal already makes O(delta). The stat-split is a **steady-state** concern (it would
reduce how often live-path churn forces a `compact()`), and a clean follow-up **if** journal growth
from `recordStat` proves to trip the size-valve too often in practice. Ship the journal first; measure
steady-state journal growth; split only if the numbers demand it.

Also out of scope: Options A and C from the memo (subsumed/rejected), and any change to the snapshot
`SerializedRegistry` schema itself (unchanged, for zero-migration).
