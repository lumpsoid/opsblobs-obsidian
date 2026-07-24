# Vault Sync — `buildLocalState` Content-Staging Optimization Spec (A2)

**Status:** Implemented + on-device confirmed (rollout steps 1–5) · **Date:** 2026-07-24 · **Owner:** client/perf

> **Landed & confirmed 2026-07-24.** §4.1 (`send_remote.content` dropped), §4.2 (host
> split into `buildLocalIdentity` + `stageContent`), and §4.3 (scoped post-pull staging,
> incl. pending-op content staged before the push and the multi-head reconcile sweep
> scoped) are all in, with the §6 scoping tests (`scoped-content-staging.test.ts`) plus the
> full regression suite green. Extends the §4.3 scope beyond the spec's
> `remote.fileEntries.keys()` to also cover an F2 create/create path collision (whose local
> bytes the merge reads under the local id).
>
> **Step 5 — on-device re-measure — DONE.** Obsidian WebView, Android, F≈8388: the
> converged round dropped **56,254 ms → 3,136 ms (~18×)** and its staging work **~51,928 ms
> (92% of the round) → 36 ms** (identity 30 + stage 5.7). The round is now pull-bound
> (2.47 s), exactly the §6 prediction. Full per-phase breakdown recorded in
> `docs/perf-baseline-2026-07-23.md` → "The A2 fix". The device also overturned the
> laptop's earlier "R2 not warranted" call: byte-staging read as ~8 ms on fake fs but was
> 52 s on the real Capacitor filesystem.

The follow-on to `docs/steady-state-round-optimization-spec.md` (A1/B1). A1 added the
mtime/size **stat-gate** so a routine round no longer re-reads + re-SHA-256s the whole
vault. It removed the *hashing*, but `buildLocalState` still **stages the bytes of every
file** into the snapshot's content map. At F≈8390 that staging is ~52s — **92% of a 56s
converged round** (on-device log, 2026-07-24) — even when the round changes nothing.

This spec defines the next cut: **stage bytes only for the files the merge actually
needs.**

Companion docs: `docs/steady-state-round-optimization-spec.md` (A1, the gate we build on),
`docs/mobile-perf-baseline-spec.md` (the numbers), `docs/sync-engineering-guide.md` (§4
round anatomy, §5 invariants — **must not break**).

---

## 0. Ground rule: no users, no release yet

Same as A1 §0. **No published release, no users.** Persisted schemas and the round's
internal shape may change freely — no migration code, no compat shims. A dev's stale
`.vault-sync/` is disposable (delete + re-enable, or **Rebuild sync metadata**).

**This change needs no migration of existing vaults — there are none to preserve.**
Dropping `send_remote.content` and splitting the host API touch only in-memory / on-the-
wire round shapes and the disposable `.vault-sync/` cache; nothing durable that a real
user's vault depends on exists yet. Build for the clean end-state; do not write compat
code for old on-disk state.

---

## 1. The problem

`PluginVaultSyncHost.buildLocalState(dag)` (`src/network/vault-sync-host.ts:56`) snapshots
the local vault into a `VaultState` the pure merge consumes:

```
VaultState = { deviceId, hlc, fileEntries: Map<id,FileEntry>, pendingOps, contentStore: Map<hash,bytes> }
```

For **every** live registry entry it currently:

1. **Stages the file's current bytes** into `contentStore` — stat-gated (A1): unchanged →
   `contentStore.get(hash)` (content-cache read), drifted → `files.read` + re-hash +
   snapshot-correction (`vault-sync-host.ts:99-122`).
2. **Stages every DAG-reachable base** of the entry's head
   (`reachableContentHashes(headVersionId)`, `vault-sync-host.ts:130-137`).

Even post-A1 (no re-hash for unchanged files), this is **O(vault)**: one content-cache
read per file + the reachable-base walk per head + building a ~22 MB / 8390-entry `Map` in
memory, every round.

Measured (on-device, F=8390, converged round that writes nothing):

| Phase | ms | share |
|---|--:|--:|
| **buildLocalState** | **51928** | **92%** |
| pull | 3001 | 5% |
| applyMerge | 715 | 1% |
| everything else | ~600 | 1% |
| **total** | **56254** | |

The round now *converges* (see the first-sync fixes, commit `f3cb05b`), but every sync
still costs ~52s for zero net work.

---

## 2. What actually needs staged bytes

The pure merge (`mergeVaultStates`) reads `local.contentStore.get(hash)` in exactly two
situations:

- **A file the merge must reconcile** — i.e. one present in the *remote projection*
  (touched since our cursor) or genuinely divergent. It needs that file's **local bytes**
  and its **DAG-reachable base** for the three-way merge.
- **A `send_remote` action** (`state-merge.ts:109-110`): a local-only file falls to
  `send_remote`, but only if its bytes are staged — otherwise the merge degrades it to
  `no_op` (`if (!content) return no_op`).

The decisive facts:

- **`send_remote.content` is dead.** The applicator's `send_remote` case returns `null`
  (`sync-applicator.ts:348` region); no code reads `action.content`. The push happens
  separately (round step 4) from the pending oplog + content store, not from merge actions.
  The bytes are staged *only* to flip the merge from `no_op` to `send_remote`.
- **An untouched file is never reconciled.** If a file is absent from the remote
  projection, the merge no-ops/`send_remote`s it — it never reads its base or does a
  three-way. So its bytes (and its reachable bases) are staged for nothing.

Therefore: on a converged round, **~all 8390 files are untouched**, and **none of their
bytes are needed** by the merge. We stage 22 MB to produce zero reconciliations.

---

## 3. The constraint that makes this non-trivial

`buildLocalState` runs **before** the pull (round order, guide §4: build → pull →
project → merge). So at build time we do **not** yet know which files are touched. Today
it stages everything defensively to guarantee the (synchronous, Map-reading) merge can
find any byte it asks for.

Any fix must keep three things intact:

- **The merge stays pure and synchronous** (guide §3) — it reads a `Map`, not an async
  provider, or a large invasive rewrite follows.
- **The A1 stat-gate snapshot-correction** — `buildLocalState` corrects each entry's
  `contentHash` from disk when the stat drifted, and the **`localAtHead` guard** (guide §5)
  depends on `le.contentHash` being the *true* disk hash for any file the merge touches.
- **F1 (never fabricate) / F5 (in-window edit)** — a touched file whose base bytes are
  missing must still degrade to a conflict, never a union or an empty write.

---

## 4. Proposed design — scoped, post-pull content staging (Option A)

Split the single `buildLocalState` into **identity** (before pull, cheap) and **content
staging** (after pull, scoped to what the merge needs).

### 4.1 Enabling change — decouple `send_remote` from staged bytes

Drop `content` from the `send_remote` action variant (`types.ts:134`) and stop requiring
it in the merge (`state-merge.ts:109-110`): a local-only file classifies as `send_remote`
from its **entry alone**, no bytes read. This is safe because `send_remote.content` is
unused (§2). It is what lets an untouched file need **zero** staging while keeping the
`send_remote` vs `no_op` distinction `updateSyncedPaths` relies on (first-sync path
advancement).

### 4.2 Host: identity build + scoped stage

Replace the port method `buildLocalState(dag)` with two:

```
buildLocalIdentity(dag): VaultState      // fileEntries (+ A1 stat-gate hash correction)
                                         // + pendingOps; contentStore EMPTY. No byte reads
                                         // except re-hashing stat-drifted files (few).
stageContent(state, hashes): void        // fill state.contentStore for exactly `hashes`
                                         // (content-cache read; disk read on miss).
```

`buildLocalIdentity` keeps the A1 gate's **hash correction** (so `localAtHead` still sees
true content) but does **not** stage bytes — the correction only needs to *read+hash*
drifted files, which the gate already limits to the drift set.

### 4.3 Round: stage between pull and merge

In `ServerSyncClient.runSync` (`server-sync.ts`), after reconstructing the remote
projection and before `mergeVaultStates`:

```
const touched = new Set(remote.fileEntries.keys())            // files the merge will reconcile
const needed = new Set<string>()
for (const id of touched) {
  const le = local.fileEntries.get(id); if (!le || le.deleted) continue
  needed.add(le.contentHash)                                  // local bytes
  if (le.headVersionId)
    for (const h of workingDag.reachableContentHashes(le.headVersionId)) needed.add(h)  // bases
}
host.stageContent(local, needed)                              // O(touched), not O(vault)
```

The merge is unchanged: it still reads `local.contentStore.get(hash)`; the map is now
*scoped* instead of *complete*. Untouched files are absent from the projection, so the
merge never asks for their bytes — a cache miss for a genuinely-needed base still degrades
to conflict (F1), exactly as today.

Result: staging drops from O(vault) to **O(files touched this round + their bases)** —
zero on a converged round, so the round collapses to the pull + the cheap identity build.

### 4.4 Considered and rejected

- **Option B — lazy async content provider** (merge pulls bytes on demand): cleanest data
  flow but makes the merge async, rippling through `state-merge`, the reconcile sweep, and
  every unit test. Too invasive for the win; revisit only if A2 proves insufficient.
- **Option C — in-memory content cache in `ContentStore`**: keeps bytes hot across rounds
  so staging is a memory hit. Cuts disk reads but still builds an O(vault) map every round
  and holds 22 MB resident. A partial win; a possible *stopgap* but not the fix.

---

## 5. Invariants that must not break (guide §5)

- **`localAtHead` guard.** `buildLocalIdentity` must still correct `le.contentHash` from
  disk for a stat-drifted file, so the merge can tell a real head from an unlogged
  in-window edit. Unchanged from A1 — only byte *staging* moves, not hash correction.
- **F1 — known-but-missing base → conflict.** A touched file whose base bytes aren't in
  the scoped stage (GC'd / never cached) must still surface a conflict, not a union. The
  merge already handles a missing base this way; scoping only changes *which* hashes are
  present, never the missing-base semantics.
- **F5 — in-window edit.** Unaffected: the applicator's `driftedSinceSnapshot` re-reads the
  live file at apply time; it does not depend on the snapshot content map.
- **Determinism / commutativity.** The merge inputs for a touched file are identical to
  today (same entries, same staged bytes); untouched files were already no-ops. Output is
  byte-identical.
- **`send_remote` semantics.** Dropping its `content` must keep `updateSyncedPaths`
  advancing the first-sync synced path for local-only files (it keys on `action.type`, not
  content) — verify the first-sync path-advancement test still passes.

---

## 6. Testing plan

- **New: staging is scoped.** A two-device round that touches 1 file out of N must call
  `stageContent` with a hash set of size O(1), not O(N). Spy on `host.stageContent` /
  count content-cache reads during the round (mirror `first-sync-registry-batching.test.ts`).
- **New: converged round stages nothing.** A self-sync of N files with no changes stages
  zero hashes and still produces N `send_remote`/`no_op` actions and 0 local writes.
- **Regression (must stay green):** `core.test.ts` (all `mergeVaultStates` cases),
  `concurrent-conflict-dataloss`, `edit-during-sync-dataloss` (F5), the F1
  "base recorded but bytes missing → conflict" case, `contract-suite`,
  `reconcile-conflict-spin`, and the first-sync path-advancement test.
- **Durability:** `reload()` mid-scenario — identity build + scoped stage must reconstruct
  the same merge inputs after a restart.
- Confirm on-device: a converged F≈8390 round drops from ~56s toward the pull-bound floor
  (~3-4s).

---

## 7. Rollout

1. Land §4.1 (drop `send_remote.content`) with the classifier/tests green — small, isolated.
2. Split the host port into `buildLocalIdentity` + `stageContent`; keep a thin
   `buildLocalState = identity + stage(all)` shim only if needed to land incrementally,
   then delete it.
3. Move staging into the round (§4.3); update `TestDevice`'s host wiring.
4. Add the §6 scoping tests; run `npm run build && npx vitest run` (all green) and glance
   at coverage for new blind spots.
5. On-device re-measure; record the new round breakdown in
   `docs/perf-baseline-2026-07-23.md` (or a dated successor) and update the guide §7
   `buildLocalState` bullet from "standing hotspot" to "scoped (A2)".

---

## 8. Open questions

- **Reachable-base staging depth.** For a *touched* file we stage `reachableContentHashes`
  of its head. Is that set itself ever O(history) deep enough to matter, or is it bounded
  by the LCA distance? If deep chains appear, cap staging at the actual LCA
  (`mergeBase(localHead, remoteHead)`) rather than the full reachable set.
- **Do we still need the whole `fileEntries` map?** The merge iterates the union of local
  and remote ids to detect local-only files and path collisions, so identity must stay
  complete. Building an 8390-entry `Map` is far cheaper than staging bytes, but if the
  identity build itself shows up post-A2, consider an incremental/persisted identity
  snapshot (out of scope here).
