# Operation Format Audit — Findings & Hardening Backlog

Status: **findings A–E, G remediated** (2026-07-20; see per-finding markers and
§Suggested sequencing). F remains open (a decision); H is deferred to v2. Performed 2026-07-20 against `HEAD` of
`master` (after the F1–F7 data-safety remediation landed). Scope: the
**`Operation` interface /
op format** — the core wire+at-rest data structure that represents every sync
mutation. Companion to `docs/ops-sync-data-safety-spec.md` (which covered the
merge/apply path); this document covers the *shape of the op itself*.

The sync target is an **untrusted** server that stores only ciphertext + routing
metadata and never merges. Safety of user data is the overriding constraint.

---

## Verdict

The **core is architecturally sound**. The op is a state-carrying
LWW-register-per-file, totally ordered by a single HLC triple, with content held
out-of-band as content-addressed blobs. That gives the property that matters
most: **replay-order-independence** — a fresh device folding the whole log by
"max-HLC-per-`fileId`" converges to the same state regardless of the order the
server returns ops. The op-log is pure transport; the CRDT is the projection.

These properties are correct and must not be disturbed:

- **LWW-register-per-file over HLC** → convergent, replay-order-independent
  (`reconstructRemoteState`, `server-sync.ts:381-414`).
- **Content-addressed blobs off the op** → small ops, cross-device dedup,
  re-hash verification on fetch (`server-sync.ts:249-251`).
- **Idempotent append** via `clientOpId` (`op.id`).
- **`fileId` identity decoupled from `path`** → rename-safe.

The footguns are all at the **edges of the `Operation` interface** — mostly
latent, a few worth fixing before the format ossifies in a permanent
append-only log.

---

## The format under audit

**Current shape** (`src/types.ts`), after findings A–D:

```ts
export const OP_FORMAT_VERSION = 1;
export type OperationType = 'create' | 'update' | 'delete' | 'move';

export interface Operation {
  v: number;               // op-format version (A); absent on legacy ops ⇒ 1
  id: string;              // = hlcToString(hlcTimestamp) — deterministic, collision-free (C)
  hlcTimestamp: HLC;       // when + who — its deviceId is the authoring device (B)
  fileId: string;          // UUID of the file
  type: OperationType;
  path: string;            // file path at time of operation
  contentHash: string;     // hash of file content after operation
  supersedes?: string[];   // resolution ops only — the two sides settled
}
```

**As originally audited** (pre-remediation), for reference — the fields A/B/C/D
changed: `id` was a `Date.now()`+`Math.random()` token (C), a redundant top-level
`deviceId` duplicated `hlcTimestamp.deviceId` (B), there was no `v` (A), and a
write-only `previousPath?: string` rode on every `move` (D).

Every op is minted through the **`Ops` factory catalog** (`src/core/operations.ts`)
— one documented pure factory per kind (`create`/`update`/`delete`/`move`/
`resolveUpdate`/`resolveDelete`), which stamps the shared fields (`v`, HLC-derived
`id`) in one place. `OperationLogger` (`src/core/operation-logger.ts`) owns *when*
an op is emitted and calls `Ops.<kind>(...)`. Ops are serialized to
`.vault-sync/oplog.json` (JSON) and to the server as `encryptOp` → AES-256-GCM →
base64 inside `OpRecord.ciphertext` (`src/network/encryption.ts:114-123`,
`src/network/server-sync.ts:23-51`). See §Structural outcome.

---

## Findings, ranked

### A — No op-format version field `[Medium]` · ✅ DONE (c323981)

**Location:** `src/types.ts:32` (`Operation`).

`/v1/` is in the URL and `:v1` in the crypto HKDF labels, but the **op JSON
itself** — the thing that lives forever, encrypted, in an append-only log — has
no `v`. The moment the *meaning* of a field changes or a required field is added,
the log contains a mix of shapes with no discriminator, and the ciphertext
can't be re-read to migrate server-side (it's E2E). Adding *optional* fields is
safe; anything else is not.

**Recommended:** add `v: 1` to `Operation` now, while the log is young. Cheapest
insurance here and the hardest thing to retrofit. Prerequisite for evolving the
format toward checkpoints (finding H).

**Resolution (shipped, `c323981`):** added `OP_FORMAT_VERSION = 1` and a required
`v` on `Operation`. Ops predating versioning carry no `v` and are defined as
format 1. To add `v` to every op without editing nine construction sites, a
`buildOp` helper was introduced — later generalized into the `Ops` catalog
(§Structural outcome). No consumer branches on `v` yet; it's the discriminator a
future non-additive change will dispatch on.

---

### B — `deviceId` duplicates `hlcTimestamp.deviceId` `[Low–Medium]` · ✅ DONE (eb7ce0f)

**Location:** `src/types.ts:34` vs `src/types.ts:8`; consumers at
`server-sync.ts:386` (filter) and `hlc.ts:88-94` (`hlcCompare`, tie-break).

Two sources of truth for authorship, and consumers split across them:
`reconstructRemoteState` **filters own ops** on `op.deviceId`, while
ordering/tie-break reads `hlcTimestamp.deviceId`. Today they are always equal
(every emit site sets both from the same device), so it's latent — but if they
ever diverge under a refactor, the result is "self-op not filtered" or a wrong
tie-break, both silent.

**Recommended:** drop the top-level `deviceId` and derive from
`hlcTimestamp.deviceId`, **or** keep it and assert equality at decrypt time.

**Resolution (shipped, `eb7ce0f`):** removed the top-level field. Authorship is
read from `hlcTimestamp.deviceId` (the canonical author); the sole reader, the
own-op filter in `reconstructRemoteState`, now keys on it. `OpRecord.deviceId`
(the server-set, informational wire field) is untouched.

---

### C — `id` is `Date.now()` + `Math.random()` `[Medium]` · ✅ DONE (454af00)

**Location:** `src/core/operation-logger.ts:388-390` (`opId()`); `op.id` is
reused as the server idempotency key (`server-sync.ts:275`).

The idempotency key is minted from wall-clock + randomness while the **HLC
already provides a unique, monotonic, deterministic per-device identifier**.
Deriving `id` from `hlcToString(hlc)` would be collision-free by construction
(the HLC counter guarantees per-ms uniqueness), replay-stable, and testable —
instead of relying on ~44 bits of `Math.random()` and coarse `Date.now()`. Two
independent uniqueness mechanisms where one would do, and the weaker one is
load-bearing for dedup.

**Recommended:** derive `id` from the HLC (e.g. `hlcToString(op.hlcTimestamp)`,
which already embeds deviceId).

**Resolution (shipped, `454af00`):** `id = hlcToString(fields.hlcTimestamp)`.
Every op's HLC comes from a fresh `hlc.now()` (the counter increments on every
call), so the id is unique per device by construction and globally unique via the
embedded deviceId. `opId()` and the now-dead `deviceId` constructor param were
removed. Nothing parses `op.id` (it is only the opaque `clientOpId` dedup key), so
the change is transparent on the wire.

---

### D — `previousPath` is written but never read `[Low, clarity]` · ✅ DONE (ea17cc6)

**Location:** set at `operation-logger.ts:288`; **read nowhere**
(grep across `src/` and `__tests__/`).

A `move` op projects identically to an `update` (same `fileId`, new `path`), so
`previousPath` advertises a rename-detection capability the merge does not use.
A maintainer will assume moves are handled specially when they aren't. Note that
rename-vs-delete disambiguation *is* actually done via `FileEntry.ancestorPath`,
not this field.

**Recommended:** either wire `previousPath` into the merge as a real signal, or
delete the field and fold `move` into `update`. Do not leave it as misleading
dead weight.

**Resolution (shipped, `ea17cc6`):** deleted the field. `move_local` is
reconstructed from the projected entry paths (`le.path → re.path`,
`state-merge.ts`), and rename-vs-delete is disambiguated by `FileEntry.ancestorPath`
— those are the wired signals. `type: 'move'` is kept (informational: path
changed, content didn't).

**Root cause (why it was never obvious):** the field was **write-only since the
first commit** — the P2P-era code never read it either. It reflects an
operation/delta mental model (a move records `from → to`), but the merge has
always been state/LWW-register-style (project ops to a per-`fileId` entry;
identity is the UUID, path is an attribute), which never needs the delta. A
write-only field isn't forced out by anything — it typechecks, serializes, and
tests pass — so it survived until a consumer-trace audit.

---

### E — Concurrent **binary** edits silently drop a side `[Medium, data-safety]` · ✅ DONE (2ed7a9d)

**Location:** `src/merge/state-merge.ts:230-237` (binary sniff → LWW).

The op carries no content-kind; the merge sniffs bytes and, for binary,
resolves by "higher HLC wins" → `no_op`/`write_local`. For notes that's fine,
but the plugin syncs **files** too (images, PDFs, attachments). Two devices
editing the same binary concurrently → one version silently overwritten,
recoverable only from the oplog, **never surfaced as a conflict** (unlike the
text path). This partly contradicts invariant #2 in
`ops-sync-data-safety-spec.md` ("no silent overwrite of divergent content"). The
sniff heuristic can also misclassify (minified JSON, UTF-16 notes).

**Recommended:** surface a `delete_conflict`-style side-by-side for binary
divergence instead of silent LWW. (Merge-layer change, not a format change —
warrants its own pass.)

**Resolution (shipped, `2ed7a9d`):** a new `binary_conflict` `MergeAction`.
- **No spurious prompts:** "changed since ancestor" is a cheap **hash** compare
  (binary needs no ancestor *bytes*, unlike the text 3-way merge). If only one
  side changed, that edit is adopted cleanly — no modal.
- **Genuine divergence** (both changed, or no common ancestor) → `binary_conflict`.
- **Convergence reuses `supersedes`:** the applicator re-emits the user's choice
  as an `update` op tagged `supersedes = [localHash, remoteHash]` — the same
  machinery text/delete conflicts use — so the `supersedes` shortcut in
  `resolveContentConflict` (which runs *before* the binary branch) lets a peer
  holding either side adopt the decision without re-prompting.
- **`BinaryConflictModal`** presents the two versions by filename + metadata
  (source device, size, modified time); dismiss keeps the local file.

**Known limitation (inherited, not new):** if *two* devices independently resolve
the **same** conflict differently before exchanging, they can diverge — the
convergent path is "one resolves → propagates → the other adopts via
`supersedes`." This is shared with the text and delete conflict paths; binary was
made consistent with them, not worse. (Candidate for a future dedicated fix
across all three conflict kinds.)

---

### F — No cross-op log integrity against the untrusted server `[Medium, threat-model dependent]`

**Location:** op format (no chaining field); `OpRecord` (`server-sync.ts:26-32`).

Each `OpRecord` has per-record AES-GCM integrity, but nothing chains ops. A
malicious or buggy server can **omit, truncate, or replay** ops and the client
can't detect it — `seq` is server-assigned and untrusted; HLC tolerates
reordering but says nothing about completeness. The threat model already states
"untrusted server," so if completeness is in scope the format has no hook for it
(no `prevHash` / high-water attestation).

**Recommended:** decide explicitly. Either add a chaining/attestation mechanism,
or document in the spec that log-completeness is out of scope (availability, not
integrity). Right now it's an unstated gap.

---

### G — `contentHash` overloads the empty string as a sentinel `[Low]` · ✅ DONE (bc17a87)

**Location:** `operation-logger.ts:102` (`entry.contentHash === '' ? 'create'`),
`operation-logger.ts:119` (delete copies `entry.contentHash`).

`''` means "never captured", but a `delete` op copies `entry.contentHash`, which
can be `''`. A genuinely empty file, by contrast, has a real SHA-256. So
`contentHash` carries three meanings (real hash / empty-file hash / never
captured), and `supersedes` matching on `''` could false-match. Harmless today,
latent trap.

**Recommended:** never emit an op with `contentHash === ''`, or model "no
content" explicitly (e.g. `contentHash: null`).

**Resolution (shipped, `bc17a87`):** guarded the three sites that reuse an
existing entry's hash (create/update always hash fresh, so were never affected).
The sentinel originates only in `reconcileWithVault` (reached via the "Rebuild
sync metadata" settings action).
- **Deletes** (`handleDelete`, `captureOfflineChanges`): a never-captured file was
  never synced, so its deletion is a local-only tombstone — skip the op.
- **Move** (`handleRename`): capture the file's real content at its new path via
  `flushModify` (a proper content op) instead of a phantom `''` move.
The `string | null` remodel was rejected — too much ripple through `FileEntry`,
`Operation`, and every reader for a low-severity trap.

**Empty file ≠ sentinel** (locked by test): a genuinely empty file hashes to the
SHA-256 of zero bytes, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
— a real content address. The guards key on the literal `=== ''`, never on
content length, so an empty file is captured and synced as ordinary content.
`''` means only "reconcile minted a UUID but the bytes aren't hashed yet",
independent of file size.

---

### H — Unbounded log, from-zero replay for new devices `[Known / deferred]`

**Location:** design (`docs/implementation-plan.md:431`, `server-api-spec.md §6`).

No compaction in v1 — a new device replays *every op ever authored*. Replay cost
is O(all edits ever), not O(current vault). This is **already an acknowledged
deferral** (checkpoints → v2). Flagged here only to keep the scaling cliff
visible. Finding A (`v` field) is a prerequisite for evolving toward checkpoints
cleanly.

**Recommended:** no action now; revisit with the v2 checkpoint work.

---

### Nits

- `create` vs `update` are indistinguishable to the projection (informational
  only) — fine, leave as-is.
- JSON serialization is non-canonical (`JSON.stringify`, field order depends on
  construction) — only bites if ops are ever content-addressed / hashed for
  identity.
- `supersedes` is a positional, untyped hash pair — consider a named shape if it
  grows.

---

## Structural outcome — the `Ops` catalog

Beyond the individual findings, op construction was consolidated (`a72e3f2`).
Before: the op *vocabulary* (how many kinds, the field-level rules each carries)
was implicit, spread across nine construction sites and inferable only by reading
`OperationLogger`'s handlers. After: `src/core/operations.ts` exposes a pure,
obsidian-free `Ops` catalog — one documented factory per kind
(`create`/`update`/`delete`/`move`/`resolveUpdate`/`resolveDelete`). A private
`stamp()` owns the shared fields (`v`, HLC-derived `id`); the `buildOp` helper
introduced in A was retired into it.

Split of concerns: **`Ops` owns the shape** (the nouns); **`OperationLogger` owns
the emission** (the verbs — the stateful registry/content-store/HLC
orchestration). Deliberately lightweight: pure factories, **no** stateful builder
object (that would duplicate `OperationLogger`'s role) and **no** discriminated
union yet (reach for it only if "which fields are valid for which type" starts
tripping people up — a nit below). `__tests__/operations.test.ts` is an executable
catalog asserting each factory's invariants.

---

## Suggested sequencing

The four format-level fixes that harden the interface before it locks in are
**done** (one commit each, full suite green at each step):

1. ✅ **A** — add `v` version field (`c323981`); introduced a `buildOp` helper,
   later generalized into the `Ops` catalog (§Structural outcome, `a72e3f2`).
2. ✅ **B** — drop the duplicate top-level `deviceId`; authorship reads from the HLC (`eb7ce0f`).
3. ✅ **C** — derive `id` from the HLC; removed `opId()` and the dead `deviceId` ctor param (`454af00`).
4. ✅ **D** — delete the write-only `previousPath` (`ea17cc6`).

5. ✅ **E** — concurrent binary edits surface a `binary_conflict` (modal, filename
   presentation) instead of silent LWW; one-sided edits still adopt cleanly (`2ed7a9d`).

6. ✅ **G** — the `''` contentHash sentinel can no longer escape into a delete/move
   op (never-synced placeholder → local-only tombstone / real-content capture) (`bc17a87`).

Remaining, as separate passes:

7. **F** — decide + document log-completeness stance (spec).
8. **H** — deferred to v2 checkpoints.
