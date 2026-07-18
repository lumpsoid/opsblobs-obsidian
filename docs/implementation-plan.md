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

---

## Phase 5 — Retire P2P  🟢 (client-only)

Only after P3/P4 prove the server path.

- Remove `sync-server.ts` and the peer-handshake message types (`HELLO`/`SYNC_COMPLETE`, etc.)
  from `types.ts`; keep the reused payload types.
- Remove any residual pairing/IP/port settings.
- Update README/docs to drop "legacy P2P" framing.

**Exit:** no P2P code paths remain; bundle shrinks; docs reflect server-only.

---

## Phase 6 — Server service  🔴 (separate service/repo, parallel from P2)

Implement [`server-api-spec.md`](server-api-spec.md).

- Append-only oplog store (monotonic `seq`), content-addressed blob store, `/ops`, `/blobs`,
  optional `/checkpoint`.
- **Resolve remaining open questions:** §9.2 token/auth issuance, §9.3 stale-writer policy,
  §9.5 blob GC, §9.6 limits. (§9.4 checkpoints can defer to a v2.)
- Deployment/hosting story (out of this repo's scope, but needed to ship).

**Exit:** a deployed server satisfies the v1 spec; the P3 client talks to it, not just the fake.

---

## Phase 7 — Integration & release  🟡

- **End-to-end test:** two clients + the real (or fake) server → concurrent edits, deletes, and
  renames converge.
- Real-device pass (desktop + iOS/Android) — verify the `requestUrl` path works on mobile.
- Fill manifest `author`/`authorUrl`; version bump; community-plugin submission.

**Exit:** shipped v1 with a passing integration test and a store submission.

---

## Decisions still needed (mapped to phases)

| Open question (spec §9) | Blocks | Leaning |
|---|---|---|
| ~~Hash blinding (HMAC vs raw SHA-256)~~ **DECIDED** | ~~P2~~ done | **HMAC-blinded** (shipped) |
| Token / auth issuance | P6 (deploy) | — |
| Stale-writer `409` policy | P6 | Always accept in v1 |
| Checkpoints v1 vs v2 | P6/P7 | v2 |
| Blob GC strategy | P6 | Checkpoint-driven |
| Size / quota limits | P6 | — |

Hash blinding (the only client-gating question) is **resolved** (HMAC-blinded, P2); the rest gate
the server/deploy and can be settled during P6, so client work P3–P5 is unblocked.

---

## Suggested sequencing

1. **P0** (foundations) — do immediately; unblocks confident change.
2. **P1** and **P2** in parallel (independent client work).
3. **P3** once P2 lands, tested against a fake server.
4. **P6** (server) in parallel with P3/P4 once the P2 envelope is fixed.
5. **P4 → P5** to finish the client and remove P2P.
6. **P7** to integrate and ship.
