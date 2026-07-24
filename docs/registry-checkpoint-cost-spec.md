# Vault Sync — First-Enable Registry Checkpoint Cost (the `otherMs` registry half) — **DESIGN NOTES (graduated → see rollout spec)**

> **GRADUATED 2026-07-24 → `docs/registry-append-journal-spec.md` → ✅ BUILT + ON-DEVICE CONFIRMED
> 2026-07-25.** Note the outcome overrode this memo's *provisional* §5 lean toward Option A: the rollout
> chose **Option B** and it landed at **`regFlushMs` 5.76 s → 0.34 s** — B's O(delta) attack on the byte
> volume beat A's "write the same bytes less often," exactly because the cost was the MB-scale write (§4 Q2),
> not the frequency. The three-way A/B/C debate below
> is resolved: **Option B (keyed append-journal, last-write-wins + snapshot compaction)** was chosen,
> sharpened by three code findings that shrink its cost — it's a **persistence-layer-only** change
> (nothing outside `file-registry.ts` reads the registry file, so every consumer is untouched), the
> pattern already ships twice in-repo (`ContentStore.pack/index`, the version-DAG journal), and the
> `append`/atomic-`write` primitives are purpose-built. This memo is retained as the **why**; the
> rollout spec is the **how**. Read on only for the trade-off rationale behind the choice.

**Status:** Exploratory / needs-careful-consideration — Step-1 gate CLEARED (measured 2026-07-24), **worth doing; still do NOT implement without picking a direction**. **Now the UNAMBIGUOUS next lever:** its sibling oplog half landed 2026-07-24 (`oplogSaveMs` 5.37 s → 1.25 s), leaving `regFlushMs` **5.76 s = 72% of the remaining 8.05 s `otherMs`** (was 47% of 12.1 s). · **Date:** 2026-07-24 · **Owner:** client/perf

**Read this as a design memo, not a rollout.** Unlike its sibling
`docs/oplog-append-journal-spec.md` (a clean append, ready to build), the registry half of the
12.1 s `otherMs` is **not** a clean append — the registry is a keyed map mutated *in place*,
sits on the crash-safety spine (registry-before-oplog), and is the anchor of the rebaseline
recovery path. This document lays out the problem, three candidate directions with their
trade-offs, and the open questions that must be answered **before** any code. It intentionally
stops short of prescribing an implementation. **Gate:** do nothing here until
`oplog-append-journal-spec.md` §3 Step 1 (the shared metrics split) has measured how large the
registry half actually is — it may not be worth touching at all.

**Gate result (measured on device 2026-07-24, F=8389 — `oplog-append-journal-spec.md` §3.3):**
`regFlushMs` = **5.73 s** — **47% of the 12.1 s `otherMs`**, marginally *larger* than the oplog
half (5.37 s). So the registry is a real lever, **not** a small share we can ignore — the gate is
cleared in favour of doing this. The sub-split: **`reg.writeMs` 4.86 s vs `reg.stringifyMs` 0.78 s**
— **86% is the MB-scale native write**, not the `JSON.stringify` CPU. That directly informs §4's
open questions (answers folded in below): the write, not the serialize, is what a fix must shrink,
which favours **not re-writing the whole registry each checkpoint**. Still a memo: pick a
direction (§3) before any code.

This document is written to be picked up **cold**, with no prior conversation context.

**Parent / companions:** `docs/oplog-append-journal-spec.md` (the **other**, clean half of
`otherMs`, and the owner of the shared Step-1 metrics split this spec is gated on).
`docs/pack-writes-spec.md` (the sibling that solved the blob-write half; source of the 12.1 s
`otherMs` figure and the append-is-O(delta) evidence). `docs/startup-capture-optimization-spec.md`
(A3 umbrella; §2 documents that per-file registry writes were *already* batched away — the
`suspendSaves`/checkpoint-`flush` fix that killed the original O(F²) 1.96 GB GC-cliff bug, so
this spec is about the **remaining** checkpoint-`flush` cost, a different and smaller thing).
`docs/sync-engineering-guide.md` §5 (invariants — **the registry is the data-safety spine**), §7
(capture gotchas), and its notes on **rebaseline**. `src/core/file-registry.ts` (`flush`,
`suspendSaves`, the `Map`-based state), `src/core/operation-logger.ts:262`–`269` (the ordering
invariant comment — read it verbatim before touching anything).

**Ground rule (from A3 §0):** no published release, no users. `.vault-sync/` is disposable — but
note (§4) the registry is the *one* piece of `.vault-sync/` whose corruption is not cleanly
self-healing mid-session, which is exactly why this half warrants more caution than the oplog.

---

## 1. The problem (same O(N²) shape as the oplog — but a harder object)

At each of ~42 first-enable checkpoints (`operation-logger.ts:283`), after the pack flush and
before the oplog save, the capture calls `registry.flush()`:

```ts
// file-registry.ts:67 — flush: full serialize + full write, every call
async flush(): Promise<void> {
  if (!this.dirty) return;
  const data: SerializedRegistry = { version: 1, entries: Array.from(this.entries.entries()) };
  if (!(await this.metadata.exists('.vault-sync'))) { await this.metadata.mkdir('.vault-sync'); }
  await this.metadata.write(REGISTRY_PATH, JSON.stringify(data, null, 2));  // ALL entries, pretty-printed
  this.dirty = false;
}
```

`this.entries` grows monotonically during first capture (every file is new → `registerFile`), and
each entry is **richer** than an op (path, id, contentHash, mtime, size, headVersionId, deleted
flag). Over ~42 checkpoints the whole map is re-serialized-from-scratch and re-written at sizes
200, 400, … 8389 entries — the identical **triangular / O(N²)** shape the oplog spec §2 describes,
on both the `JSON.stringify` CPU and the MB-scale native write. Step-1 instrumentation (owned by
the oplog spec) will report `regFlushMs` and its `stringifyMs`/`writeMs` sub-split.

**What was already fixed (do not re-litigate):** the *per-file* registry write is gone —
`suspendSaves()` (`file-registry.ts:83`) makes each in-loop `save()` mark dirty and return, so
`registerFile`/`setHeadVersion`/`updateContentHash`/`recordStat` inside the loop are ~free. This
spec is only about the **checkpoint** `flush`, which still writes the whole map. Distinct problem,
smaller magnitude, harder to fix cleanly.

---

## 2. Why this is harder than the oplog (the four complications)

The oplog during capture is **pure append** — ops are only ever pushed, never edited, so "append
the delta" is exact. The registry is not, and four properties make an append-journal a genuine
design project rather than a transcription of the oplog fix:

1. **Keyed, in-place mutation — not append.** Entries are *updated* by key: on first enable a file
   is `registerFile`d and then immediately `setHeadVersion`d (a second write to the same key), and
   later `recordStat`/`updateContentHash`/`markDeleted` mutate existing entries. A journal would be
   **log-structured with last-write-wins per key + periodic compaction** — the classic LSM problem,
   not a flat append. Load becomes "replay the journal, later record wins." More moving parts, more
   ways to be subtly wrong.

2. **It is the crash-safety spine (`operation-logger.ts:262`–`269`).** The invariant is: *on disk
   the registry must never lag the oplog.* A crash in the gap must strand files (registry ahead of
   oplog — recoverable by rebaseline) and must **never** orphan ops (oplog ahead — referencing
   unregistered files). Any change to *how* the registry persists must preserve "registry state on
   disk ≥ what the oplog references" at every instant. An append-journal's durability semantics
   (partial line, replay order) interact with this invariant in ways the flat rewrite does not.

3. **It is the rebaseline anchor.** Recovery from an interrupted capture, and **Rebuild sync
   metadata**, both lean on the registry being a coherent full snapshot. A log-structured registry
   that is only coherent *after replay* changes what "read the registry" means for every consumer,
   not just the capture path — the live create/modify/delete handlers, the round's
   `buildLocalIdentity`, the delete-detection pass. Wider blast radius than the oplog.

4. **Corruption is not cleanly self-healing.** A torn *blob* degrades to a conflict (hash-verify);
   a torn *oplog* tail re-captures next enable. A torn *registry* can mislabel a file's tracked
   state — the phantom-delete guard (`operation-logger.ts:309`) exists precisely because a
   wrong-looking registry/listing is dangerous. This is the one `.vault-sync/` artifact where "just
   delete it, it's disposable" is true only *between* sessions, not *during* a capture. Higher bar.

---

## 3. Candidate directions (unranked — each needs the Step-1 numbers to choose)

Three families, cheapest-and-safest first. The point of listing them is to force the trade-off into
the open, not to pick yet.

### Option A — write the registry FEWER times (raise/decouple the checkpoint cadence). *Cheapest, least risky.*
The registry does not actually need to be persisted every 200 ops for *performance* — it is flushed
there for **crash-safety bounding**. Decouple the two cadences: keep the oplog/pack checkpoint at
200 (cheap once the oplog is an append), but flush the **registry** far less often (e.g. every
2000 ops, or every M seconds), accepting a larger crash-loss window *for the registry only*.
- **Upside:** ~10× fewer whole-registry rewrites → cuts `regFlushMs` by ~that factor with **zero**
  format change, zero new load/replay code, and no new corruption modes. Preserves the flat
  snapshot everything already trusts.
- **Downside / open question:** does a larger registry-crash-window still satisfy invariant #2? A
  crash now loses more registry progress — but the direction of loss (registry *behind*) strands
  files, which is the *safe* failure (rebaseline heals), never the orphan-op failure. **Need to
  confirm** the ordering still holds if the registry checkpoint and oplog checkpoint are on
  different cadences — specifically that the oplog is never flushed *ahead* of the registry it
  references. This may require flushing the registry immediately before any oplog append that
  references newly-registered files, which partly defeats the decoupling. **This is the load-bearing
  question for Option A.**
- **Still O(N²), just with a smaller constant.** Honest: this reduces the coefficient, it does not
  change the asymptote. For F≈8k that may be entirely sufficient (a 10× cut on a ~6 s half → ~0.6 s).

### Option B — append-only registry journal (LSM-style, last-write-wins per key + compaction).
The true asymptotic fix, mirroring the oplog — but see all four complications in §2.
- **Upside:** O(delta) writes during capture, same as the oplog; asymptotically correct.
- **Downside:** the full §2 cost — keyed replay on load, compaction policy, torn-tail semantics on
  the crash-safety spine, and a load-path change every registry consumer inherits. **Substantially**
  more design + test than the oplog append. Probably only justified if Step-1 shows the registry is
  the *dominant* half **and** F is expected to grow well past 8k.

### Option C — write the registry only ONCE, at the end; reconstruct on crash from the oplog + pack index.
Drop the per-checkpoint registry flush entirely; write the full registry once at capture end. On a
mid-capture crash, rebuild the partial registry by **replaying the persisted oplog** (which already
carries fileId → path → hash → headVersion) against the pack index.
- **Upside:** eliminates *all* intermediate registry writes — the biggest asymptotic win, and
  arguably the "right" model (the oplog already contains the registry's information).
- **Downside / open question:** inverts invariant #2 — now the **oplog** is the source of truth and
  the registry is derived, so the recovery path must be able to reconstruct a correct registry from
  oplog + pack index for *every* op type (create/update/delete/move/merge), including the
  headVersion chain and the O1 stat-gate cache (mtime/size — **which the oplog does NOT carry**, so
  the stat-gate would cold-start after a crash, re-hashing the vault once). **Need to verify** the
  reconstruction is total and that losing the stat cache on crash-recovery is acceptable (it is a
  perf regression on the *recovery* path only, not a correctness bug). Largest blast radius; most
  careful review.

---

## 4. Open questions to resolve BEFORE writing any code

1. **Is it even worth it? → YES (answered 2026-07-24).** Step-1 measured `regFlushMs` = **5.73 s =
   47% of `otherMs`**, marginally larger than the oplog half — not a small share. The flat rewrite
   is a genuine lever; this spec is *not* shelved.
2. **stringify vs write? → WRITE (answered 2026-07-24).** `reg.writeMs` 4.86 s vs `reg.stringifyMs`
   0.78 s — **86% is the MB-scale native write**, not CPU. Option A (fewer whole-registry rewrites)
   cuts the write coefficient ~10× directly; Options B/C cut it to O(delta). Because the cost is
   overwhelmingly the *write*, any fix that keeps re-writing the whole registry — just less often
   (Option A) — still pays the full per-write cost each time it fires; an O(delta) approach (B/C)
   attacks the byte volume itself. This does **not** decide A-vs-B/C alone (A's ~10× fewer writes
   may suffice at 8k files), but it rules out treating the serialize as the thing to optimise.
3. **Does Option A's decoupled cadence preserve registry-before-oplog?** (§3 Option A load-bearing
   question.) This is answerable by careful reading of the ordering invariant + a targeted
   `round-interruption-durability`-style test *before* committing.
4. **For Option C: is registry-from-oplog reconstruction total, and is stat-cache cold-start on
   recovery acceptable?** Enumerate every op type and confirm the rebuild covers headVersion edges
   and deletions; decide explicitly that the post-crash re-hash is tolerable.
5. **Interaction with live (non-capture) registry writes.** Outside capture, `save()` writes the
   registry per-mutation (autosave). Any journal/format change must keep the live path correct too —
   or scope the change to capture only and keep the live path on the flat snapshot (a dual-format
   registry is itself a smell worth weighing).

---

## 5. Recommendation (provisional — for discussion, not a decision)

Lean **Option A** as the first move: it is the cheapest, lowest-risk, format-preserving cut, keeps
the registry a coherent flat snapshot (protecting the rebaseline path and invariant #2), and for a
~8k-file vault a ~10× coefficient cut likely lands `regFlushMs` low enough that the O(N²) asymptote
never bites in practice. Escalate to **Option C** only if Step-1 shows the registry is the dominant
half *and* Option A can't satisfy the ordering invariant without re-coupling the cadences. Treat
**Option B** as the fallback if a truly asymptotic fix is required and Option C's oplog-as-truth
inversion is judged too large a change. **Step-1 has now run** (regFlush 5.73 s, 86% native write):
Option A's ~10× fewer whole-registry writes would cut ~4.86 s of write toward ~0.5 s — likely
enough on its own, so Option A stays the provisional lead. Escalate to C only if Option A can't
hold the ordering invariant; the measurement doesn't force that. Pick the direction before code.

---

## 6. Explicitly out of scope for now

No implementation, no tests, no format change lands from this document. Its only near-term action is
to **make sure the shared Step-1 metrics split (owned by `oplog-append-journal-spec.md` §3) reports
`regFlushMs` and its `reg.stringifyMs`/`reg.writeMs` sub-split**, so the choice above can be made on
evidence. Revisit this memo once those numbers exist; at that point it graduates (or doesn't) into a
proper rollout spec.
