# Vault Sync — Implementation Plan (phase by phase)

**Status:** Draft plan · **Date:** 2026-07-18

The plan to take the plugin from its current state (working P2P, mid-pivot) to a shipped
**client↔server, E2E-encrypted** sync. This expands the README's `M5–M7` roadmap into ordered,
scoped phases. The server contract is fixed in [`server-api-spec.md`](server-api-spec.md); the
architecture rationale is in the [README](../README.md#the-pivot-p2p--e2e-encrypted-server).

**Legend:** 🟢 low risk / mostly mechanical · 🟡 moderate · 🔴 design-sensitive.
"Client-only" phases need no server to land and can be tested against a fake.

---

## Dependency overview

```
P0 Foundations ─┬─► P1 Correctness ─────────────┐
                └─► P2 Crypto envelope ─► P3 Transport client ─┬─► P4 UI/wiring ─► P5 Retire P2P
                                                               │
   P6 Server service (parallel, against the spec) ────────────┘        P7 Integration + release
```

P0–P5 are **client-side** and testable without a live server (use a local fake implementing the
spec). P6 is the separate server service and can be built in parallel once P2 fixes the envelope.
P7 needs both.

---

## Phase 0 — Foundations & cleanup  🟢 (client-only)

De-risk everything else first. No behavior change.

- Add a **test runner** so the existing suite actually runs. *Recommendation: Vitest* (native
  ESM, pairs with the esbuild/`"type":"module"` setup). Add `"test": "vitest run"` +
  `"test:watch"`. Migrate the Jest globals in `__tests__/core.test.ts` (`jest.spyOn` →
  `vi.spyOn`, `jest.restoreAllMocks` → `vi.restoreAllMocks`) or enable a compat shim.
- Add a **`test` step to CI** (`.github/workflows/`) alongside lint.
- Delete orphaned **`src/settings.ts`** (sample-plugin leftover, imported nowhere).
- Fix **`package.json` `name`** (`obsidian-sample-plugin` → the real id).
- Sweep minor dead code: unused `MarkdownRenderer` import (`conflict-modal.ts`), unused
  locals/types in `mergeFromDiffs` (`diff3.ts`).

**Exit:** `npm test` runs green in CI; repo free of sample-plugin cruft.

**Status (2026-07-18): DONE.** Vitest added (`npm test` → `vitest run`); test file migrated off
Jest globals; `test` step added to CI; orphaned `src/settings.ts` removed; `package.json`
name/description/keywords fixed; dead code swept (`MarkdownRenderer` import, unused
`diff3.ts` locals/types); `@types/node` bumped 16 → 20 to satisfy Vitest.

- Tests: **21 pass, 2 skipped.** The 2 skips are *real pre-existing merge bugs* the runner
  exposed — see Phase 1.
- **Discovered:** `npm run build` and `npm run lint` were **already failing on HEAD**
  (39 TS errors — mostly `noUncheckedIndexedAccess` "possibly undefined" in `diff3.ts`; ~180
  lint problems). These predate P0 and are tracked as **Phase 0.5**.

---

## Phase 0.5 — Make CI actually green  🟡 (client-only)

Build and lint were red before P0 (see above); CI can't pass until they're fixed. Deferred by
decision on 2026-07-18 to a dedicated phase before P1.

- **Build (39 TS errors)** — almost all from `noUncheckedIndexedAccess` (30 in `diff3.ts`, rest
  in `encryption.ts`, `main.ts`, `hlc.ts`, `content-store.ts`). Decision needed: add targeted
  guards (keep strict typing) vs. relax the flag.
- **Lint (~180)** — ignore `test-vault/` (a fixture + built artifact shouldn't be scanned); fix
  the legit ones (`no-floating-promises`, `no-unused-vars`, `no-explicit-any`); decide on the
  Obsidian UI-guideline rules (`sentence-case`, manual headings, inline styles) — fix or scope
  to a UI pass.

**Exit:** `npm run build`, `npm run lint`, and `npm test` all green in CI.

**Status (2026-07-19): DONE (with lint scoped by decision).**
- **Build — green.** All 37 TS errors fixed with targeted guards; `noUncheckedIndexedAccess`
  kept on (decision: keep strict typing). Mostly `!` assertions at provably-safe index sites in
  `diff3.ts` (LIS/Myers/patience internals), plus `hlc.ts`, `content-store.ts`, `encryption.ts`;
  `main.ts` `WaitingForConnectionModal` retyped `App` instead of a `Parameters<...>` hack.
- **Tests — green**, still 21 pass / 2 skip. `__tests__/**` added to `tsconfig` `include` so the
  test file is typechecked and eslint can parse it (was a hard parsing error before); its 11 new
  strict-index errors guarded.
- **Lint — survivors clean, churn files left dirty by decision** (2026-07-19: "don't suppress,
  just leave what gets rewritten/deleted"). Fixed the real rules only in code that survives:
  `operation-logger` (unused import, `JSON.parse` cast, floating promises), `file-registry`
  (`JSON.parse` cast), `state-merge` (unused import), `encryption` (redundant assertions),
  `sync-applicator` (`as any`→`instanceof TFile` narrowing), test (unused import). **142 errors
  remain, all in rewrite/delete-bound files:** `main`/`settings-tab`/`pairing-modal` (→ P4),
  `diff3`/`conflict-modal` (→ P1), `sync-server` (→ P5), `types.ts` `.obsidian` hardcoded-config
  (needs runtime `Vault.configDir`, defer to P4 settings). No `eslint-disable`/ignore added.
- **CI:** `lint` step set `continue-on-error: true` (advisory) so build+test gate the pipeline
  while churn lint remains; **flip back to blocking as each phase cleans its files.**

---

## Phase 1 — Client-side correctness  🟡 (client-only)

Fix merge bugs the server model inherits unchanged. Independent of transport — do early.

- **Deletion propagation.** In `state-merge.ts`, add the ancestor check so a *clean* one-sided
  delete emits `delete_local` / `delete_remote` (currently declared in `types.ts` but never
  produced) instead of always `delete_conflict`. Wire `deleteLocalFile()` in the applicator
  (currently unreachable). Add tests for delete-vs-unchanged and delete-vs-edit.
- **Real `ask` delete-conflict modal** in `main.ts` (today it shows a Notice and auto-restores).
- **Rework `mergeFromDiffs` alignment in `diff3.ts`** — the P0 test runner exposed two real bugs
  (currently `test.skip` in `__tests__/core.test.ts`, un-skip when fixed):
  1. Two *differing inserts at the same anchor* (both sides append new lines, ancestor unchanged
     there) are flagged as a conflict instead of **unioned**. Must stay distinct from a genuine
     both-modified-the-same-line conflict (the "overlapping edits produce a conflict" test).
  2. A one-sided line modification (delete+insert) vs. the other side *keeping* that line is
     mis-aligned into a false delete-vs-keep conflict — `expandDiff` associates the inserted line
     with the post-deletion anchor index. Surfaces as the failing CRLF test.

**Exit:** deletions converge across devices; delete/modify conflicts prompt correctly; the two
skipped merge tests are un-skipped and pass; tests cover the new delete cases.

**Status (2026-07-19): DONE.**
- **Deletion propagation** (`merge/state-merge.ts`) — added an ancestor check
  (`isUnchangedSinceAncestor`): a one-sided delete against a surviving side that still matches the
  shared ancestor now emits `delete_remote` / `delete_local` instead of always `delete_conflict`.
  A null ancestor (never synced) or a diverged surviving side still yields `delete_conflict`.
  Convergence is by symmetry — the deleter emits `delete_remote` (a no-op marker for its own
  applicator) while the peer independently computes `delete_local` and removes the file (same
  pattern as `send_remote`/`write_local`).
- **Applicator** (`network/sync-applicator.ts`) — the previously-unreachable `delete_local` case is
  now reached; it also `markDeleted()`s the registry so the propagated delete survives restarts and
  isn't re-detected as a fresh local creation on the next reconcile.
- **Real `ask` delete-conflict modal** (`main.ts`) — replaced the auto-restore Notice with a
  `DeleteConflictModal` (Keep modified / Keep deleted; dismiss defaults to restore, so no edit is
  lost). `keep_deleted` / `keep_modified` strategies still short-circuit without prompting.
- **`mergeFromDiffs` reworked** (`merge/diff3.ts`) — replaced the expanded-line/region walker with a
  **hunk-based three-way merge**. Each diff decomposes into hunks (`[ancStart, ancEnd)` replaced by
  lines; a pure insert is a zero-width hunk). Two hunks are classified jointly only when their
  ancestor ranges overlap or both are pure inserts at the same gap. This fixes both bugs: concurrent
  appends at the same anchor **union** (grocery scenario) instead of conflicting, while a
  both-modified-the-same-line edit still conflicts; and a one-sided line modification vs. the other
  side keeping the line no longer mis-aligns into a false delete-vs-keep conflict (CRLF test).
- **Tests — green, 26 pass / 0 skip.** The two `test.skip` merge tests are un-skipped and pass;
  added `delete_remote` / `delete_local` / delete-vs-edit `delete_conflict` cases to `state-merge`.
- **Lint** — `diff3.ts` and `state-merge.ts` are now clean; `main.ts` UI-guideline churn
  (sentence-case, `<style>` injection) stays deferred to **P4**, and `conflict-modal.ts` lint to its
  P1/P4 UI pass. CI `lint` remains advisory until those land.

---

## Phase 2 — Crypto envelope & re-keying  🔴 (client-only)

Adapt `encryption.ts` from a pairing-code transport cipher to at-rest vault encryption.

- **Vault-passphrase key derivation** — reuse `deriveKey` (PBKDF2), input a vault passphrase +
  per-vault salt instead of a pairing code. Add key **verification** via `keyFingerprint`.
- **Define the encryption envelopes** matching the spec:
  - op record: `ciphertext = encrypt(vaultKey, serialize(Operation))`
  - blob: `encrypt(vaultKey, fileContent)`
- **Resolve open question §9.1 — hash blinding.** Decide raw SHA-256 vs `HMAC(vaultKey, hash)` as
  the blob key. *This is the one open question that affects the client* — it changes the
  content-store key format. (Leaning: HMAC-blinded.)
- Round-trip unit tests for both envelopes; confirm dedup still holds under the chosen hash mode.

**Exit:** ops and blobs encrypt/decrypt under a passphrase-derived key; blob-key format decided and tested.

**Status (2026-07-19): DONE.**
- **New `VaultCrypto` class** (`src/network/encryption.ts`) added *alongside* the retired-in-P5
  pairing `Encryption` class (kept so the build stays green until P5 deletes the P2P path).
  Key chain: **PBKDF2-SHA256** (210k iters — tuned down from OWASP's 600k for the mobile
  WebView target; ~1.5 bits of brute-force cost traded for ~3× faster unlock, negligible vs
  passphrase entropy — with a per-vault salt) → 256-bit master →
  **HKDF-Expand** into three domain-separated branches (distinct `info` labels): an AES-256-GCM
  `encKey`, an HMAC-SHA256 `blindKey`, and a 128-bit verification tag. PBKDF2 runs once; HKDF
  expansion is cheap, so sub-keys are independent without paying the KDF cost three times.
- **Two envelopes** matching the spec: `encryptOp`/`decryptOp` (JSON → base64 `nonce‖AES-GCM`,
  for the op `ciphertext` field) and `encryptBlob`/`decryptBlob` (raw bytes → raw bytes, binary-safe
  for the `application/octet-stream` blob body).
- **§9.1 hash blinding — DECIDED: HMAC-blinded.** `blindHash(rawHashHex)` =
  `HMAC-SHA256(blindKey, hashHex)` as hex — the server-facing blob key. Dedup preserved
  (same key → same HMAC across devices); server can't map a key back to known plaintext. The
  plaintext SHA-256 stays the *local* content-store identity; blinding is applied only at the
  transport boundary (wired in P3), so `content-store.ts` is unchanged this phase.
- **Key verification** via `fingerprint()` — a deterministic HKDF branch disjoint from the
  encryption key, so two devices confirm the same passphrase+salt before trusting data (surfaced
  in the P4 settings UI).
- **Tests — green, 16 new (`__tests__/crypto.test.ts`), 42 total.** Cover: op/blob round-trips
  (binary, empty), random-nonce non-determinism, cross-key decrypt failure, GCM tamper detection,
  blinding determinism + cross-device dedup + cross-vault unlinkability, fingerprint match/mismatch,
  and not-ready guards. Build + lint clean on touched files.

---

## Phase 3 — Server transport client  🔴 (client-only, tested vs a fake server)

Build the client half of the API spec. This is the core of the pivot.

- New module (e.g. `src/network/server-sync.ts`) speaking the spec over Obsidian **`requestUrl`**
  (mobile-capable — no Node `http`): ops pull loop (`GET /ops?since`), `POST /blobs:check`,
  `PUT/GET /blobs/{hash}`, `POST /ops`, cursor persistence.
- Reuse the **pull → merge → push flow** from `sync-client.ts` (it already does pull-content →
  merge-locally → push-content); retarget it from a peer to the server.
- Persist the **scalar sync cursor** locally; handle idempotent retries (`clientOpId`).
- Test against an **in-memory fake server** implementing the spec (also useful as the P7 harness).

**Exit:** a device syncs a full round (pull→merge→push) against the fake; cursor advances correctly.

**Status (2026-07-19): DONE.**
- **Pure orchestrator** (`src/network/server-sync.ts`) — no `obsidian` import, so the whole round
  is unit-testable. Defines the `ServerApi` wire contract (the five §4–§5 endpoints + record
  types), a `VaultSyncHost` interface abstracting the local vault
  (registry/content-store/applicator), and `ServerSyncClient.runSync()`. A round is:
  pull ops (loop `GET /ops?since` until drained, decrypt each `ciphertext` → `Operation`) →
  reconstruct a remote projection → fetch referenced blobs → **push our pending ops** (blobs via
  `blobs:check`+`PUT`, then `POST /ops`) → merge (`mergeVaultStates`) + apply → save cursor.
- **HTTP transport + cursor** (`src/network/server-http.ts`) — `HttpServerApi` over Obsidian
  `requestUrl` (mobile-safe), `Bearer` auth, `/v1/vaults/{vaultId}/…` paths, octet-stream blob
  bodies, `throw:false` + explicit status handling (`StaleCursorError` on `409`, `null` on blob
  `404`). `CursorStore` persists the scalar cursor at `.vault-sync/sync-cursor.json`.
- **In-memory fake** (`src/network/fake-server.ts`) — `FakeSyncServer` implements `ServerApi` with
  a monotonic `seq` oplog, idempotent append by `clientOpId`, a content-addressed blob store, and
  `422` (`MissingBlobError`) when an append references an un-uploaded blob. Obsidian-free, so it
  doubles as the P7 harness. Not imported by `main.ts` → tree-shaken from the plugin bundle.
- **Key design calls:**
  - *Push only locally-authored ops.* Merge-derived content (clean three-way merges) is **not**
    pushed — every device that pulls the same source ops recomputes the identical result (the D1
    CRDT-replay property). **Known gap:** a *user-resolved text conflict* is a fresh decision that
    replay can't reproduce; making it emit an op is deferred (noted in code + here).
  - *Persist the pull cursor, not `headCursor`.* Spec §7 step 6 says `cursor = headCursor`, but
    that skips ops another device appended between our pull and our push (seq ∈ (pulled, head]).
    We save the pulled cursor; our own just-pushed ops re-pull once next round and merge to a
    no-op. Correctness over one extra decrypt.
  - *Push before apply.* Ops land on the server before the applicator clears the local oplog; a
    crash in between is safe because the append is idempotent by `clientOpId`.
- **Tests — green, 10 new (`__tests__/server-sync.test.ts`), 52 total.** Cover `reconstructRemoteState`
  (HLC last-writer, out-of-order, delete, empty), the fake (idempotent append, `422`, pull
  pagination), and full rounds against the fake: A pushes → B pulls/merges/converges + cursor
  advances 0→1; re-run doesn't double-append and settles the cursor; cross-device blob dedup via
  `blobs:check`. Build + lint clean on all four new files.
- **Deferred to P4:** the concrete `VaultSyncHost` bridging registry/content-store/applicator/
  oplog and the settings that supply server URL + token + passphrase — that's the UI/wiring phase.

---

## Phase 4 — Settings, UI & wiring  🟡 (client-only)

- Replace `pairing-modal.ts` with **server config UI**: server URL + vault passphrase, derive key,
  verify fingerprint.
- **Rework `main.ts`**: drop the client/server-role selection; `sync-now` + auto-sync trigger the
  server-sync flow.
- **Wire the two stubbed settings buttons** while here: "Clear Sync Cache" → `contentStore.gc()`,
  "Reset Sync State" → reconcile registry + clear oplog.
- Update `settings-tab.ts` for the new fields.

**Exit:** a user can configure a server + passphrase and sync from the UI; maintenance buttons work.

**Status (2026-07-19): DONE.**
- **Concrete `VaultSyncHost`** (`src/network/vault-sync-host.ts`) — the production bridge deferred
  from P3. Implements the four host methods against the live stores: `buildLocalState()` snapshots
  the registry + pending oplog and reads current file bytes (plus retained ancestors) into a content
  store; `applyMerge()` → `SyncApplicator.applyActions`; `clearPendingOps()` → `OperationLogger.clearOps`;
  cursor load/save → `CursorStore`. Only genuinely new logic file this phase; lint-clean.
- **`main.ts` reworked to the server flow** — dropped the client/server-role selection, the P2P
  `SyncClient`/`SyncServer` imports, `PairingModal`, `WaitingForConnectionModal`, and the
  `populateContentStore`/`syncWithDevice` peer machinery. A single `triggerSync('manual' | 'auto')`
  builds `HttpServerApi` + `PluginVaultSyncHost` and runs `ServerSyncClient.runSync()`. Ribbon,
  `sync-now` command, and the settings "Sync now" button all route through it; `pair-new-device`
  removed. Status bar/`view-sync-status` now report server URL + key fingerprint + pending count.
- **At-rest key wired** — a plugin-owned `VaultCrypto` is derived on load (and lazily before a sync)
  via `applyVaultKey()`. Salt is **deterministic from the vaultId** (`SHA-256("vault-sync:salt:"+id)`),
  so no separate salt to transfer between devices — only server URL, vaultId, token, and passphrase.
  `vaultKeyFingerprint()` surfaces the HKDF verify tag so two devices confirm the same passphrase.
- **Auto-sync** — new `autoSyncIntervalMinutes` setting drives a `window.setInterval` armed by
  `setupAutoSync()` (re-armed on change, registered via `registerInterval`, cleared on unload).
  `0` = manual only.
- **Settings UI rebuilt** (`src/ui/settings-tab.ts`) — server (URL / vault ID / token), encryption
  (passphrase + "Derive & verify" showing the fingerprint), sync behavior (Sync now, auto-sync
  interval, debounce, delete-conflict strategy, Obsidian-config toggle), exclusions, and storage.
  Typed against a `SettingsHost extends Plugin` interface the plugin conforms to. Section headers use
  `Setting.setHeading()` (no more injected `<style>`).
- **Stubbed buttons wired** — "Clear sync cache" → `clearContentCache()` GCs the content store down
  to registry-referenced hashes (live content + ancestors) and reports the count removed; "Reset
  sync state" → `resetSyncState()` reconciles the registry against the vault and clears the oplog.
- **New settings fields** (`types.ts`): `serverUrl`, `vaultId`, `serverToken`, `vaultPassphrase`,
  `autoSyncIntervalMinutes`, `lastSyncTime`. Legacy `pairedDevices`/`syncPort` kept (unused) for P5
  to remove with the rest of the P2P types.
- **Build + tests green** (52 pass / 0 skip, unchanged — no obsidian test-mock exists, so the new
  obsidian-coupled host isn't unit-tested here; the P3 orchestrator tests cover the round vs fakes).
  Total lint **142 → 98 errors**; the survivors in touched files are the deferred UI-guideline
  category only (sentence-case false positives on the "Vault Sync" product name, emoji-prefixed
  headings, and example placeholders; `.obsidian` hardcoded-config defaults still needing runtime
  `Vault.configDir`). No `eslint-disable`/ignore added; CI `lint` stays advisory.
- **Not done here:** `pairing-modal.ts` left on disk but fully unimported (tree-shaken) — deleted
  with the rest of the P2P path in **P5**. Real-device desktop/mobile verification is **P7**.

---

## Phase 5 — Retire P2P  🟢 (client-only)

Only after P3/P4 prove the server path.

- Remove `sync-server.ts` and the peer-handshake message types (`HELLO`/`SYNC_COMPLETE`, etc.)
  from `types.ts`; keep the reused payload types.
- Remove any residual pairing/IP/port settings.
- Update README/docs to drop "legacy P2P" framing.

**Exit:** no P2P code paths remain; bundle shrinks; docs reflect server-only.

**Status (2026-07-19): DONE.**
- **Deleted the three P2P source files** — `src/network/sync-server.ts` (Node-`http` peer
  responder), `src/network/sync-client.ts` (peer pull→merge→push, superseded by
  `server-sync.ts`), and `src/ui/pairing-modal.ts` (IP/port/pairing-code UI). All three were
  already unimported after P4, so removal is a pure subtraction — `main.ts` and `settings-tab.ts`
  needed no change.
- **`encryption.ts` slimmed to `VaultCrypto` only** — removed the legacy pairing-transport
  `Encryption` class (`importKey`/`generateKey`/`deriveKey`/`encrypt`/`decrypt`/`keyFingerprint`)
  and the pairing helpers `generatePairingCode` / `generateSalt`. Kept the shared byte/base64/hex
  helpers (`bytesToBase64`, `base64ToBytes`, `bytesToHex`) — used internally by `VaultCrypto`.
- **`types.ts` — protocol + pairing types retired** — dropped `SyncSession`, `PairedDevice`, the
  whole `Proto*` message family (`ProtoHello`/`ProtoOpsExchange`/`ProtoStateExchange`/
  `ProtoContentRequest`/`ProtoContentResponse`/`ProtoContentPush`/`ProtoSyncComplete`/`ProtoError`
  + the `ProtoMessage` union), and the legacy `pairedDevices` / `syncPort` settings fields (from
  both `SyncSettings` and `DEFAULT_SETTINGS`). The reused payload types (`HLC`, `FileEntry`,
  `Operation`, `VaultState`, `MergeAction`, merge-result types) stay.
- **Docs** — README rewritten off the "mid-pivot / legacy P2P" framing to describe the server-only
  design as the actual architecture: new encryption-model + architecture/file-structure sections
  reflecting the current tree, "What's left" narrowed to the P6 server service + P7 release, and
  the roadmap updated (M3–M5 done). One stale `sync-client.ts` reference in the `server-sync.ts`
  header comment reworded.
- **Build + tests green** (52 pass / 0 skip, unchanged — nothing tested the deleted P2P path).
  Lint **98 → 25 problems**: `types.ts` and `encryption.ts` are now clean; every survivor is the
  deferred UI-guideline category in `conflict-modal.ts` / `settings-tab.ts` (sentence-case,
  `.obsidian` config-path, a `<style>` element). No `eslint-disable`/ignore added; CI `lint` stays
  advisory pending a UI polish pass.

---

## Phase 6 — Server service  🔴 (separate service/repo, parallel from P2)

Implement [`server-api-spec.md`](server-api-spec.md).

- Append-only oplog store (monotonic `seq`), content-addressed blob store, `/ops`, `/blobs`,
  optional `/checkpoint`.
- **Resolve remaining open questions:** §9.2 token/auth issuance, §9.3 stale-writer policy,
  §9.5 blob GC, §9.6 limits. (§9.4 checkpoints can defer to a v2.)
- Deployment/hosting story (out of this repo's scope, but needed to ship).

**Exit:** a deployed server satisfies the v1 spec; the P3 client talks to it, not just the fake.

**Status (2026-07-19): DONE — service built + integration-green; deployment is the one piece left.**
- **Separate Go repo** — `../obsidian-sync-golang` (module `github.com/lumpsoid/obsidian-sync-server`).
  Go 1.26, stdlib `net/http` (method+wildcard routing, no framework), **pure-Go SQLite**
  (`modernc.org/sqlite`, no CGO → a single static binary) for the oplog / accounts / tokens /
  blob-metadata, a filesystem blob store, and `x/crypto/bcrypt` for passwords.
- **v1 endpoints implemented** to the spec §4–§5 wire contract (field-for-field against
  `server-sync.ts`): `GET/POST /v1/vaults/{id}/ops`, `POST …/blobs:check`, `PUT/GET …/blobs/{hash}`,
  plus `/healthz`. Append-only monotonic per-vault `seq`; idempotent append by `clientOpId`;
  content-addressed, deduped blobs; `422` when an op references an un-uploaded blob.
- **Open questions resolved (spec §9):**
  - **§9.2 token/auth — account system.** A web UI (`/register`, `/login`, `/dashboard`) mints
    Bearer tokens (only the SHA-256 is stored; plaintext shown once). A `vaultId` is claimed by the
    first account that touches it; other accounts get `403`. An `/admin` panel lists all vaults,
    gated by an out-of-band `promote` CLI (admin is never granted through the web).
  - **§9.3 stale-writer — always accept.** `baseCursor` is advisory; append-only + client merge
    makes it safe, so the server never `409`s.
  - **§9.4 checkpoints — deferred to v2** (log-only; a fresh device replays the whole log).
  - **§9.5 blob GC — retain-all in v1** (GC is checkpoint-driven; deleting a vault cascades its rows).
  - **§9.6 limits — configurable via env** (max blob size, ops per `POST`, pull-limit cap). A
    per-vault storage **quota** is not yet enforced (a deploy/ops knob — see P7).
- **Architecture** — hexagonal: a `domain` layer of value objects + narrow ports, `usecase`
  orchestration, and `store`/`web`/`httpapi` adapters assembled in `internal/app` (with a `seed`
  subcommand for integration harnesses). `go build` / `vet` / `test` green (store contract tests,
  web-UI flow, domain/usecase units).
- **Integration — GREEN.** The plugin's client↔server contract suite (this repo, `7f65f0e`) drives
  the *real* Go server through a full pull→merge→push round and passes.
- **Not done (→ P7 / ops):** an actual **deployed** server (TLS reverse proxy, hosting, and backups
  of the data dir — the encrypted blobs + DB are the only server-side copy). That "deployed" clause
  of the Exit is the sole outstanding item.

---

## Phase 7 — Integration & release  🟡

**Status (2026-07-19): IN PROGRESS.** Single-client integration has landed (`7f65f0e` — the
client↔server contract suite against the real Go server, green). What remains, grouped:

**Correctness — must-fix before shipping v1:**
- **User-resolved conflicts don't replicate. DONE (2026-07-19).** A hand-resolved text conflict
  now emits an op so peers learn the resolution instead of diverging. The applicator's `conflict`
  case (`network/sync-applicator.ts`), on a non-null resolution, advances the registry to the
  resolved content + records it as the new ancestor, and returns a `PendingResolution`;
  `applyActions` re-emits these via a new `OperationLogger.recordResolvedUpdate` **after** the
  `clearOps` that would otherwise wipe them, so the resolution becomes a fresh pending op for the
  next round. `server-sync.ts` now advances the clock (`setCurrent(mergedHlc)`) **before** apply so
  the resolution op dominates the remote content it supersedes (last-writer-wins) rather than being
  timestamped beneath it. Convergence is by LWW replay: the resolving device pushes the resolution
  op (higher HLC); a peer that concurrently edited the same lines re-merges against the resolution
  (not the raw edits) and, accepting it, echoes the same content → the round settles to a no-op.
  (Client-side; server-independent — no wire/contract change, the op rides the existing `ciphertext`.)

**Integration testing:**
- **Two-client convergence — conflict, delete & rename cases DONE (2026-07-19).** The
  shared contract suite (`__tests__/helpers/contract-suite.ts`) covers two-device
  concurrent-overlapping-edit → resolve → converge, plus three new scenarios: a one-sided **delete**
  propagates (`delete_local`, not a false `delete_conflict`) and a fresh device sees the tombstone;
  a one-sided **rename** propagates via `move_local` (stable file id, path follows the winner); and
  **concurrent renames** to different paths converge by the HLC deviceId tie-break. All pass against
  **both** the in-memory fake (`npm test`, 63/63) and the **real Go server**
  (`npm run test:integration`, 11/11). `MemoryHost` mirrors the applicator's resolve-and-re-emit
  behaviour (`resolveConflict`) and now its `move_local` path move; new `deleteFile` / `renameFile`
  helpers queue the corresponding `delete` / `move` pending ops.
- **Real-device pass** — desktop + iOS/Android; verify the `requestUrl` transport works on mobile
  (the biggest still-untested surface).

**Deploy — the outstanding half of P6's Exit:**
- Stand up a **TLS-terminated** server (reverse proxy), set `SYNC_COOKIE_SECURE=true`, register the
  account then flip `SYNC_ALLOW_REGISTRATION=false`, and `promote` the admin. Back up the data dir.
- Harden if publicly reachable: CSRF tokens on the web forms (only `SameSite=Lax` today) and
  login/token rate-limiting; decide a per-vault storage quota (§9.6 leftover).

**Release:**
- Fill manifest `author`/`authorUrl`; version bump; community-plugin submission.
- Branch hygiene: fold `chore/p0-test-tooling` (now carrying P1–P6 + integration) into `master`.

**Exit:** shipped v1 — conflict replication fixed, two-client + real-device convergence passing, a
deployed TLS server, and a store submission.

---

## Decisions still needed (mapped to phases)

| Open question (spec §9) | Blocks | Resolution |
|---|---|---|
| ~~Hash blinding (HMAC vs raw SHA-256)~~ **DECIDED** | ~~P2~~ done | **HMAC-blinded** (shipped) |
| ~~Token / auth issuance~~ **DECIDED** | ~~P6~~ done | **Account system + dashboard-minted Bearer tokens** (shipped) |
| ~~Stale-writer `409` policy~~ **DECIDED** | ~~P6~~ done | **Always accept** in v1 (shipped) |
| ~~Checkpoints v1 vs v2~~ **DECIDED** | ~~P6~~ done | **v2** — v1 is log-only (shipped) |
| ~~Blob GC strategy~~ **DECIDED** | ~~P6~~ done | **Retain-all** in v1; checkpoint-driven later |
| Size / quota limits | P7 (deploy) | Per-request limits configurable; **per-vault quota TBD at deploy** |

Every spec-§9 question is now **resolved** except a per-vault storage **quota** — a deploy/ops knob
rather than a protocol decision, to be set when the server is stood up (P7).

---

## Suggested sequencing

**Now (2026-07-19): P0–P6 are DONE.** Only **P7** remains — fix conflict replication, prove
two-client + real-device convergence, deploy the TLS server, and submit. Original order below.

1. **P0** (foundations) — do immediately; unblocks confident change.
2. **P1** and **P2** in parallel (independent client work).
3. **P3** once P2 lands, tested against a fake server.
4. **P6** (server) in parallel with P3/P4 once the P2 envelope is fixed.
5. **P4 → P5** to finish the client and remove P2P.
6. **P7** to integrate and ship.
