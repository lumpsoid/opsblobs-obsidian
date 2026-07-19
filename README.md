# Obsidian Vault Sync

An Obsidian plugin that syncs your notes across devices through a **self-hostable,
end-to-end-encrypted server**. The server only ever holds encrypted blobs — it can't read your
notes — and all conflict resolution runs **on your devices**, not on the server.

> **Status: pre-release (v0.1.0).** The full client is implemented and unit-tested against an
> in-memory server: local state tracking, three-way merge, at-rest encryption, and the
> cursor-based pull → merge → push transport. What remains before a release is the **hosted
> server service** itself (a separate repo — see [`docs/server-api-spec.md`](docs/server-api-spec.md))
> and an end-to-end/real-device pass. See [What's left](#whats-left).

## How it works

Each device keeps durable local state under `.vault-sync/` in the vault:

- a **file registry** — a stable UUID for every file, so identity survives renames/moves;
- an **operation log** — recent create/modify/delete/rename events (debounced);
- a **content store** — content-addressed (SHA-256) copies of ancestor versions, used as the
  common base for three-way merges.

To sync, a device **pulls** the latest ops from the server, runs the *same* deterministic merge
locally (reusing `state-merge` + `diff3`), then **pushes** its new ops and any content blobs the
server is missing. Because the merge is commutative / associative / idempotent, every device
converges to the same vault without the server ever running the merge.

Everything the server stores is **encrypted on the device first**, with a key derived from a
**vault passphrase** you set once and enter on each device. TLS protects the connection; the
passphrase-derived key protects the data at rest. The server can compare *blinded* hashes to tell
a device which blobs it's missing, but the blobs themselves are opaque to it.

## Encryption model

A single vault passphrase drives the whole key chain (`src/network/encryption.ts`, `VaultCrypto`):

- **PBKDF2-SHA256** (210k iterations, per-vault salt derived deterministically from the vault id)
  stretches the passphrase into a 256-bit master key. The iteration count is tuned for the mobile
  WebView target; passphrase entropy dominates the real threat.
- **HKDF-Expand** splits the master into three domain-separated sub-keys: an **AES-256-GCM**
  encryption key (op records + blob bodies), an **HMAC-SHA256** blinding key, and a deterministic
  **verification tag** so two devices can confirm they derived the same key before trusting data.
- **Hash blinding** — content hashes are of *plaintext*, so exposing them would leak a dedup
  fingerprint. The server-facing blob key is `HMAC(blindKey, sha256(plaintext))`: dedup still works
  (same content → same key across a vault's devices), but the server can't map a key back to known
  plaintext, and two different vaults can't be correlated.

Only the server URL, vault id, token, and passphrase need to travel between devices — the salt is
derived from the vault id, so there is no separate secret to transfer.

## Conflict resolution

Merge runs on the device — the server never sees plaintext or resolves anything.

**Automatic (no user action):**
- File added on one device → written on the other.
- Non-overlapping edits to the same file → merged via patience + three-way merge (concurrent
  appends at the same anchor are unioned, not conflicted).
- A clean one-sided delete → propagated to the other device.
- Renames on both sides, or same-content different-path → higher HLC timestamp wins.

**Manual (UI):**
- Overlapping edits to the same region → conflict modal (Accept Local / Remote / Both, per chunk,
  with an Accept-All shortcut).
- Delete vs. modify → configurable strategy (`ask` opens a real chooser / always keep deletion /
  always keep modification).

## Architecture

| Layer | File | State |
|---|---|---|
| **HLC** — Hybrid Logical Clock for causal ordering without synced clocks | `src/core/hlc.ts` | ✅ Complete |
| **File Registry** — stable UUID ↔ path mapping across renames/moves/deletes | `src/core/file-registry.ts` | ✅ Complete |
| **Content Store** — content-addressed (SHA-256) ancestor storage | `src/core/content-store.ts` | ✅ Complete |
| **Operation Logger** — vault event hooks + debounce → `.vault-sync/oplog.json` | `src/core/operation-logger.ts` | ✅ Complete |
| **Diff3** — patience diff (LIS) + Myers-LCS fallback + hunk-based three-way merge | `src/merge/diff3.ts` | ✅ Complete |
| **State Merge** — client-side vault-state merge (incl. delete propagation) | `src/merge/state-merge.ts` | ✅ Complete |
| **VaultCrypto** — at-rest E2E encryption (PBKDF2 → HKDF; AES-GCM + HMAC blinding) | `src/network/encryption.ts` | ✅ Complete |
| **Server Sync Client** — pull → merge → push orchestrator (Obsidian-free, unit-tested) | `src/network/server-sync.ts` | ✅ Complete |
| **HTTP transport + cursor** — `requestUrl`-based API client (mobile-capable) | `src/network/server-http.ts` | ✅ Complete |
| **Vault Sync Host** — production bridge from the orchestrator to the live stores | `src/network/vault-sync-host.ts` | ✅ Complete |
| **Fake server** — in-memory `ServerApi` implementation for tests / harness | `src/network/fake-server.ts` | ✅ Complete |
| **Sync Applicator** — applies merge actions to the vault | `src/network/sync-applicator.ts` | ✅ Complete |
| **Conflict UI** | `src/ui/conflict-modal.ts` | ✅ Complete |
| **Settings UI** — server config, passphrase + fingerprint, maintenance actions | `src/ui/settings-tab.ts` | ✅ Complete |
| **Plugin entry** — server-sync flow, ribbon/commands, auto-sync | `src/main.ts` | ✅ Complete |
| **Hosted server service** | *(new — separate repo)* | ❌ To build |

## What's left

**Hosted server service (separate repo)** — an untrusted append-only encrypted oplog + content-
addressed blob store with a cursor-based pull/push API and optimistic concurrency. Its v1 contract
is fixed in **[`docs/server-api-spec.md`](docs/server-api-spec.md)**; the client already talks it
to an in-memory fake. Building and deploying it is the main remaining work, along with a handful of
server-side decisions (token/auth issuance, stale-writer policy, blob GC, size limits — tracked in
the spec's open questions).

**Integration & release** — an end-to-end test with two clients against the real server, a
real-device pass (desktop + iOS/Android to confirm the `requestUrl` path), manifest
`author`/`authorUrl`, and community-plugin submission.

**Known gaps**
- A *user-resolved text conflict* is a fresh decision that deterministic replay can't reproduce;
  emitting an op for it (so peers adopt the resolution instead of re-prompting) is deferred.
- A few settings strings still trip Obsidian's UI-guideline lint (sentence-case, `.obsidian`
  config-path); cosmetic, tracked for a UI polish pass.

## Roadmap

Milestones below; the detailed phase-by-phase plan (dependencies + per-phase exit criteria) lives
in **[`docs/implementation-plan.md`](docs/implementation-plan.md)**.

- [x] **M1** — HLC, file registry, operation logger, content store
- [x] **M2** — Patience/Myers diff, three-way merge, state merge function
- [x] **M3** — At-rest E2E encryption (passphrase-derived keys, HMAC-blinded hashes)
- [x] **M4** — Server transport client (mobile-capable), server-config UI, plugin wiring
- [x] **M5** — Client correctness (delete propagation, real `ask` modal), retire P2P
- [ ] **M6 — Server service** — build & deploy the hosted encrypted store to the v1 spec
- [ ] **M7 — Release** — end-to-end + real-device test, docs, community submission

## Development

```bash
npm install
npm run dev          # esbuild watch mode → main.js
npm run build        # type-check + production bundle
npm run lint         # eslint (obsidianmd rules)
npm test             # vitest run
```

Install into a vault by copying `main.js`, `manifest.json`, and `styles.css` into
`<Vault>/.obsidian/plugins/obsidian-vault-sync/`, then enable it under
**Settings → Community plugins**.

## File structure

```
src/
  core/                 # local state + algorithms
    hlc.ts              # Hybrid Logical Clock
    file-registry.ts    # UUID ↔ path mapping
    content-store.ts    # Content-addressed ancestor storage
    operation-logger.ts # Vault event hooks + debounce
  merge/                # client-side merge (server never merges)
    diff3.ts            # Patience/Myers diff + hunk-based three-way merge
    state-merge.ts      # Vault-state merge (incl. delete propagation)
  network/
    encryption.ts       # VaultCrypto — at-rest E2E encryption
    server-sync.ts      # pull → merge → push orchestrator (Obsidian-free)
    server-http.ts      # requestUrl transport + sync cursor
    vault-sync-host.ts  # bridge from the orchestrator to the live stores
    fake-server.ts      # in-memory ServerApi for tests / harness
    sync-applicator.ts  # applies merge actions to the vault
  ui/
    conflict-modal.ts   # conflict resolution UI
    settings-tab.ts     # server config + passphrase + maintenance actions
  main.ts               # plugin entry — server-sync flow, commands, auto-sync
  types.ts              # shared types (state, ops, merge actions, settings)
__tests__/
  core.test.ts          # HLC, diff3, state merge
  crypto.test.ts        # VaultCrypto envelopes, blinding, fingerprint
  server-sync.test.ts   # transport client rounds against the fake server

(new)                   # ❌ hosted encrypted server service — separate repo
```

## Privacy & security

- Notes sync through a **self-hostable server** that stores **only encrypted blobs** — it can't
  read your vault. All merge/conflict resolution happens on your devices.
- Content is encrypted with AES-256-GCM using a key derived (PBKDF2, 210k iterations, then HKDF)
  from a **vault passphrase** you set; TLS protects the connection to the server.
- Content hashes are **HMAC-blinded** with a vault-derived key before they reach the server, so it
  can deduplicate blobs without learning a plaintext fingerprint.
- The plugin only reads/writes inside your vault (`.vault-sync/` for its own state).

## License

0-BSD — see [LICENSE](LICENSE).
