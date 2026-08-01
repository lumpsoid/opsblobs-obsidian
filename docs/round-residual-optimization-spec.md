# Vault Sync — Round Residual Optimization Spec (R3 / R2′ / R4)

**Status:** Draft / decision-of-record · **Date:** 2026-07-23 · **Owner:** client/perf

R1 (`docs/steady-state-round-optimization-spec.md`, landed) extended the capture
mtime/size gate into `buildLocalState`, killing the O(F·B) whole-vault re-hash that
dominated every routine sync round. A phase decomposition of the *drained* steady-state
round (see `docs/perf-baseline-2026-07-23.md` → "The R1 fix" → "Correction") then showed
what's left. This spec defines the follow-ups:

- **R3 — dedup the per-round DAG deserialization** (primary; low-risk, ~1 day).
- **R2′ — working-set byte-staging** (deferred; riskier). Reopens R1's R2 because it is
  the joint fix for the residual staging **and** the confirmed on-device memory hazard
  **B6/A3** (unbounded `memCache`) — the two are one problem (§4.1).
- **R4 — make the capture + `buildLocalState` entry scan O(touched)** (deferred; bigger,
  riskier, gated on whether R3/R2′ are enough).

Companion docs (read in this order before touching code):
`docs/sync-engineering-guide.md` (**mandatory** — the invariants in §5/§7 must not break),
then `docs/steady-state-round-optimization-spec.md` (R1, the gate this builds on),
`docs/perf-baseline-2026-07-23.md` (the numbers below), `docs/capture-optimization-spec.md`
(O1, the original capture gate).

---

## 0. Ground rule: no users, no release yet

Same as the R1/capture specs §0. **No published release, no users.** Persisted schemas
may change freely; no migration code, no compat shims. A dev's stale `.vault-sync/` is
disposable (delete + re-enable, or **Rebuild sync metadata**). Design for the clean
end-state.

---

## 1. What the decomposition established (the problem)

The true steady-state round (one-file edit, backlog drained) at **L (F=10000)**, laptop,
totals **118 ms**; native ARM (Termux) **308 ms**. Counts are already flat in F post-R1
(`sha256 = 2`, `fileReads = 1`). The remaining time, by `runSync`'s built-in `PhaseTimer`
laps (`src/network/perf-timer.ts`), splits as:

| phase | ms (laptop, L) | what it is | target |
|---|--:|---|---|
| captureOfflineChanges | 30 | O(F) stat scan of every live file | R4 |
| buildLocalState | 38 | O(F) loop: DAG load + stage every gated file's bytes (no hash) | **R3** (DAG) · R2′ (staging/B6) · R4 (iteration) |
| keycheck + dag-guard | 18 | `dagNeedsRebuild` → a **full DAG load** | **R3** |
| recordVersionEdges | 16 | adds this round's edges → a **full DAG load** | **R3** |
| merge + applyMerge | 12 | pure merge + apply | — |
| pull | 0.1 | 0 ops in steady state | — |

Plus one cost that is **not** wall-time but memory: the per-round byte-staging in
`buildLocalState` keeps the whole vault's content warm in an **unbounded** `memCache`
(B6/A3 — confirmed on device). See §4.1 — it is coupled to the staging above, not
independent.

**The redundancy R3 fixes.** `this.versionDagStore.load()` — which reads
`version-dag.json`, `JSON.parse`s it, rebuilds the whole `VersionDag` via
`VersionDag.fromJSON` (O(nodes)), then replays the `version-dag.log` journal — is called
**three times in a single round**, each rebuilding the *same* pre-round graph from disk:

- `dagNeedsRebuild()` — `src/network/vault-sync-host.ts:177` (the `keycheck+dag-guard` lap)
- `buildLocalState()` — `src/network/vault-sync-host.ts:50`
- `recordVersionEdges()` — `src/network/vault-sync-host.ts:143`

At 10k nodes each load is ~11 ms; the round deserializes the graph 3×. This is pure
redundant I/O + parse — the persisted DAG does not change between these three calls (it
only changes when `recordVersionEdges` appends at the *end*).

**The O(F) iteration R4 targets.** Even with hashing gated and reads eliminated, both the
capture pass (`for (const ref of live)`, `src/core/operation-logger.ts:126`) and
`buildLocalState` (`for (const [id, entry] of this.registry.getAllEntries())`,
`src/network/vault-sync-host.ts:67`) still *walk every file* every round. Cheap per entry,
but O(F): ~30 ms + ~(38 − DAG share) ms at F=10k.

**Scope reality (be honest about who this helps).** At M (F=2000) the drained round is
**18 ms laptop / ~50 ms ARM** — already fine, and its memCache is a few MB. These
residuals only bite on **large vaults (≈5k–20k+ files)**. R1 already made the *typical*
vault's round cheap. R3 is a clean win that also helps mid-size vaults a little; R2′ and
R4 are large-vault-only concerns, and R2′'s B6 memory growth is the one that is *monotonic*
(it doesn't plateau) — so on a large vault kept open for a long session it is the residual
most likely to actually matter, even though R3 is the cheaper first move.

---

## 2. Goals & non-goals

**Goals**
- **R3:** one DAG deserialization per round, not three. No change to the graph the merge
  reads, to what `recordVersionEdges` journals, or to the self-heal rebuild path.
- **R2′ (if pursued):** `buildLocalState` stages only the merge's working set, so the
  steady-state `ContentStore.memCache` stops growing with vault size (fixes B6/A3) while
  keeping reads O(touched) — without weakening merge completeness.
- **R4 (if pursued):** a routine capture + `buildLocalState` touch O(touched) files, not
  O(F) — without weakening offline-drift detection or the merge's completeness.

**Non-goals**
- The one-time post-convergence **backlog pull** (`pulled = F` on the first drained
  round) — that is B4/cold-join territory (O(H) decrypts), a separate concern; the B1
  bench already drains it so it doesn't pollute steady-state numbers.
- diff3 low-unique O(L²) cliff (B8/A8) — a separate headline hazard in the baseline doc.
- Any migration/compat tooling (§0).

> **Note on R2.** The R1 spec's R2 (working-set byte-staging) was recorded as "closed as
> not-warranted" because reads were already 1. That verdict was **conditional on the
> unbounded memCache** and is **reopened here as R2′** (§4.1): R1's `fileReads = 1` holds
> only *because* the whole vault's content sits warm in an unbounded cache — which is
> exactly the B6/A3 memory hazard. Bounding the cache re-introduces O(F) reads unless
> `buildLocalState` stops staging the whole vault. So R2′ and B6 are one problem, solved
> together (see §4.1).

---

## 3. R3 — one DAG load per round (primary)

### 3.1 The trap you MUST preserve (read first)

`recordVersionEdges` (`vault-sync-host.ts:142`) decides **what to append to the journal**
by `dag.addVersion(...)` returning `true` = "this edge was not already in the graph":

```ts
for (const op of ops) {
  if (op.type === 'move') continue;
  if (dag.addVersion(op.id, op.parents, op.contentHash, op.fileId)) {
    newEdges.push({ v: op.id, p: op.parents, c: op.contentHash, f: op.fileId });
  }
}
```

This is **load-bearing**: our own ops re-pull every round, so appending unconditionally
would grow `version-dag.log` without bound (see the method's comment). Meanwhile
`buildLocalState` (`vault-sync-host.ts:55-58`) **mutates** its DAG by folding this round's
pending ops in, so a fresh head can reach its base for the staging walk:

```ts
for (const op of this.opLogger.getPendingOps()) {
  if (op.type === 'move') continue;
  dag.addVersion(op.id, op.parents, op.contentHash, op.fileId); // in-memory only, not persisted
}
```

**Therefore: if you naïvely share one `VersionDag` instance between `buildLocalState` and
`recordVersionEdges`, `buildLocalState` will have already added this round's pending-op
edges, so `recordVersionEdges`'s `addVersion` returns `false` for them → they are NEVER
journaled → the round's authored edges are lost from the persisted DAG.** That is a
correctness bug (the DAG silently drifts from the oplog; a later fresh device rebuild is
fine because it replays the server log, but *this* device's derived cache is wrong until a
rebuild). Do not let this happen.

### 3.2 Design

1. **Add `VersionDag.clone(): VersionDag`** (`src/core/version-dag.ts`). A direct copy of
   the private `nodes` Map — cheaper than `fromJSON(toJSON())` (no JSON round-trip),
   O(nodes). Each `VersionNode`'s `parents` array should be copied (new array) so a
   clone's mutation can't alias the original's parent lists.

2. **Load the persisted DAG exactly once per round and thread it through.** Add
   `loadDag(): Promise<VersionDag>` to the `VaultSyncHost` interface
   (`src/network/server-sync.ts`) and have `ServerSyncClient.runSync` call it once, right
   after the keycheck/dag-guard, then pass the instance into the three consumers. Change
   the three interface methods to accept it:
   - `dagNeedsRebuild(dag)` — reads `dag.size()` only (read-only; leave the `cursor.load()`
     check as-is). It must NOT load again.
   - `buildLocalState(dag)` — **`const working = dag.clone()`**, fold the pending ops into
     `working` (not `dag`), and use `working` for `reachableContentHashes`. Leaves `dag`
     pristine = the pre-round persisted graph.
   - `recordVersionEdges(ops, dag)` — add `[...pending, ...pulled]` to `dag` and journal
     the genuinely-new ones. Because `buildLocalState` worked on a clone, the pending ops
     are still absent from `dag` here, so `addVersion` returns `true` for them and they
     journal correctly (the trap is avoided). Return `dag` for the merge.

   `runSync` order is unchanged; only *who loads* changes. The self-heal rewind
   (`dagNeedsRebuild` → `saveCursor(0)`) still works: a torn graph loads once as empty,
   `dagNeedsRebuild` sees `size()===0`, the round re-pulls, and `recordVersionEdges`
   rebuilds into the same (empty) instance.

   **Alternative considered (host-internal per-round cache):** memoize the load inside
   `PluginVaultSyncHost` with explicit per-round invalidation. Rejected as the primary
   approach — the host is a long-lived session object, so a cache needs a round token or a
   `beginRound()`/invalidate hook, which is more error-prone (stale-cache-across-rounds)
   than explicit threading. `PluginVaultSyncHost` is the only implementer, so the
   interface change is contained.

**Impact.** 3 loads → 1 load + 1 clone. The clone is cheaper than a load (no disk read, no
`JSON.parse`, no journal replay). Removes ~2 load-equivalents ≈ **~22 ms off the L round**
(laptop), proportionally more on ARM.

---

## 4. Bigger deferred changes — R2′ (working-set staging + B6) and R4 (O(touched) scan)

Both are riskier than R3 (they touch merge inputs / offline-drift detection), scale with
vault size, and should be built **only if R3 leaves a large vault over budget**. Do not
build speculatively. R2′ is the more important of the two: it also fixes a *confirmed
on-device* memory hazard (B6/A3), whereas R4 is pure CPU trimming.

### 4.1 R2′ — working-set byte-staging (fixes the residual *and* B6/A3)

**Why this is one problem, not two.** R1 made `buildLocalState` skip the re-hash, but it
still stages the bytes of **every** gated file into the round's content map via
`contentStore.get` (`vault-sync-host.ts:83-90` + the gate's `get`). Those hits land in
`ContentStore.memCache` — an **unbounded** `Map<hash, bytes>` (`content-store.ts:44`) that
`put`/`get` only ever add to and that `clearMemCache` (`content-store.ts:144`) is called
from a single capture checkpoint (`operation-logger.ts:204`) which never fires in steady
state (capture emits ~0 ops). So over a session the cache accretes every content version
ever touched → **B6/A3: monotonic heap growth, confirmed on device (M +8.3 MB / 50 rounds,
RSS flat ⇒ live heap).**

The coupling: **R1's `fileReads = 1` holds only because that whole-vault content sits warm
in the cache.** Naively bounding/clearing the cache to fix B6 makes `buildLocalState`'s
per-round staging *miss* → `fileReads` climbs back to O(F). You cannot get flat RAM *and*
flat reads while `buildLocalState` stages the whole vault. The merge only ever reads local
bytes for `union(local-touched, remote-delta)` — an untouched file not in the remote delta
merges to `no_op` and its bytes are never read (`src/merge/state-merge.ts`). So the fix is
to **stage only that working set**; then the cache naturally holds ~the working set and B6
is gone as a side effect.

**Design.**
1. Thread the remote delta's `fileId` set into `buildLocalState` (the round already has
   `remote` before it needs the local snapshot — reorder so the pulled projection's fileIds
   are available, or pass a lazy content provider the merge pulls from). Stage bytes only
   for `union(locally-touched this round, remote-delta fileIds)`; for a gated, untouched,
   non-delta file, record its `FileEntry` (identity — the merge still needs the full entry
   map, see §4.2) but **do not** `get` its bytes.
2. Add a **bounded LRU** to `ContentStore.memCache` (byte-budgeted, e.g. a few MB;
   eviction on insert past budget) as a belt-and-suspenders — correctness-safe because
   `get` falls back to disk on a miss (`content-store.ts:75`) and `has` checks disk
   (`content-store.ts:85`), and R1's gate already disk-reads on a store miss. With R2′
   staging only the working set, evictions of live working-set content become rare.

**Risk (why it's not R3-cheap).** This is a **merge-input-completeness** change: stage too
little and the merge silently can't read a side it needed → F1 "never fabricate content"
territory. Every "which files does the merge actually read bytes for" edge (renames, delete
vs modify, create/create, multi-head reconcile) must be covered. Pin with tests that a
file *only present remotely* still merges (its bytes come from the remote fetch, not local
staging) and that a two-headed conflict on a file **not** touched locally this round still
renders markers (its local bytes must be staged because it *is* in the remote delta).

### 4.2 R4 — O(touched) capture + entry map (pure CPU, no memory angle)

Even with R2′, two O(F) *iterations* remain (not byte work — the loops themselves):

**Capture stat scan** (`operation-logger.ts:126`). The pass exists precisely to catch
*offline* drift the `modify` watcher missed, so it must eventually stat every file. Making
it O(touched) means a persisted "possibly-dirty" set (updated by watcher events) that a
routine capture trusts, with a *full* scan only every N rounds or on demand. That weakens
the offline-drift guarantee (a raw file change while the plugin is off, in a round that
trusts the dirty-set, is missed until the next full scan) — a real regression of the exact
thing capture is for. If pursued: full scan on first capture after load + every N rounds,
dirty-set between, **Rebuild sync metadata** as the escape hatch. Design carefully; pin
the offline-drift behavior with a test.

**`buildLocalState` entry map** (`vault-sync-host.ts:67`). The merge keys on the full
`fileEntries` set to detect deletes/renames against the remote projection, so a partial
entry map is the **same merge-input-completeness** risk as R2′ (§4.1) — and it must not
silently strand a file the merge would otherwise touch. Would need the same dirty-set +
remote-delta threading. This is the *identity* half; R2′ is the *content* half. Bigger;
defer, and note R2′ can be done first (staging fewer bytes) while still building the full
entry map (cheap identity walk).

**Recommendation.** Ship R3. Re-measure on device. If B6 heap growth is unacceptable on a
large vault, do **R2′** (it fixes both reads-vs-RAM and B6). Only reach for R4's dirty-set
if the O(F) *iteration* (not staging) still shows on a large-vault trace. For most vaults
R1 + R3 is enough and the cache stays a few MB.

---

## 5. Invariants that must not break (`sync-engineering-guide.md` §5/§7)

R3 changes *how many times* the DAG is loaded, never the graph's content or the bytes the
merge sees. Verify each:

1. **`recordVersionEdges` journals exactly this round's new edges** (§3.1 trap). After R3,
   `version-dag.log` must gain the same edges it does today — assert the round's
   pending-op ids appear in the persisted journal, and survive a `reload()`.
2. **The merge reads the same DAG.** `mergeVaultStates(local, remote, dag)` and
   `reconcileConcurrentHeads` must receive a graph containing this round's local + pulled
   edges — identical to today. Pin via an existing convergence test staying green
   (`merge-node-convergence`, `resolution-convergence`).
3. **`buildLocalState` stages the same base bytes.** The `reachableContentHashes` walk must
   see the pending-op-folded graph (via the clone), so the staged base set is byte-for-byte
   what it is today (F1: known-but-missing base → conflict, never union).
4. **The self-heal rebuild still fires** (`dagNeedsRebuild` → torn graph → `saveCursor(0)`
   → rebuild). A single load feeding all three consumers must still detect a size-0 torn
   graph and rewind.
5. **DAG acyclicity / content addressing / version-ids untouched.** `clone()` copies nodes
   verbatim; no hashing, no id derivation, no walk changes.

R2′ (if built) additionally must preserve **F1 (never fabricate content)** and
**merge-input completeness** — a file the merge reads bytes for must have those bytes
staged (from local staging *or* the remote fetch). R4 additionally must preserve **F5
offline-drift capture**. Those are the §4 risk surfaces, not R3.

---

## 6. Testing & measurement (guide §8 — real stack over `TestDevice`, never a reimpl)

Model on `__tests__/capture-stat-gate.test.ts` / `__tests__/round-stat-gate.test.ts`.

**R3 (unit, over the real stack):**
1. **The win — one DAG load per round.** Spy `versionDagStore.load` (or count
   `metadata.read('.vault-sync/version-dag.json')` via a fake counter) across one
   `ServerSyncClient.runSync()`; assert it is called **once**, not three times.
2. **Journal integrity (the §3.1 trap).** After a round with a local edit, assert the
   edit's op-id edge is present in the persisted `version-dag.log` (and that a `reload()`'s
   DAG contains it). This is the regression guard for the clone-vs-share bug — write it
   first and watch it FAIL against a naïve shared-instance implementation.
3. **No journal bloat.** Our own re-pulled ops do not re-append: run two rounds with no new
   edits, assert the journal length is unchanged on the second (the `addVersion`-returns-
   false dedup still works).
4. **Convergence unbroken.** A two-device merge-node / resolution scenario still converges
   (reuse the shape from `merge-node-convergence.test.ts`).
5. **Self-heal.** A torn/emptied `version-dag.json` with a non-zero cursor still triggers
   the rebuild (existing `dagNeedsRebuild` behavior) with the single-load path.
6. **Regression:** full suite green; `npm run build` clean.

**R2′ (if built) — the completeness guards are the point, not the perf:**
1. **B6 goes flat.** Drive N steady-state rounds (each a 1-file edit + sync) and assert the
   `ContentStore.memCache` size (entry count or a byte estimate) is bounded / not monotonic
   — the objective. Mirror B6's shape from `bench/run.ts`.
2. **Reads stay O(touched) with the cache bounded.** With the LRU active, a 1-file-edit
   round still issues ~O(touched) `files.read`, not O(F) — proving the staging trim (not
   just the bound) is in place.
3. **F1 / completeness — remote-only file.** A file present only on the remote still merges
   (its bytes come from the remote fetch, never local staging) — no `no_op`-that-should-
   have-written, no fabricated content.
4. **F1 / completeness — conflict on a not-locally-touched file.** A two-headed text
   conflict on a file this device did **not** edit this round still renders markers (its
   local bytes must be staged because it is in the remote delta). This is the case a naïve
   "stage only what I edited" trim breaks — write it first.
5. **Eviction is safe.** Shrink the LRU budget below the working set, run a round, confirm
   it still converges (evicted bytes re-read from disk, never fabricated).

**Bench (Layer 1/2):** re-run `BENCH_ONLY=b1 BENCH_PROFILES=xs,s,m,l npm run bench`. B1
`roundMs` should drop at L (the DAG-load laps shrink); counts (`sha256=2`, `fileReads=1`)
unchanged. To see the lap breakdown directly, wire a `perfLog` sink into a throwaway
`ServerSyncClient` (as the decomposition did — see the git history around this spec's
commit, or `src/network/perf-timer.ts`) and confirm `dag-guard` (since split out of the
former `keycheck+dag-guard` lap, which fused it with the preflight network RTT) +
`recordVersionEdges` + the DAG portion of `buildLocalState` fall to ~one load's worth.
⚠ `npm run bench` overwrites the profile-stamped results file — `git checkout --` or
discard the untracked run after; the committed baselines are
`bench/results/2026-07-23_xs-s-m.*` and `..._post-capture-fix_xs-s-m.*`.

**On-device (Layer 3):** rebuild (`npm run build:dev`), redeploy
(`scripts/deploy-android.sh`), re-run the **drained** B1 at L on Termux
(`BENCH_ONLY=b1 BENCH_PROFILES=l npm run bench`), record the new `roundMs` into
`docs/perf-baseline-2026-07-23.md` (the "Correction" section's native-ARM row; today's
value is **308 ms**).

---

## 7. Order of work & deliverables

- [x] **R3.1 — `VersionDag.clone()`** (`src/core/version-dag.ts`) + a direct unit test
      (clone equals original by `toJSON`, and mutating the clone doesn't touch the
      original — the parent-array aliasing check). *Landed (`18dd2e3`).*
- [x] **R3.2 — thread one DAG through the round.** Added `loadDag()` to the `VaultSyncHost`
      interface; `runSync` loads once; `dagNeedsRebuild`/`buildLocalState`/
      `recordVersionEdges` take the instance; `buildLocalState` folds pending ops into a
      **clone** (and `reconcileConcurrentHeads` threads the same instance). Tests
      `__tests__/round-dag-load-dedup.test.ts` (the five behavioral checks in §6 + the
      full suite as #6) over the real stack — the journal-integrity test (#2) was verified
      to FAIL against a naïve shared-instance impl before the clone fix. *Landed (`cd36c4f`).*
- [x] **R3.3 — re-measure Layer 2 + Layer 3.** Layer 2 (laptop bench): B1 **L 122.5 →
      89.4 ms**. Layer 3 (Termux native ARM, drained B1 L): **308 → 207 ms (−33%)**. Counts
      unchanged both layers (`sha256=2`, `fileReads=1`); baseline doc updated. *Landed
      (`c225a1c` + device row).* The 207 ms device number is the gate for whether R2′/R4
      are warranted (below).
- [ ] **R2′ — working-set byte-staging + bounded memCache** *(only if B6 heap growth is
      unacceptable on a large vault; §4.1).* Thread the remote-delta fileId set into
      `buildLocalState`, stage only `union(local-touched, remote-delta)` bytes, add a
      byte-budgeted LRU to `ContentStore.memCache`. Tests: B6 heap goes flat over N rounds
      **and** a remote-only / not-locally-touched-conflict file still merges (F1 /
      completeness). This one **reopens the merge-input surface** — treat as the riskiest
      item; re-read guide §5/§7 first.
- [ ] **R4 — O(touched) capture + entry map** *(only if the O(F) iteration itself still
      shows on a large-vault trace after R2′; §4.2 — needs the dirty-set design).*

---

## 8. Success criteria

| Operation | Target |
|---|---|
| DAG loads per round (R3) | **1**, not 3 (assert via a `load`/`metadata.read` spy) |
| journal after a round (R3) | contains exactly this round's new edges (unchanged from today) |
| B1 roundMs at L (R3, laptop) | materially below **118 ms**; native-ARM below **308 ms** |
| B6 retained heap over N rounds (R2′) | **flat / bounded**, not monotonic (today: M +8.3 MB/50 rounds) |
| B1 fileReads at L (R2′) | stays **O(touched)**, not O(F), *with* the cache bounded |
| existing suite | green; no convergence / DAG / **merge-completeness** regression |

If R3 lands and the round still loads the DAG 3×, it isn't wired — treat as the change not
taking effect, not a tuning miss. If the journal loses this round's edges (§3.1), that is a
**correctness bug**; stop and fix the clone/share boundary. For R2′, if a bounded cache
makes `fileReads` climb to O(F), the working-set staging isn't in place — bounding the
cache alone is a reads-for-RAM trade, not the fix.

---

## 9. Handoff / current context (2026-07-23)

Read `docs/sync-engineering-guide.md` first (mandatory before any core/merge/network
change), then this + `docs/steady-state-round-optimization-spec.md` (R1, landed).

**Status.** R1 is landed and confirmed on-device (commits `ddcc4eb`, `c6cd69d`,
`ff7cd71`, `d87eff5` on `master`). **R3 is now landed** (`18dd2e3` clone, `cd36c4f`
threading, `c225a1c` measurement) — one DAG load per round, Layer-2 laptop B1 L
122.5 → 89.4 ms, **Layer-3 native-ARM (Termux) L 308 → 207 ms (−33%)**, counts unchanged
both layers, full suite green (268 tests, 1 skipped). **Remaining: R2′ and R4**, both
still **deferred** and gated on the 207 ms device round — build **only if** B6 heap growth
(R2′) or the residual O(F) iteration (R4) is unacceptable on a large vault. At 207 ms/round
the L vault is well inside budget, so neither is warranted today. Do not build
speculatively (§4).

**The exact call sites (verified 2026-07-23, post-R1):**
- `src/network/vault-sync-host.ts`
  - `buildLocalState()` @ **line 42**; its DAG load @ **50**; pending-op fold @ **55-58**;
    the O(F) `getAllEntries()` loop @ **67**; `reachableContentHashes` staging @ **116**.
  - `recordVersionEdges()` @ **142**; its DAG load @ **143**; the `addVersion`-gated
    journal append @ **156**.
  - `dagNeedsRebuild()` @ **169**; its DAG load @ **177** (read-only, `size()`).
- `src/network/version-dag-store.ts` — `load()` @ **53** (`loadSnapshot` @ 74 +
  journal replay); `appendEdges` @ **90**; `COMPACT_THRESHOLD` 500 @ **30**.
- `src/core/version-dag.ts` — `class VersionDag` @ **36** (`private nodes` Map @ **37**);
  `addVersion` (returns `boolean`) @ **53**; `size()` @ **80**; `reachableContentHashes`
  @ **205**; `toJSON` @ **229**; `fromJSON` @ **238**. **No `clone()` yet** — add it.
- `src/core/operation-logger.ts` — `captureOfflineChanges()` @ **109**; the O(F) live-file
  loop @ **126**; the O1 stat gate `continue` @ **147**; the sole `clearMemCache()` call
  (capture checkpoint, never fires in steady state) @ **204**.
- `src/core/content-store.ts` (R2′/B6) — `private memCache` **unbounded** Map @ **44**;
  `put` sets it @ **59**; `get` disk-fallback @ **75** + caches @ **78**; `has` disk-check
  @ **85**; `clearMemCache()` @ **144**. No LRU/bound anywhere. `get`/`has` disk fallback
  is what makes eviction correctness-safe.
- `src/merge/state-merge.ts` (R2′) — the merge only reads local bytes for
  `union(local-touched, remote-delta)`; confirm which branches call into local content
  before trimming what `buildLocalState` stages.
- `src/network/server-sync.ts` — `VaultSyncHost` interface @ **101**; `runSync()` @ **215**;
  the DAG-consuming order: `dagNeedsRebuild` @ **247**, `buildLocalState` @ **253**,
  `recordVersionEdges` @ **297**, `mergeVaultStates` @ **301**, `applyMerge` @ **309**,
  `reconcileConcurrentHeads` @ **326**. The `PhaseTimer` laps are alongside each.

**Repo workflow facts:**
- Build/test: `npm run build` (= `tsc -noEmit -skipLibCheck && esbuild`), `npx vitest run`.
  Bare `tsc --noEmit` shows pre-existing vitest/vite resolution noise — ignore; use the
  build script. `noUncheckedIndexedAccess` is ON (index access needs `!`).
- **Commits omit the `Co-Authored-By` trailer.** Conventional commits (`perf(sync): …`).
- Tests **drive the real stack over in-memory fakes** via `TestDevice`
  (`__tests__/helpers/test-device.ts`). `FakeVaultFiles.io.*` are the ground-truth vault-IO
  counters; the metadata fake's read/write counters (or a spy on `versionDagStore.load`)
  prove the load-count drop. `TestDevice.reload()` models a restart for durability
  (journal-survives) assertions.
- `ServerSyncClient` accepts a `perfLog?: PhaseTimingSink` option
  (`server-sync.ts:143`) — pass `(phase, ms) => …` to capture per-phase laps in a bench or
  a throwaway measurement script (the decomposition used exactly this).
