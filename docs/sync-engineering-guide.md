# Sync Engineering Guide

The durable orientation doc for anyone — human or agent — changing the sync engine.
AGENTS.md covers generic Obsidian-plugin conventions; this covers *how this project's
sync actually works, why it's built this way, and how to change it without causing
silent data loss.* Read this before touching anything under `src/core`, `src/merge`, or
`src/network`.

This guide describes the **v2 model: a commit DAG keyed by op-id** (a mini-Git for the
vault). The rationale lives in `docs/sync-v2-decisions.md` (the *why*) and the ordered
migration history in `docs/sync-v2-migration-spec.md` (the *how it landed*); this guide
folds in the decisions and is the living doc. Where a v1 concept is named (the scalar
`ancestorContentHash`, `ancestor-policy.ts`, `supersedes`, the blocking conflict modal,
the outstanding-conflict badge lifecycle), it is called out as **historical / retired** —
those are gone from the code, but they explain the shape of the bugs the DAG fixed at the
root.

The specs in `docs/*-spec.md` and the `*_AUDIT.md` files at the repo root are
**point-in-time** (plans and findings). This guide is meant to stay current — update it
when an invariant or pattern changes.

---

## 1. What this is

An **end-to-end-encrypted vault sync** for Obsidian against an *untrusted* server. The
server stores only ciphertext + routing metadata and **never merges** — all conflict
resolution is client-side. Two (or more) devices sharing a passphrase converge to the
same vault state by replaying an ordered log of operations.

The core mental model: each device keeps a **local op log** and a **cursor** into the
server's global op sequence. A sync round pulls new remote ops, merges them into local
state, applies the result to the vault, pushes local ops, and advances the cursor. The
merge is a **CRDT-style deterministic replay**: every device that sees the same source
ops computes the same result, so most merge output is *not* re-pushed (it's redundant).

The prime directive, everywhere: **the user's data is critical and must never be
silently overridden, dropped, or left divergent.** When in doubt, defer and surface —
never guess and overwrite.

---

## 2. The v2 model: a commit DAG keyed by op-id

This is the one big idea; everything in §3–§5 is a consequence of it. Read this before
the module map.

**The problem v2 solves.** A three-way merge needs the *common ancestor* of two versions
— a fact about causal structure. v1 stored a **guess** (a single mutable scalar
`FileEntry.ancestorContentHash`) and maintained it by a **policy** (`ancestor-policy.ts`).
A scalar can't represent causal history, so the policy was a lossy approximation, and
every place it diverged from true causality became a bug that got patched locally
(`baseContentHash` fast-forwards, the `supersedes` side-table, the badge lifecycle). The
F1–F7 / G11/G13 / H5 / S1–S5 history reads as a series of leaks in one lossy abstraction.
v2 records the structure and **derives** the ancestor.

**The rules (this is the whole thing):**

1. **A version = an op-id.** Every op already has a unique, HLC-ordered `id`
   (`hlcToString(hlc)`). That is the version's identity. It carries a `contentHash`
   (blob address) and a `fileId`.
2. **Every op names its causal `parents`** — the version-id(s) it descended from:
   - `create` → `parents: []` (a DAG root)
   - `update` (ordinary edit) → `parents: [prevHeadVersionId]`
   - `merge` (clean auto-merge or human resolution) → `parents: [headA, headB]`
   - `delete` → a tombstone version with `parents: [prevHeadVersionId]`
3. **The DAG is persisted and accumulated** (`.opsblobs/version-dag.json`): every op
   ever authored or pulled contributes its `(versionId → parents, contentHash, fileId)`
   edge. Version-ids/hashes are tiny, so the graph survives content GC. The one thing
   that removes a node is the **reachability sweep** (`sweepToRoots`, on the content-GC
   schedule): mark from every version the registry still names — the head of every entry,
   live *and* tombstoned, plus both `conflictParents` of a two-headed file — keep their
   ancestors, drop the rest. That is answer-preserving by construction (`LCA(ourHead, any
   head)` is an ancestor of `ourHead`, which is a root), so it reclaims *forgotten files'*
   subgraphs only; per-file history is still unbounded. Note the asymmetry that makes a
   *retention horizon* a different and much riskier proposition: a horizon deletes
   oldest-first — the shared `create` — and a lost base does **not** degrade to a
   conflict. `mergeBase` returns `null`, which reads as "no common ancestor" and merges
   both sides against an *empty* base, silently duplicating the file (§the F1 rule).
4. **A "head" is a leaf** (no child). One head = converged; **two heads = divergence**.
   The registry names the local head per file (`FileEntry.headVersionId`).
5. **Merging two heads is pure and total** (`mergeVaultStates`):
   - `LCA(A, B)` over the version-id DAG is the merge base `O`.
   - `A` reachable from `B` (or vice versa) → **fast-forward**, take the descendant.
   - else three-way over the *content* at `(O, A, B)`: **clean** → deterministic merged
     bytes recorded as a merge version `parents: [A, B]`; **conflicting** → write diff3
     markers to the file and leave *both* heads open until a human save reconciles them.
   - `LCA` **ambiguous** (multiple incomparable bases, a criss-cross) → treat as a
     conflict; never guess a base.

**Why op-id and not the content hash (load-bearing).** Content *recurs* — `empty → "3" →
empty`, an undo, a checkbox toggle. A content-hash-keyed DAG forms a **cycle**
(`"" → "3" → ""`), which breaks LCA and re-introduces spurious conflicts. Op-ids are
unique and HLC-monotonic (a parent's HLC is strictly below its child's), so the DAG is
**acyclic by construction** — Git's `hash(tree+parents)` trick, using the op-id we
already mint. The content hash is kept *only* as the blob address. With op-ids the
recurring case is `id_empty → id_3 → id_empty2` (three distinct nodes) → fast-forward, no
conflict. See `version-dag.ts`'s header and decisions §3.

**Why op-id and not a git-style "commit at sync":** op-id keeps all work **incremental
and mobile-cheap** — one node per debounced edit (≈ one per save), formed at edit time;
sync just pushes ops that already exist. Cost is `O(changes since last sync)`, never
`O(vault size)`.

**The determinism split (the subtle rule).** Clean merges are a *deterministic* function
of `(O, A, B)` content — diff3 with stable line-splitting yields byte-identical output on
every device, so two devices merging the same pair mint different op-ids but identical
content and reconcile by fast-forward next round (no storm). **Human conflict resolutions
are NOT deterministic** and therefore *must be shared* — as a merge version
`parents: [A, B]` that peers adopt by plain fast-forward. This split is what v1 faked
with `supersedes`; v2 makes it structural.

**Convergence for a fresh device, and why pruning can't break it.** The **server op log
is the source of truth**; each device's DAG is a *derived local cache*. A new device
pulls the ops and builds its own DAG — it never reads a peer's DAG. Therefore local
pruning/collapsing is invisible to other devices and is an **optional, deferred** space
optimization; correctness never depends on it. The first cut **keeps the full local DAG**
(nodes are tiny). Any future pruning must be gated on a version-vector proving causal
stability, **never on wall-clock age**.

---

## 3. Architecture: ports & adapters

The single most important structural rule:

> **Logic lives in obsidian-free modules behind ports. Anything that imports `obsidian`
> is thin glue, verified by manual smoke — never business logic.**

This is what makes the engine unit-testable without a running Obsidian. Layers:

- **Ports** (`src/ports/`) — narrow interfaces the engine depends on:
  `VaultFiles` (read/write/move/trash), `MetadataStore` (`.opsblobs/*` persistence),
  `VaultWatcher` (create/modify/delete/rename events), `EditorSaver` (flush open
  editors), `Notifier` (user-facing toasts).
- **Obsidian adapters** (`src/network/obsidian-*.ts`) — the *only* place `obsidian` is
  imported besides `main.ts` and `src/ui/`. Each is a dumb pass-through implementing a
  port. **Keep them dumb.** They are not unit-tested (no real Obsidian in tests); their
  behavior is pinned as assumptions in `__tests__/helpers/fakes/README.md` and verified
  by manual smoke + the Go-server integration suite.
- **Engine** (`src/core`, `src/merge`, `src/network/*` minus the adapters) — pure/
  obsidian-free. This is where correctness lives and where tests concentrate.
- **Glue** (`src/main.ts`, `src/ui/`) — plugin lifecycle, ribbon/status rendering, view/
  modal construction, settings. `main.ts` is a *thin adapter*: it wires real
  implementations into the engine and renders state; it holds almost no logic.

If you find yourself writing a branch, a loop, or a decision inside `main.ts` or a view,
stop — that logic belongs in an obsidian-free module (usually `SyncCoordinator` or the
relevant `core`/`merge` unit) with a port for the Obsidian bit.

### Module map (engine)

| Module | Role |
|--------|------|
| `core/hlc.ts` | Hybrid Logical Clock — total ordering of events across devices; persisted (F7) so logical time never regresses across a wall-clock jump. Also mints each op's id (`hlcToString`). |
| `core/version-dag.ts` | **The v2 causal graph.** Pure, in-memory DAG of `versionId (op-id) → { parents, contentHash, fileId }`. `isAncestor` / `mergeBase` (LCA, returns `MULTIPLE_BASES` on a criss-cross) / `isMergeNode` (≥2 parents) / `contentHashOf` / `leaves(fileId)` (open heads — 1 = converged, ≥2 = un-reconciled divergence) / `reachableContentHashes(versionId, bounds?)` (base-bytes staging + GC keep-set; `bounds.has`/`bounds.maxDepth` cut the ancestor walk at the first version whose bytes are gone, so its cost is O(retained history), not O(edits-ever)). Acyclic by construction (op-id keys). |
| `core/file-registry.ts` | The source of truth for file **identity**: UUID → `{path, contentHash, headVersionId, lastSyncedPath, deleted, conflictParents}`. `adoptRemote` converges identity across devices and records the adopted head. `referencedHashes(dag?, bounds?)` is the content-GC keep-set (live content + DAG-reachable merge bases). Pass `bounds.has = contentStore.hasStored` to bound the walk — a hash the store does not hold cannot be collected anyway, so cutting there never shortens the keep-set below what `gc()` needs; a `maxDepth` shorter than the retention window WOULD. `compact({now, pinned})` additionally **reclaims stale tombstones** (see §5 below); `entriesIterator()` is the allocation-free read for scanning/counting (`getAllEntries()` copies the whole Map — never call it from a per-edit path). |
| `core/content-store.ts` | Hash → bytes cache (`.opsblobs/content/`). Age-aware GC (`gc(keep, retentionMs, now)`); the keep-set now sees the DAG so reachable merge bases survive (Step 8). The coordinator runs it after a successful round at most once a day (`gcDue`/`lastGcAt`) — it used to run only from the settings button, so `ancestorRetentionDays` was effectively advisory. |
| `core/operation-logger.ts` | Watches vault events, debounces edits into ops (each carrying `parents: [prevHead]`), persists the pending oplog, advances `headVersionId`. Cold-start capture (`captureOfflineChanges`), force-push baseline (`captureAllAsBaseline`), and the two-headed → merge-node resolution branch (`flushModify` emits `Ops.merge` when a save removes conflict markers). |
| `core/operations.ts` | Op factories (`Ops.create/update/delete/move/merge/mergeDelete`) + `mergeVersionId` (deterministic content-addressed `m-` id for merge nodes, commutative in parents). The single catalog of op shapes. |
| `core/conflict-inventory.ts` | `listTwoHeadedConflicts(entries)` — the *derived* query over `FileEntry.conflictParents` that IS the text-conflict list (with per-head HLC provenance). No hand-maintained set. |
| `core/conflict-policy.ts` | Pure delete-conflict strategy (`resolveDeleteStrategy`) shared by the merge and the applicator. |
| `core/exclusion-policy.ts` | Glob-based path exclusion (`.obsidian`, `.opsblobs`, user patterns). |
| `merge/state-merge.ts` | **The heart.** Pure `mergeVaultStates(local, remote, dag?) → actions`. Commutative & deterministic. Fast-forward / LCA-base / clean-merge / conflict per file, all from DAG topology (`isUnchangedSinceBase`, `resolveContentConflict`, `resolveCreateCollision`). |
| `merge/diff3.ts` | Three-way line merge + `resolveConflictChunkLines`; the marker helpers `renderConflictMarkers` / `renderMarkersFromResult` / `hasConflictMarkers` / `parseConflictMarkers` / `resolveMarkedText` / `countMarkerConflicts` (the in-context conflict UX + the panel's compare). |
| `network/server-sync.ts` | `ServerSyncClient.runSync()` — orchestrates one round (build→pull→fetch→push→**record DAG edges**→merge→apply→**reconcile concurrent heads**→cursor). Obsidian-free; driven by fakes in tests. Also `reconstructRemoteState`, `reconcileConcurrentHeads` (the multi-head sweep — see `docs/multi-head-reconciliation.md`), and `safeCursor`. |
| `network/sync-applicator.ts` | Applies merge actions to the real vault (writes/moves/trashes, writes conflict markers, mints merge nodes via `mintMergeResolution`). Reports `deferred` + `deferredConflicts` fileIds back to the round. |
| `network/vault-sync-host.ts` | `PluginVaultSyncHost` — bridges the obsidian-free round to the live stores. `buildLocalIdentity` snapshots entries + pending ops with the A1 stat-gate hash correction and **no** O(vault) byte staging; `stageContent(state, hashes)` fills the content store for exactly the hashes the round scopes (A2). |
| `network/version-dag-store.ts` | Persists the `VersionDag` incrementally: a compacted snapshot (`version-dag.json`) + an append-only JSONL journal (`version-dag.log`) of edges since. A round `appendEdges` only its *new* edges (O(delta)); the O(N) full rewrite is deferred to `compact()` past a threshold. Defensive `load()` = snapshot ⊕ journal-replay, tolerant of a missing/corrupt snapshot and a torn trailing journal line. |
| `network/sync-coordinator.ts` | Obsidian-free orchestration: the capture→round→record sequence, delete/binary conflict decisions (always defer to the panel; consume a `pendingDecision` when present — §3 "full inline"), reset/rebaseline. `deferredConflictCount()` is a derived per-round count (no badge bookkeeping). |
| `network/sync-state-store.ts` | The **observable** sync state (`.opsblobs/sync-state.json`): `deferred` files (each `reason: 'drift' \| 'conflict'`), `stranded` content, last error, last-round summary. No outstanding-conflict set (retired in Step 7). |
| `network/cursor-store.ts` / `hlc-store.ts` | Scalar cursor + persisted HLC. |
| `network/encryption.ts` | `VaultCrypto` — passphrase-derived key, op/blob envelopes, blinded content hashes (unlinkable dedup). |
| `network/server-http.ts` / `fake-server.ts` | Real HTTP `ServerApi` vs in-memory fake (contract-tested to be equivalent). `HttpServerApi` bounds every `requestUrl` with `withTimeout` and maps each transport outcome to the typed error family (401/403→auth, 404→not-found, 5xx→server, no-response→network). |
| `network/sync-cancellation.ts` | `SyncCancelToken`/`SyncCancelledError` — cooperative "Cancel sync". Checked only through the end of a round's step 3 (§4); never past the point the round starts mutating the local vault. |
| `network/sync-errors.ts` | The **user-actionable typed-error family** every round can throw — `KeyMismatchError` (passphrase guard), `AuthError`/`NotFoundError`/`ServerError`/`NetworkError`/`TimeoutError` (transport), `DecryptError` (wrong/legacy key at pull), `StaleCursorError` (internal, F4). Each `message` is written for the user; the coordinator toasts it verbatim. Obsidian-free. |
| `network/with-timeout.ts` | Pure `withTimeout(op, ms, label)` — bounds a hung `requestUrl` (which has no native timeout) and rejects with `TimeoutError`. The detached request is harmless (idempotent writes). |
| `ui/conflicts-view.ts` | The non-blocking Conflicts panel (an `ItemView`): the single "needs your attention" surface — two-headed text files (per-hunk 3-way compare, applied through the ordinary save path) **and** delete/binary conflict cards resolved inline (records a `pendingDecision`, §3 "full inline"). |

---

## 4. Anatomy of a sync round (and its load-bearing invariants)

`ServerSyncClient.runSync()` (`server-sync.ts`) — the order and the *why* both matter:

0. **Key-agreement guard.** GET the vault's **key-check record** (a reserved, non-blinded
   64-hex blob slot, `sha256("vault-sync:keycheck:v1")`) and `verifyKeyCheck` it against this
   device's derived key *before* decrypting a single pulled op or pushing under our key. A
   present record our key can't reproduce → throw `KeyMismatchError` (a mistyped passphrase /
   wrong salt) — a clean, self-explaining failure instead of a two-key wedge or a raw AES
   exception mid-pull. Absent → nobody stamped the vault yet; we `buildKeyCheck` + PUT it once
   our key is *established* (we decrypted existing ops, or we're the first device pushing),
   before pushing our ops. The PUT is idempotent/first-write-wins, so a race resolves to one
   record and the loser is caught by the guard next round. A withholding server (omission →
   staleness, per the spec threat model) degrades this to the pre-guard status quo, never
   corruption.
1. **`buildLocalIdentity()`** — snapshot registry entries + pending ops, with an
   **empty** content store (A2). It re-hashes only *stat-drifted* live files against the
   registry and corrects the snapshot to the *real disk hash* (never the stale recorded
   one) so the merge compares true content and the `localAtHead` guard holds; it keeps
   just those drift-read bytes so staging needn't re-read them. It stages **no** other
   bytes — the O(vault) byte staging moved out of this before-pull step. Content is
   staged later, scoped (step 5 below): the whole-vault snapshot was ~92% of a converged
   round at F≈8390 (`docs/build-local-state-perf-spec.md`).
2. **Pull** remote ops since the cursor, decrypt each. Keep each op's server `seq`.
3. **Reconstruct the remote projection** (`reconstructRemoteState`) and fetch the blobs
   it needs (verifying each decrypts back to its asserted content hash).
   - **Exclude our own re-pulled ops** from the projection. We persist the *pull* cursor,
     not the append head, so our own ops re-pull every round; projecting them as "remote"
     would corrupt the base and silently clobber a peer's concurrent edit.
4. **Push** our pending ops (blobs first, then the append) — *before* applying, so ops
   are durable on the server before the local oplog is cleared. The append is idempotent
   by `clientOpId`, so a crash in between is safe.
5. **Record this round's DAG edges** (`recordVersionEdges([...local.pendingOps,
   ...pulled])`) **before** the merge, so both this round's heads are in the DAG the merge
   reads. Then **stage content, scoped** (A2, `stageMergeContent`): the identity build
   staged nothing, so before the merge stage exactly the local bytes + DAG-reachable
   bases of the files the merge reconciles — the remote projection's ids plus any
   local-only file colliding by path with a live remote entry (F2). A converged round
   scopes to zero. (The push at step 4 separately staged the pending ops' own content so
   their blobs upload — a local-only `send_remote` file's bytes are read by neither the
   merge nor the identity build.) Then **merge + apply** —
   `mergeVaultStates(local, remote, dag)`, advance the HLC
   past the merged time *before* applying (so a merge node minted during apply dominates
   what it supersedes), then `applicator.applyActions`.
6. **Reconcile concurrent heads pulled together** (`reconcileConcurrentHeads`, "step 4b").
   `reconstructRemoteState` collapses the pulled ops to one entry per fileId (HLC-max), so a
   round that pulled ≥2 concurrent heads for one file reconciled our head against only that
   one and left the rest as un-reconciled DAG leaves. This sweep folds every extra concurrent
   leaf into the local head via the ordinary pairwise `mergeVaultStates`, so the puller
   converges by itself instead of waiting on whichever peer already merged them. Skips
   deferred files (F5) and disconnected/tombstone leaves; a missing leaf blob holds the cursor
   (F3). Full rationale + the 3+-head convergence analysis in
   `docs/multi-head-reconciliation.md`.
7. **Save the cursor** via `safeCursor(...)`, which **holds the cursor back** when a blob
   was unavailable (F3) or a destructive action was deferred (F5/auto-defer), so those
   ops re-pull next round instead of being stranded.

Invariants you must preserve if you touch the round:
- **Push before apply.** Durability first; idempotent append makes it crash-safe.
- **Persist the pull cursor, not the append head** — another device may have appended in
  between; jumping to the head would skip their ops.
- **Record DAG edges before the merge reads them** — the merge's fast-forward/LCA is only
  correct if this round's heads are already nodes.
- **Never advance the cursor past an op you couldn't fully apply** (F3/F5). That's what
  `safeCursor` guarantees; the applicator's `deferred` set drives it.
- **Only locally-authored ops are pushed.** Merge-derived content replays identically on
  every device (redundant). The exceptions are the **merge nodes** — a clean merge and a
  human resolution — which are re-emitted so a fresh decision (and the FF target)
  replicate.

**Cancellation has a hard checkpoint at the top of step 4.** "Cancel sync" (`SyncCancelToken`,
`sync-cancellation.ts`) is cooperative and checked only through the end of step 3 (pull,
blob fetch, push) — everything there is either read-only or already-durable/idempotent
network state (a pushed op, an uploaded blob), so cancelling is exactly as safe as the
round never having run: the un-pushed/un-applied work just sits as pending ops for the
next sync. `runSync` stops checking once `recordVersionEdges`/`mergeVaultStates`/
`applyMerge` begins — that's where the round starts mutating the registry/DAG/disk, and
an interrupted apply is precisely the failure mode cancellation must never risk. Any new
long-running phase before step 4 should get a checkpoint (see the pull/download/upload
loops for the pattern); never add one at or after step 4.

---

## 5. Core invariants (the data-safety spine)

These are enforced across `state-merge`, `sync-applicator`, and `server-sync`. The
`F#` labels appear throughout the code and the `*_AUDIT.md` / `ops-sync-data-safety-spec`
docs.

- **F1 — never fabricate content.** If a winning side's bytes are unavailable, the merge
  returns `no_op` and defers, rather than writing an empty/guessed file. A **known-but-
  missing base** (a real base hash recorded, but its bytes GC'd or never fetched) is *not*
  a valid three-way base — falling back to an empty ancestor would make diff3 union both
  full versions (silent duplication), so the merge **degrades to a conflict** (markers)
  instead. Only a genuinely-null base (no common ancestor) may use the empty ancestor.
- **F2 — create/create identity collision.** Two devices independently creating the same
  path mint different UUIDs. `resolveCreateCollision` converges them to one id
  deterministically (`adoptRemote`), raising a conflict only for genuinely different
  content; a resolution merge node is FF-adopted.
- **F3 — stranded content.** A referenced blob that can't be fetched holds the cursor
  back and is surfaced as `stranded`, never silently skipped.
- **F4 — stale-cursor 409.** A too-stale append is recovered by re-pulling and retrying
  (bounded), never wedged.
- **F5 — edit during the sync window.** If a file drifts on disk between snapshot and
  apply, the destructive action is deferred, the edit re-captured as an op, and the
  cursor held — the in-flight edit is never overwritten.
- **F7 — HLC persistence.** Logical time is persisted per-op and on shutdown so a
  wall-clock regression can't rewind below an already-issued timestamp.
- **F8 — an apply action that throws is isolated, not fatal.** The applicator catches
  per action, adds the fileId to `deferred` (so `safeCursor` holds the cursor and the
  op re-pulls) and continues, so an unforeseen failure on one file can't skip the
  remaining actions or the post-loop `updateSyncedPaths` / resolution re-emit / F5
  recapture. Failures ride the round summary as `applyFailures` and the coordinator
  records them as the round's error — a held-and-retried file must never *look* like
  it is healing itself when it isn't. Past `MAX_ACTION_FAILURES` the round rethrows:
  a systemic fault must still fail loudly. See §7's reorganization incident.

**Tombstones are a bounded local cache, not the record of a delete.** `markDeleted` only
flips `deleted = true`, so the entry set used to grow with the vault's *lifetime* file
churn even when the live file count was flat — and every dead entry is re-serialized by
`compact()`, re-parsed by `load()`, re-iterated by `buildLocalIdentity`, and unioned by
every merge. The round's post-apply `registry.compact({now, pinned})` now reclaims a
tombstone once **all** of: it is past the retention horizon (`ancestorRetentionDays`,
floored at 30 days — see `MIN_TOMBSTONE_RETENTION_MS`), measured on the HLC wall time
`markDeleted` stamped; no *pending* (un-pushed) op references it — which is why the call
sits post-push; and it carries no `conflictParents`. The durable record of a delete is the
**server op log**: a fresh device replays the delete op and rebuilds the tombstone, so
this is a local-cache decision of the same kind as the blob and DAG windows. **The
tradeoff to know:** the tombstone is what turns a peer's *late* edit to a deleted file
into a delete/edit conflict; past the horizon we hold no entry, so such an op reads as a
plain new remote file and the file comes back. That is a *visible* resurrection (nothing
dropped or overwritten) requiring a peer that went a full window without pulling our
delete — the acceptable side of §7's silent-vs-loud rule. A re-create at a reclaimed path
mints a fresh id (the create op is a fresh DAG root either way, so a peer still holding
the file gets an F2 create/create collision, which converges).

**File identity is by UUID, not path.** The merge is keyed on `fileId`. `adoptRemote`
converges two devices onto one id for the same path and moves the pathIndex — get this
wrong and edits to "the same file" never reconcile (permanent divergence with no conflict
raised). Any new `write_local`-shaped path must keep identity consistent **and carry the
remote op's real `headVersionId`** — do not re-derive a head from the HLC, because a merge
node's id is a content-addressed `m-…`, not `hlcToString(hlc)`.

**The `localAtHead` guard is a data-safety invariant, not an optimisation.** In
`resolveContentConflict` the DAG fast-forward adopts a remote descendant only when
`dag.contentHashOf(le.headVersionId) === le.contentHash` — i.e. local is actually *at* its
head. An unlogged in-window edit (the debounce race) leaves the head stale while
`buildLocalState` corrects `le.contentHash` from disk; without the guard the merge would
treat the stale head as representing local and adopt a remote descendant, silently
clobbering the edit. Preserve it through any merge refactor.

**HLC decides last-writer-wins**, with a deterministic `deviceId` tie-break. Any "winner"
decision (path, content, resolution) must be computed the same way on both devices from
the same inputs, or convergence breaks. Keep merge output **commutative** — `merge(A,B)`
and `merge(B,A)` must agree.

---

## 6. The conflict lifecycle (v2 — derived, non-blocking)

In v2 a conflict is **not** a hand-maintained badge; it is two *derived facts*. The v1
lifecycle (surface → modal decide → `supersedes` replicate → clear-on-convergence →
self-heal) is **retired** — that whole `SyncStateStore` outstanding-conflict set +
`SyncCoordinator` badge bookkeeping is gone (Step 7). What remains:

1. **Surface (text)** — `state-merge` emits a `conflict` action; the applicator writes
   `zdiff3` 3-way markers (base | mine | theirs) at the **real path** (non-blocking, no
   modal, no cursor hold) and records the file **two-headed** via
   `registry.markConflicted` (`FileEntry.conflictParents = [A, B]`). The write is
   F5-drift-guarded.
2. **Surface (delete/binary)** — these can't sit as inline markers, so **every** round
   (auto *and* manual) **defers** them (`DEFER_CONFLICT`), holding the cursor so they
   re-present next round. There is **no blocking modal** anymore (UX audit §3, "full
   inline"): each deferral is recorded as a rich `ConflictDescriptor` on the observable
   state (`SyncState.conflicts`) and rendered as a card in the **Conflicts panel**, where
   the user picks a side. The pick is stored as a `SyncState.pendingDecisions[fileId]` and
   **consumed by the next round's** `decideDeleteConflict`/`decideBinaryConflict` (which
   return it instead of deferring), so the applicator applies it and mints the merge node.
   Exception: a standing non-`ask` delete-conflict *policy* still applies unattended.
3. **The two derived facts:**
   - **Text conflicts** = `listTwoHeadedConflicts(registry entries)` — the files with two
     `conflictParents` heads.
   - **Delete/binary conflicts** = `SyncState.conflicts` (the descriptors the round's
     decide* handlers accumulated), **replaced wholesale each round** — the held cursor
     re-surfaces them, so there is nothing to clear. `pendingDecisions` self-heals to this
     live set (a resolved conflict's decision is pruned in `setRound`).
   - `main.conflictCount()` = `twoHeadedConflicts().length + deferredConflictCount()`,
     where `deferredConflictCount() = SyncState.conflicts.length`.
4. **Resolution.** *Text:* a two-headed file's **next save** — hand-edited markers or a click
   through the Conflicts panel — removes the markers; `op-logger.flushModify` emits a
   `Ops.merge` node with `parents: [A, B]`, collapsing to one head (a save still containing
   markers → a gentle non-blocking notice, no merge yet). *Delete/binary:* the panel records
   a `pendingDecision` and triggers a sync; that round's applicator applies the choice and
   mints the two-parent merge node. Either way the resolution is a merge node peers adopt.
5. **Replicate.** The merge node is pushed like an edit; a peer still holding either head
   **fast-forwards** onto it (it descends from both) — no re-conflict, no `supersedes`.
   `resolveContentConflict` has a two-headed guard so it never nests markers over markers.

The trap to remember: **a conflict can be resolved without any conflict handler running
again** (a peer FF-adopts the merge node). This is *fine* in v2 precisely because
"conflicts" is derived — there is no handler-invocation-tied state left to leak. If you
add new conflict state, make it a query over the DAG/registry, never a hand-maintained set.

---

## 7. Hard-won lessons & the gotcha catalog

Real bugs found and fixed during the robustness/coverage work. Each is now a regression
test; the *classes* are what to watch for.

- **Edit-timing (S1).** Ops are minted from async vault `modify` events. An edit made
  right before "Sync" may not have fired its event yet, so the round would miss it. Fix:
  the coordinator force-saves editors + runs `captureOfflineChanges` (disk-drift capture)
  *before* every round. **Lesson:** never assume a vault event has fired; reconcile
  against disk.
- **Silent path divergence (H5).** A rename *combined with* an edit in one round put the
  new content at the *old* path (the clean-merge branch used the local path). Fix: target
  the HLC-winning path and have the applicator trash the stale old copy + fix the
  pathIndex. **Lesson:** any `write_local` must account for a concurrent rename; a merge
  action's path is a decision, not a given.
- **False-positive guard (G13).** A `wouldTruncateNonEmpty` guard refused *any* empty
  write over a non-empty file — which permanently blocked a legitimate file-emptying.
  Since `state-merge` already `no_op`s on missing content (F1), the guard could only ever
  false-positive. It was **removed**. **Lesson — for a data-safety tool, a guard that
  produces false positives (silent divergence) is worse than no guard.** Prefer one
  correct guarantor (the merge's F1) over redundant blunt backstops.
- **Phantom op (G11).** Create-then-delete before any sync pruned the create but still
  emitted a delete op referencing an un-uploaded hash. Fix: the pair fully cancels.
  **Lesson:** transient files must leave no trace on the wire.
- **Sequential-edit union/divergence on a stale scalar ancestor (v1 — retired at the
  root).** *Historical, but the canonical example of why v2 exists.* v1's scalar
  `ancestorContentHash` deliberately did NOT advance on push (pushing isn't a peer ack —
  advancing it was a prior data-loss bug). So the pusher's ancestor lagged its own
  content; a sequential peer edit then either **unioned/duplicated** the file
  (empty-ancestor diff3 concatenates both sides — the classic `"3"`+`"4"` → `"3\n4\n"`) or
  **silently kept the older side.** v1 patched this with a per-op `baseContentHash` +
  fast-forward shortcut. **v2 removes the whole class:** the real causal base is `LCA(A,B)`
  over the op-id DAG — a fact, not a maintained guess — so there is no stale scalar to lag.
  **Lesson:** the only witness to an edit's causal base is causal *structure*; store the
  structure, don't approximate it with a scalar.
- **Known-but-missing base → conflict, never union (F1 corollary).** If the DAG names a
  real merge base but its *bytes* are absent (GC'd / never fetched), the merge must
  surface a conflict — an empty-ancestor stand-in would diff3-union both full versions and
  silently duplicate the file. Pinned by `core.test.ts`'s "ancestor recorded but its bytes
  missing → conflict". **Step 8's GC keeps DAG-reachable bases** (`referencedHashes(dag)`)
  precisely so this degradation is rare — but degrading is *safe* (a visible conflict),
  fabricating is not.
- **A parent-only DAG stub is "known but missing" too, not "no base" (F1 corollary,
  real-world incident).** `mergeBase`'s LCA walk only needs a node's `parents` set, so it
  can name a base id the DAG knows only as a *stub* — referenced as someone's parent but
  never itself recorded via `addVersion` (its own op was never pushed/pulled by this
  device — the real trigger was a vaultId switch that left a stale local head whose true
  origin op never reached the new vault's server). `contentHashOf` returns `undefined` for
  a stub, and `resolveThreeWayBase` used to collapse that to `baseHash: null` —
  indistinguishable from "genuinely no common ancestor," which the caller treats as safe
  to empty-ancestor-fallback. That silently unioned both full versions exactly like the
  GC'd-bytes case above, just via a gap the existing guard didn't cover (it only checked
  `baseHash != null`). Fixed by adding `hasKnownAncestor` to `resolveThreeWayBase`'s
  result, set whenever `mergeBase` finds a real id regardless of whether its hash is
  known, and gating the conflict-guard on it instead of on `baseHash`. Pinned by
  `core.test.ts`'s "ancestor is a parent-only stub with no content hash → conflict".
  **Lesson:** "the DAG names a real base" and "we know that base's content hash" are two
  different facts — collapsing them loses exactly the distinction F1 exists to preserve.
- **Identical content ≠ causal convergence (concurrent-same-edit).** Two devices that
  independently edit a file to the *same* bytes (canonically: both empty it) reach
  identical content via **two distinct heads** off a common base. The old `state-merge`
  "same content → `no_op`" shortcut observed the equal hash and stopped — leaving **both
  heads open** in the DAG. A later edit off one head then diverged from the orphaned
  other, and `LCA` rolled back *past* the shared value, resurrecting it as a spurious
  three-way conflict base (`base="1", ours="", theirs="341"` → bogus conflict, even
  though B had emptied and A merely edited). Fix: when the DAG shows the two heads
  genuinely diverged, the same-content branch mints a **`write_merge` node** to unite
  them (deterministic content-addressed id → both devices converge, no storm); when the
  histories are linear it advances the head pointer; identical heads keep the cheap
  `no_op`. Pinned by `concurrent-identical-edit-convergence.test.ts`. **Lesson — with an
  op-id DAG, content equality is *not* head equality; a "nothing changed" shortcut keyed
  on the content hash silently strands a divergence. Converge the heads, not the bytes.**
- **Cold-start phantom delete (listing race).** `captureOfflineChanges` diffs the
  registry against `files.list()` (`app.vault.getFiles()`) and emits a `delete` for any
  tracked file not in the listing. Obsidian does **not** populate `getFiles()` during
  `onload`, so on an unlucky cold start the listing was empty, *every* tracked file looked
  "vanished," and the whole vault was tombstoned + pushed to peers (which then surfaced a
  bogus "file is deleted" conflict). Two-layer fix: `main.ts` defers the first capture to
  `workspace.onLayoutReady`, and `captureOfflineChanges` **skips the delete pass when the
  listing is empty while active entries remain**. **Lesson:** never derive a *destructive*
  op from a single enumeration that a host populates lazily; confirm the source is ready.
- **Concurrent remote heads collapsed by the projection (multi-head).** `reconstructRemoteState`
  keeps one entry per fileId (HLC-max), so when a device pulled ≥2 concurrent heads for a file
  (3+ devices editing it before anyone merged) the merge reconciled against only the HLC-max
  and left the rest as stranded DAG leaves — the puller showed a partial view until a peer that
  already merged re-synced (no data loss; the ops are durable, just unreconciled). Fix: the
  round's `reconcileConcurrentHeads` sweep folds every extra leaf into the local head via the
  ordinary pairwise merge, so the puller converges itself. **Lesson:** a per-fileId "one remote
  head" projection is a proxy that lies under 3-way concurrency; when the DAG shows extra open
  leaves, reconcile them — don't trust the collapse. Full analysis: `docs/multi-head-reconciliation.md`.
- **A create over a tombstone must resurrect the entry.** `registerFile` returned the existing
  id for a tracked path but did **not** reset a tombstoned entry, so re-creating a deleted file
  left it `deleted: true` with a stale `contentHash` while its head advanced —
  `buildLocalState` then mis-projected the just-created file as deleted. Fix: on a create over a
  tombstone, resurrect in place (`deleted=false`, fresh hash). The create op stays a fresh DAG
  root, so a peer that deleted the file still gets a delete/create conflict (safe), never a
  silent un-delete. Pinned by `recreate-after-delete.test.ts`. **Lesson:** reusing an id across
  a delete→re-create must reset the entry's *state*, not just its head.
- **O(N²) registry writes made a large first sync never converge.** Every registry
  mutation rewrites the *whole* `file-registry.json` (`flush()` serializes all entries).
  The applicator saved per-mutation, so a first sync — which touches every file — did N
  full-registry writes: minutes on a large mobile vault. Long enough that the user
  force-closed mid-apply, and because the **cursor is saved only at round end**, it never
  advanced — so the whole vault re-pulled and re-applied on *every* restart (the "applying
  8390 changes forever" report). Fix: `applyActions` now brackets the entire apply in
  `registry.suspendSaves()` → a single `flush()` in a guaranteed `finally` (mirrors the
  capture pass), turning O(N²) into O(N) — apply dropped from minutes to ~700ms. Pinned by
  `first-sync-registry-batching.test.ts` (asserts O(1) registry writes; fails at N without
  the batching). **Lesson — any bulk pass over the vault (apply, capture, reconcile) must
  batch registry/DAG persistence; a per-item `save()` that rewrites the whole file is a
  hidden O(N²) that only bites at scale, exactly where it can't be undone by hand.**
- **A single self-syncing device emits `send_remote` for every file, every round.**
  `reconstructRemoteState` excludes our own re-pulled ops, so with no peer the remote
  projection is empty and the merge classifies each local file as `send_remote` (transport-
  only, a local no-op). This is correct, but two traps follow: (1) the merge emits **one
  action per file** even in the converged case, so any "applying N changes" UX must count
  only `affectsLocalVault(action)` (the exhaustive classifier in `types.ts`) or an unchanged
  vault reports the whole vault; (2) `updateSyncedPaths` runs `setSyncedPath` per file on the
  first sync — the O(N²) trap above. **Lesson — the merge produces O(vault) actions, most of
  them inert; never treat `actions.length` as "work done", and never let a per-action side
  effect persist per-action.**
- **`buildLocalState` staging was O(vault) every round — now scoped (A2, fixed).** The
  pre-A2 snapshot stat-gated the re-hash (R1) but still *staged the bytes of every file*
  (plus each head's DAG-reachable bases), so a converged round read the whole vault —
  ~52s at 8390 files, ~92% of the round. It ran *before* the pull, so it couldn't know
  which files the merge needed and staged them all defensively. Fixed by splitting the
  host into `buildLocalIdentity` (cheap, before-pull: entries + the R1 hash correction,
  **no** byte staging) and `stageContent(state, hashes)`, and moving staging into the
  round *after* the pull, scoped to the files the merge reconciles + the pending ops'
  own content (for the push). Staging drops to O(touched this round + their bases) — zero
  on a converged round. The enabling move was dropping the dead `send_remote.content` so a
  local-only file classifies from its entry alone (no bytes read). A genuinely-missing
  base still degrades to a conflict (F1), never a union. See
  `docs/build-local-state-perf-spec.md` and `scoped-content-staging.test.ts`.

- **Folders are not synced entities, and one throwing action used to wedge the vault
  (real-world incident).** A vault reorganized on device A — many files moved into
  newly-created folders — replicated to B as `move_local` actions into directories B
  had never created. `ObsidianVaultFiles.move` called `fileManager.renameFile`
  *without* the `ensureDir` its sibling `write` has always done, and Obsidian rejects
  a rename into a missing parent ("The parent object of the destination does not
  exist"). Whether it bit at all was **apply-order luck**: any `write_local` into the
  same folder ran `ensureDir` first and made every later move there succeed — which
  is why earlier reorganizations synced fine and a moves-and-deletes-only round did
  not. Two distinct fixes, because there were two distinct bugs:
  1. *The adapter.* `move` now ensures the destination's parent, mirroring `write`;
     the `VaultFiles` port doc states the requirement. **Folders exist only as
     parents of files — the op log never carries a "create folder", so any path a
     remote op names may be a directory this device has never seen.**
  2. *The applicator.* The throw escaped the action loop, so every later action was
     skipped, `updateSyncedPaths` / the resolution re-emit / the F5 recapture never
     ran, and the vault was left half-applied — while the (correctly) held cursor made
     the next round replay the identical list and fail at the identical spot, forever.
     The loop now isolates a throwing action: defer that fileId (cursor held, re-pulls
     next round) and carry on, reporting it in the round's `applyFailures` so a
     *permanent* failure surfaces as an error rather than an ever-retrying deferral.
     `MAX_ACTION_FAILURES` still rethrows for a systemic fault (disk full, permissions
     revoked), where every action fails and a "completed" round would be misleading.
     Pinned by `apply-action-failure-isolation.test.ts`.
  **Lesson — the blast radius of an unexpected error is a design decision, not an
  accident.** Deferral machinery already existed for exactly this shape (F5 drift):
  routing an unforeseen failure into it costs one file, while letting it propagate
  costs the whole round *and* re-costs it every round after. And the general trap:
  when one method of a port guarantees a precondition (`write` → parent dir), check
  every sibling that needs the same one — the fakes can't catch adapter asymmetries,
  so that check is a review-time habit (`__tests__/helpers/fakes/README.md`).
- **Live watcher during a sync round vs. the startup-scan dirty-tracker — same surface, different mechanism.** A proposal to detach the `VaultWatcher` during a sync round and reconcile with a post-round rescan (mirroring the startup-capture fix) was considered and rejected. F5's drift guard (`driftedSinceSnapshot`, `sync-applicator.ts:410`) is a direct disk-hash check performed at apply time — it doesn't depend on the watcher being attached, so detaching it buys no extra safety. And propagation to a peer always waits for the *next* round regardless of when the edit is captured, since this round's push list is already snapshotted at `buildLocalIdentity` (step 1) before the edit happens — so detaching buys no extra speed either. It would only reintroduce an O(vault) rescan into the steady-state round, exactly what A2/A3 spent effort removing. The startup offline-changes scan is different in kind: it runs *before* `startListening()` ever attaches a watcher, so an edit landing in that window has **nothing** observing it at all — not a slower path to capture, an absent one. That's the real gap `captureOfflineChangesAndReconcile`'s disposable dirty-tracker closes (`docs/startup-capture-live-edits-spec.md`). **Lesson:** before generalizing a fix to a similar-looking window, check whether the two cases share the actual failure mode (nothing is observing) or just the surface shape (an edit lands during a slow scan) — same shape can still mean a different mechanism and a different verdict.

Meta-lesson across all of them: **the dangerous failures are silent** — an edit that
doesn't propagate, content at the wrong path, a file that won't empty, a base that unions.
Loud failures (an error toast, a visible conflict) are fine; silent divergence is the
enemy. When adding a guard or a shortcut, ask "what does this *silently* do in the
concurrent case?"

---

## 8. Testing approach

The doctrine (see the `vault-ports-and-testing` memory): **tests drive the real
production stack over in-memory fakes — never a reimplementation of the merge/apply
logic.**

- **`TestDevice`** (`__tests__/helpers/test-device.ts`) wires the genuine
  registry/content-store/oplog/applicator/host/**version-dag** over `FakeVaultFiles`/
  `FakeMetadataStore`/`FakeVaultWatcher` + a settable wall clock. User-action helpers
  (`seedFile`, `editFile`, `renameFile`, `renameAndEdit`, `deleteFile`,
  `seedExistingFile`) drive the real `OperationLogger` path — tests never hand-build ops
  or ids.
- **`TestDevice.reload()`** builds a fresh stack over the *same* fakes (persisted state
  survives, in-memory state drops) — models a plugin restart / crash-recovery. Use it for
  durability tests.
- **Two-device convergence** is the default shape: A and B (and often C) share a
  `FakeSyncServer`; assert the end state *and* the merge **decision** (`device.applied`),
  so the test proves the mechanism, not just the outcome. The DAG makes new shapes
  assertable: `merge-node-convergence` / `resolution-convergence` pin the two-parent chain;
  `version-dag.test.ts` pins LCA/ancestor/`MULTIPLE_BASES` directly.
- **The contract suite** (`__tests__/helpers/contract-suite.ts`) runs the *same*
  behavioral scenarios against both the in-memory fake and the real Go server
  (`npm run test:integration`). This equivalence is what stops the fake from drifting from
  the server it stands in for. Assert only *observable* behavior, never a fake's internals.
- **The coordinator** is unit-tested directly (`sync-coordinator.test.ts`) with fake
  ports/spies — capture ordering, error path, and the derived `deferredConflictCount` /
  reason-tagging live there. `TestDevice` deliberately does *not* route through the
  coordinator/`SyncStateStore`; assert coordinator-level behavior there, and assert the
  *round summary* (returned by `runSync`) in `TestDevice` tests to bridge the two.
- **Coverage** (`npm run test:coverage`) is a **blind-spot finder, not a target.** It's
  scoped to the obsidian-free modules; don't chase 100% and don't gate on a percentage.
- **The discovery-test pattern:** when a scenario surfaces a genuine bug, write the test
  asserting the *correct* behavior, mark it `test.skip`/`test.todo` with a root-cause
  note, and report it — never write a passing assertion around wrong behavior. Several of
  §7's bugs were found exactly this way.

---

## 9. How to change the sync engine safely — checklist

1. **Keep obsidian-free modules obsidian-free.** No `obsidian` import in `core/`,
   `merge/`, or `network/*` except the `obsidian-*` adapters. If you need an Obsidian
   capability in the engine, add a port + a thin adapter.
2. **Put logic where it's testable.** New orchestration → `SyncCoordinator`. New merge
   behavior → `state-merge` (keep it pure & commutative). New causal reasoning → derive it
   from the `VersionDag`, never a new scalar. New persisted state → a store modeled on
   `cursor-store.ts` with defensive `load()`.
3. **Think in the DAG.** A "base" is `LCA(head, peerHead)`; a "resolution" is a two-parent
   merge node peers fast-forward onto; "in conflict" is "two heads". Don't reintroduce a
   tracked scalar ancestor or a `supersedes`-style side-table.
4. **Add a scenario test through `TestDevice`** (two-device where convergence matters),
   asserting both the decision and the end state. Add a durability angle with `reload()`
   if the change touches persistence or the round.
5. **Run `npm run build` && `npx vitest run`.** Both must be green. Glance at
   `npm run test:coverage` for new blind spots.
6. **Protect the regression-critical tests** when touching the merge/applicator/cursor:
   `core.test.ts` (`mergeVaultStates` cases), `contract-suite`, `delete-rename-conflict`,
   `create-create-collision`, `resolution-convergence`, `merge-node-convergence`,
   `concurrent-conflict-dataloss`, `edit-during-sync-dataloss` (F5),
   `round-interruption-durability`. If your change diverges from one of these, that's a
   design tension to surface, not force green.
7. **Ask the silent-divergence question** (§7): in the concurrent case, does this ever
   drop, overwrite, or strand a change without a trace? If yes, defer + surface instead.
8. **Never commit build artifacts** (`main.js`, `coverage/`, `node_modules/`) — they're
   gitignored. Commits omit the Co-Authored-By trailer (project convention).

---

## 10. Where to look for more

- `docs/sync-v2-decisions.md` — **why** the engine is a commit DAG keyed by op-id (the
  identity decision, the CRDT rejection, the determinism split, the conflict UX rationale).
- `docs/multi-head-reconciliation.md` — how a file with **more than two** concurrent heads
  converges (`reconcileConcurrentHeads`): the push-before-apply lag that lets concurrent raw
  heads coexist, the sweep that folds them, and the self-healing 3+-head fold-tree footnote.
- `docs/sync-v2-migration-spec.md` — the ordered, committed migration from v1 → v2
  (point-in-time, but the definitive record of *how each piece landed*).
- `docs/sync-test-coverage-spec.md` — the testability refactor + two-device scenario
  matrix (what's covered and why).
- `SYNC_ROBUSTNESS_AUDIT.md` + `docs/sync-robustness-remediation-plan.md` — the S1–S5
  robustness/UX work.
- `OP_FORMAT_AUDIT.md` + `docs/ops-sync-data-safety-spec.md` — op wire format + the
  F-series data-safety invariants in depth.
- `docs/server-api-spec.md` — the client↔server wire contract (the five endpoints).
- `docs/pre-release-ux-audit-spec.md` — pre-release UX audit + remediation plan (onboarding,
  conflict UX, terminology, settings IA, mobile). Point-in-time; presentation only.
- `docs/mobile-perf-baseline-spec.md` — the mobile performance-baseline plan: benchmarks that
  establish where time/RAM go **before** any optimization. Names the hot-path hypotheses.
- `__tests__/helpers/fakes/README.md` — the semantic assumptions the real Obsidian
  adapters must honor.

**Known manual-smoke surface** (not covered by automated tests, verify by hand before a
release): the `obsidian-*` adapters, `src/ui/` views/modals and rendering, `main.ts`
wiring, the editor force-save, the settings **Test connection** preflight
(`plugin.testConnection` → `ServerSyncClient.preflight`) and the typed-error toasts
(`KeyMismatchError`/`AuthError`/`NetworkError`/`TimeoutError` wording in a real vault),
and end-to-end behavior in a real vault. The
`npm run test:integration` suite covers the real server wire but still runs the client
over fakes for the vault side.
