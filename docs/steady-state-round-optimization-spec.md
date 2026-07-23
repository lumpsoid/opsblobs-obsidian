# Vault Sync — Steady-State Round Optimization Spec (A1)

**Status:** Draft / decision-of-record · **Date:** 2026-07-23 · **Owner:** client/perf

The mobile perf baseline (`docs/mobile-perf-baseline-spec.md`) and the first on-device
sweeps established the ranking: the **capture** path was fixed first (registry batching
`ddfc600`, content sharding, and the **mtime/size capture gate** `e84d5cb` —
`docs/capture-optimization-spec.md`). The remaining top hot-path is **A1 / B1: every
routine sync round re-reads and re-SHA-256s the *whole* live vault** inside
`PluginVaultSyncHost.buildLocalState()`, independent of the delta. This spec defines
that fix: extend the *already-shipped* capture gate into the round.

Companion docs: `docs/mobile-perf-baseline-spec.md` (Appendix A #1, scenario B1 — the
numbers), `docs/capture-optimization-spec.md` (O1, the gate we are extending),
`docs/sync-engineering-guide.md` (the invariants in §5 below **must not break**).

---

## 0. Ground rule: no users, no release yet

Same as the capture spec §0. **No published release, no users.** Persisted schemas may
change freely; no migration code, no compat shims. A dev's stale `.vault-sync/` is
disposable (delete + re-enable, or **Rebuild sync metadata**). Design for the clean
end-state.

---

## 1. What the baseline established (the problem)

`buildLocalState()` (`src/network/vault-sync-host.ts:42-91`) is called to snapshot the
local vault into a `VaultState` the merge consumes. For **every** live registry entry it
unconditionally `this.files.read(entry.path)` **and** `hashContent(content)` — even for a
one-file delta.

Measured (perf-baseline B1, and confirmed on native-ARM device):

| Profile | fileReads | sha256 | roundMs (laptop) | roundMs (phone, native ARM) |
|---|--:|--:|--:|--:|
| S (F=500) | 500 | 501 | 38 | 121 |
| M (F=2000) | 2000 | 2001 | 153 | 484 |
| L (F=10000) | 10000 | 10001 | — | **6590** |

`sha256 ≈ F+1` for a **one-file** edit: the round hashes the whole vault. On L this is
6.6 s per keystroke-sync on the *fast* engine (the number that hung the on-device
sweep). `buildLocalState` is also re-run **per reconcile fold** (`reconcileConcurrentHeads`,
B7), so the cost multiplies.

**The redundancy.** The round coordinator runs, in order
(`sync-coordinator.ts:110-114`): `saveOpenEditors → flush → captureOfflineChanges →
runRound`. So `captureOfflineChanges` — which since `e84d5cb` **already** reconciles the
registry with disk under the exact `mtime && size` gate — has run *milliseconds before*
`buildLocalState`. The round's re-hash re-does, unconditionally, the O(F·B) drift scan
the capture gate just did in O(touched). It is redundant work.

---

## 2. Goals & non-goals

**Goals**
- A routine round's `buildLocalState` is **O(touched·B)** for the SHA-256 pass, not
  O(F·B): a one-file delta hashes ~1 file, not F.
- Preserve **every** data-safety invariant (§5). The merge must see a byte-identical
  `VaultState` for every file it actually touches.

**Non-goals**
- Eliminating the *reads/byte-staging* for untouched files (Phase 2 — §4).
- `memCache` bounding (B6 / A3), DAG-walk memoization (B2), cold-pull (B4) — separate.
- Any migration/compat tooling (§0).

---

## 3. R1 — mtime/size gate in `buildLocalState` (Phase 1, primary)

**Design.** Mirror the capture gate. `FileEntry` **already** carries the local-only
`mtime`/`size` (added by `e84d5cb`); `VaultFileRef` from `this.files.list()` already
carries stat from `TFile.stat` (no extra syscall). So:

1. At the top of `buildLocalState`, call `this.files.list()` once → a `Map<path,
   VaultFileRef>`.
2. Per registry entry (live, non-deleted), look up its `ref` by `entry.path`:
   - **Gated** — `ref` present **and** `entry.mtime === ref.mtime && entry.size ===
     ref.size`: the content is unchanged. **Skip `files.read` and `hashContent`.** Use
     `resolved = entry` (trust `entry.contentHash`) and stage the bytes **without
     hashing**: `this.contentStore.get(entry.contentHash)` (fast — usually a memCache /
     blob hit), with a **disk-read fallback on a store miss** (preserves today's "a live
     file's bytes are always stageable" guarantee; no hash needed, the stat says
     unchanged).
   - **Not gated** — `ref` absent, stat differs, no `headVersionId`, or a placeholder
     (`contentHash === ''`): fall through to **exactly today's** read + hash +
     snapshot-correction path (`vault-sync-host.ts:63-74`, unchanged).
3. Leave the DAG-reachable ancestor staging (`vault-sync-host.ts:80-90`) untouched.

**Impact.** Each `buildLocalState` call drops from **F SHA-256 → ~touched SHA-256**. The
per-fold rebuilds in `reconcileConcurrentHeads` (B7) become O(touched) too — a free
partial B7 win.

---

## 4. R2 — skip byte-staging for the merge's non-working-set (Phase 2, optional)

The merge only reads local bytes for files in `union(local-touched, remote-delta)` — an
untouched file not in the remote delta merges to `no_op` and its bytes are never read
(`src/merge/state-merge.ts`). So staging every gated file's bytes at all is wasted; a
truly O(touched) round would stage only the working set.

This needs the remote delta's `fileId` set threaded into `buildLocalState`, or a lazy
content provider the merge pulls from. It is a **bigger, riskier** change (merge-input
completeness). **Defer** until Phase 1's on-device number proves it's worth it — Phase 1
already removes the SHA-256, which is the accumulating CPU cost B9/A1 name.

---

## 5. Invariants that must not break (`sync-engineering-guide.md` §5/§7)

Verified against the code; the gate preserves each **up to the same mtime+size heuristic
the system already accepts** (capture runs first and already gates identically, so R1
adds **no new** data-safety risk surface):

1. **The un-opped-edit data-loss safeguard** (`vault-sync-host.ts:67-73` — never alias
   stale bytes over a disk edit that isn't an op yet). For a *stat-unchanged* file
   `entry.contentHash` **is** the disk content, so no aliasing. A real un-logged edit
   moves mtime/size → the file is **not** gated → today's re-hash+correction runs. Only
   the bit-for-bit-identical-stat offline edit slips — the documented O1 hole;
   **Rebuild sync metadata** is the escape hatch.
2. **F5 drift-deferral** (`sync-applicator.ts:349` `driftedSinceSnapshot`;
   `state-merge.ts:146,286` `localAtHead`). Both compare against `le.contentHash` = "the
   disk hash at snapshot time." For a gated file `entry.contentHash` equals snapshot-time
   content, so `localAtHead` and the drift compare behave **identically**. A mid-window
   edit moves stat → re-hashed here, or caught by `driftedSinceSnapshot`'s own re-read at
   apply time. Preserved.
3. **Merge sees byte-identical inputs.** For every file the merge touches, the staged
   `(contentHash → bytes)` entry is the same as today (store-get / disk-fallback yields
   the same bytes under the same hash). Phase 1 changes *how* bytes are obtained, never
   *which*.
4. **DAG / content addressing untouched.** R1 changes neither hashes, bytes, version-ids,
   nor the ancestor-staging walk.

---

## 6. Testing & measurement (guide §8 — real stack over `TestDevice`, never a reimpl)

Model on `__tests__/capture-stat-gate.test.ts`:

1. **The win.** Converge, edit **1** file, run a round → `buildLocalState` (or the round)
   hashes ≈1, not F. Assert via a `hashContent` spy / the bench's CPU counter — the
   objective before/after.
2. **No data loss.** A genuine concurrent divergence (two devices edit the same file off
   a shared base) still three-way-merges correctly with the gate on — **both edits
   survive**, no silent adoption.
3. **F5 preserved.** An in-window edit (mtime bumped mid-round) still defers/conflicts,
   not silently clobbered.
4. **Store-miss fallback.** A gated file whose blob is absent from the content store
   still stages bytes (disk fallback) → merge unaffected.
5. **Fall-through cases.** Placeholder (`contentHash===''`) / no-`headVersionId` entries
   take the read path.
6. **Regression:** full suite green; `npm run build` clean.

**Bench (Layer 1/2):** re-run `npm run bench`; **B1 `sha256` drops F+1 → ~1** at every
profile, `fileReads` drops toward ~touched, `roundMs` falls; B2/B7 no regression.
⚠ `npm run bench` **overwrites** `bench/results/2026-07-23_xs-s-m.{json,md}` (the
committed pre-batching baseline) — `git checkout --` those two after, compare against
`bench/results/2026-07-23_post-capture-fix_xs-s-m.*`.

**On-device (Layer 3):** rebuild (`npm run build:dev`), redeploy
(`scripts/deploy-android.sh`), confirm a routine 1-file-edit round on a large vault is no
longer O(F). Record into `docs/perf-baseline-2026-07-23.md`.

---

## 7. Order of work & deliverables

- [ ] **R1 — `buildLocalState` mtime/size gate (Phase 1).** Single-file change to
      `src/network/vault-sync-host.ts` (+ maybe a tiny content-store fallback helper).
      Tests `__tests__/round-stat-gate.test.ts` (the six above) over the real stack.
      Prove with bench B1 (`sha256` F+1 → ~1).
- [ ] **R2 — working-set byte-staging (Phase 2)** *(only if Phase 1's device number
      still shows O(F) reads dominating).*
- [ ] Re-measure Layer 2 (`npm run bench`) + Layer 3 (device); update the perf baseline.

## 8. Success criteria

| Operation | Target |
|---|---|
| routine round (1-file delta), `sha256` | **≈ 1**, not F+1 — the R1 win |
| routine round (1-file delta), M profile | materially below the 484 ms native-ARM floor |
| existing suite | green; no B2/B7 regression |

If R1 lands and a 1-file-delta round still hashes F files, the gate isn't working — treat
as a correctness bug, not a tuning miss.

---

## 9. Handoff / current context (2026-07-23)

Read `docs/sync-engineering-guide.md` first (mandatory before any core/merge/network
change), then this + `docs/capture-optimization-spec.md` (the gate being extended).

**Status.** Spec written on branch `sync-robustness-fixes` (off `master`). The gate
infrastructure already exists: `FileEntry.mtime/size` (optional, local-only) and
`VaultFileRef.mtime/size` shipped in `e84d5cb`; `captureOfflineChanges` already gates on
them and runs before every round. R1 is *reusing* that, not building it.

**Repo workflow facts:**
- Build/test: `npm run build` (= `tsc -noEmit -skipLibCheck && esbuild`), `npx vitest run`.
  Bare `tsc --noEmit` shows pre-existing vitest/vite resolution noise — ignore; use the
  build script. `noUncheckedIndexedAccess` is ON (index access needs `!`).
- **Commits omit the `Co-Authored-By` trailer** (`[[no-coauthor-trailer]]`). Conventional
  commits (`perf(sync): …`).
- Tests **drive the real stack over in-memory fakes** via `TestDevice`
  (`__tests__/helpers/test-device.ts`). `FakeVaultFiles.io.*` counters are the
  ground-truth I/O assertions; a `hashContent` spy / the bench CPU counter proves the
  hash-count drop.

**R1 concrete plan (`src/network/vault-sync-host.ts`, `buildLocalState`).**
- Add `const refs = new Map<string, VaultFileRef>(); for (const r of await
  this.files.list()) refs.set(r.path, r);` once at the top.
- In the per-entry loop, before the `this.files.read` at line 64, insert the gate: if
  `!entry.deleted` and `entry.headVersionId` and `entry.contentHash !== ''` and a matching
  `ref` with `entry.mtime === ref.mtime && entry.size === ref.size` → stage bytes via
  `this.contentStore.get(entry.contentHash)` (fallback: `this.files.read` on a store miss,
  **no** re-hash), set `resolved = entry`, and skip the hash. Else the existing path.
- Guard: `entry.mtime`/`entry.size` may be `undefined` on a projected/adopted entry — a
  strict `===` against a number simply fails to gate → safe fall-through to read+hash (one
  self-healing re-hash, exactly like capture).
