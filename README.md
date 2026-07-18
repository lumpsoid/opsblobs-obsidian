# Obsidian Vault Sync

An Obsidian plugin that syncs your notes across devices through a **self-hostable,
end-to-end-encrypted server**. The server only ever holds encrypted blobs — it can't read your
notes — and all conflict resolution runs **on your devices**, not on the server.

> **Status: pre-release, mid-pivot (v0.1.0).** This project was originally built as a
> device-to-device **P2P** sync (pairing + direct HTTP between peers). It is **pivoting to a
> client↔server model**: an untrusted server hosts encrypted state, and devices sync against
> it independently. The core algorithms, the encryption, and the client-side sync logic carry
> over; the P2P server and device-pairing pieces are being **replaced**. See
> [The pivot](#the-pivot-p2p--e2e-encrypted-server) and [What's missing](#whats-missing).

## How it will work

Each device keeps durable local state under `.vault-sync/` in the vault:

- a **file registry** — a stable UUID for every file, so identity survives renames/moves;
- an **operation log** — recent create/modify/delete/rename events (debounced);
- a **content store** — content-addressed (SHA-256) copies of ancestor versions, used as the
  common base for three-way merges.

To sync, a device **pulls** the latest state and ops from the server, runs the *same*
deterministic merge locally (reusing `state-merge` + `diff3`), then **pushes** its new ops and
any content blobs the server is missing. Because the merge is commutative / associative /
idempotent, every device converges to the same vault.

Everything the server stores is **encrypted on the device first**, with a key derived from a
**vault passphrase** you set once and enter on each device. TLS protects the connection; the
passphrase-derived key protects the data at rest. The server can diff *hashes* to tell a device
which blobs it's missing, but the blobs themselves are opaque to it.

## The pivot: P2P → E2E-encrypted server

The original design was symmetric P2P: you paired two devices (IP/port/6-digit code/salt), and
they ran a live handshake (`HELLO → OPS_SINCE → STATE → CONTENT → SYNC_COMPLETE`) in which
**both sides ran the merge**. That required both devices online at once and a device reachable
on the LAN. The pivot keeps the good half and swaps the transport:

| Piece | Fate | Notes |
|---|---|---|
| `src/core/*` (HLC, registry, content store, op logger) | ✅ **Keep** | Unchanged — local state, identical need |
| `src/merge/*` (diff3, state-merge) | ✅ **Keep** | Merge stays **client-side**; server never merges |
| `src/network/encryption.ts` | ♻️ **Reuse / adapt** | Same AES-256-GCM + PBKDF2 primitives. Re-point key derivation from a *pairing code* to a *vault passphrase*, and encrypt **data at rest** (blobs, and metadata for a strict threat model) rather than each transport message — TLS covers the hop |
| Payload types in `src/types.ts` (`VaultState`, `Operation`, content-by-hash) | ♻️ **Reuse** | What's exchanged is basically the same shape |
| `src/network/sync-client.ts` (pull → merge → push flow) | ♻️ **Reuse / adapt** | Already does "pull remote, pull missing content, merge locally, push content." Retarget it from a peer to the server's REST-ish endpoints |
| `src/network/sync-server.ts` (P2P responder) | ❌ **Replace** | It runs the merge and sees plaintext — an untrusted server must do neither. Replaced by a dumb encrypted store |
| Peer handshake (`HELLO` / `SYNC_COMPLETE`) | ❌ **Replace** | Collapses into ordinary authenticated requests + TLS |
| `src/ui/pairing-modal.ts` (device pairing) | ❌ **Replace** | Replaced by "configure server URL + vault passphrase" |

**New components the pivot needs:**

- A **hosted server** (separate service — not yet in this repo): an encrypted append-only oplog +
  content-addressed blob store. Its contract is specified in
  **[`docs/server-api-spec.md`](docs/server-api-spec.md)** (v1, decision-of-record). It never
  decrypts anything and never merges.
- A **server transport client** (adapting `sync-client.ts`) that speaks those endpoints over
  `requestUrl`, works on mobile (no Node `http`), and tracks a per-device **sync cursor**.
- **Vault-key setup UI** replacing the pairing modal: enter server URL + vault passphrase,
  derive the key, verify with `keyFingerprint`.
- **Note:** content hashes are of *plaintext*, so exposing them to the server leaks a dedup
  fingerprint. Acceptable for most, but worth deciding explicitly for a strict E2E threat model
  (e.g. HMAC the hashes with the vault key before sending).

## Conflict resolution (unchanged by the pivot)

Merge runs on the device in both the old and new model.

**Automatic (no user action):**
- File added on one device → written on the other.
- Non-overlapping edits to the same file → merged via patience + three-way merge.
- Renames on both sides, or same-content different-path → higher HLC timestamp wins.

**Manual (UI):**
- Overlapping edits to the same region → conflict modal (Accept Local / Remote / Both, per
  chunk, with an Accept-All shortcut).
- Delete vs. modify → configurable strategy (`ask` / always keep deletion / always keep
  modification). **Note:** the `ask` path currently shows a Notice and defaults to *restore*
  rather than opening a real chooser.

## Architecture

| Layer | File | State |
|---|---|---|
| **HLC** — Hybrid Logical Clock for causal ordering without synced clocks | `src/core/hlc.ts` | ✅ Complete · keep |
| **File Registry** — stable UUID ↔ path mapping across renames/moves/deletes | `src/core/file-registry.ts` | ✅ Complete · keep |
| **Content Store** — content-addressed (SHA-256) ancestor storage | `src/core/content-store.ts` | ✅ Complete (`gc()` never called) · keep |
| **Operation Logger** — vault event hooks + debounce → `.vault-sync/oplog.json` | `src/core/operation-logger.ts` | ✅ Complete · keep |
| **Diff3** — patience diff (LIS) + Myers-LCS fallback + three-way merge | `src/merge/diff3.ts` | ✅ Complete (~445 lines) · keep |
| **State Merge** — client-side vault-state merge | `src/merge/state-merge.ts` | ⚠️ Deletion handling incomplete · keep |
| **Encryption** — AES-256-GCM + PBKDF2 | `src/network/encryption.ts` | ♻️ Reuse — re-key to vault passphrase, encrypt at rest |
| **Sync Client** — pull → merge → push | `src/network/sync-client.ts` | ♻️ Reuse — retarget to server endpoints |
| **Sync Server** — P2P responder (Node `http`, desktop-only) | `src/network/sync-server.ts` | ❌ Replace with hosted encrypted store |
| **Sync Applicator** — applies merge actions to the vault | `src/network/sync-applicator.ts` | ⚠️ `delete_*` actions never produced · keep |
| **Pairing UI** | `src/ui/pairing-modal.ts` | ❌ Replace with server-URL + passphrase setup |
| **Conflict UI** | `src/ui/conflict-modal.ts` | ✅ Complete · keep |
| **Settings UI** | `src/ui/settings-tab.ts` | ⚠️ Two stubbed buttons; needs server config · keep + extend |
| **Plugin entry** | `src/main.ts` | ⚠️ Client/server-role selection to be replaced by server sync · keep + adapt |
| **Types / protocol messages** | `src/types.ts` | ♻️ Payload types reuse; peer-handshake messages retire |
| **Hosted server service** | *(new — not in repo)* | ❌ To build |

## Project status

Genuinely implemented and reasonably solid (all client-side, all reused by the pivot):

- HLC, file registry, content store, operation logger (`src/core/`)
- Patience/Myers diff and three-way merge (`src/merge/diff3.ts`)
- Vault-state merge for adds/edits/renames (`src/merge/state-merge.ts`)
- AES-256-GCM encryption + PBKDF2 key derivation (`src/network/encryption.ts`)
- Conflict modal, settings tab, plugin wiring, 3 commands (`src/ui/`, `src/main.ts`)
- A substantive unit-test suite for HLC, diff3, and state-merge (`__tests__/core.test.ts`)

The old P2P transport (`sync-client.ts` + `sync-server.ts`, pairing) is implemented and works
device-to-device, but is **being superseded** by the server model.

## What's missing

Roughly in priority order.

**The pivot itself (new work)**
- **Hosted server service** — an untrusted encrypted blob + oplog store with a cursor-based
  pull/push API and optimistic concurrency. Does not exist yet.
- **Server transport client** — adapt `sync-client.ts` to those endpoints; must run on mobile
  (drop the Node `http` dependency that ties the current server to desktop).
- **Encryption re-keying** — derive the key from a vault passphrase (not a pairing code) and
  encrypt data **at rest** (blobs, and metadata if going strict); decide whether to blind the
  plaintext content hashes from the server.
- **Vault-key / server-config UI** — replace the pairing modal.
- **Retire** `sync-server.ts`, the peer handshake, and pairing once the server path works.

**Correctness (pre-existing, carries into the new model)**
- **Deletion propagation is incomplete** — `state-merge` never emits `delete_local` /
  `delete_remote`; a clean delete surfaces as a `delete_conflict`, and `deleteLocalFile()` is
  unreachable.
- **`ask` delete-conflict handler is a stub** (`main.ts`): shows a Notice and auto-restores.

**Settings maintenance actions (stubbed)**
- **"Clear Sync Cache"** fakes success; doesn't call `contentStore.gc()`.
- **"Reset Sync State"** fakes success; doesn't reconcile the registry or clear the oplog.

**Test tooling**
- No `test` script and **no test runner installed** (no Jest/Vitest in `devDependencies`, no
  config), yet `__tests__/core.test.ts` uses Jest globals — the tests **can't run as-is**.
- `__mocks__/obsidian.ts` was previously listed but doesn't exist (current tests don't need it).

**Cleanup**
- `src/settings.ts` is **orphaned Obsidian sample-plugin boilerplate**, imported nowhere —
  delete it. Real settings live in `types.ts` + `ui/settings-tab.ts`.
- `package.json` `name` is still `"obsidian-sample-plugin"`.
- Minor dead code: unused `MarkdownRenderer` import in `conflict-modal.ts`; unused locals/types
  in `mergeFromDiffs` (`diff3.ts`).

**Release readiness**
- Not submitted to the community plugin catalog; `author`/`authorUrl` are placeholders.
- No integration test of a full sync round-trip.

## Roadmap

Milestones below; the detailed phase-by-phase plan (with dependencies and per-phase exit
criteria) lives in **[`docs/implementation-plan.md`](docs/implementation-plan.md)**.

- [x] **M1** — HLC, file registry, operation logger, content store
- [x] **M2** — Patience/Myers diff, three-way merge, state merge function
- [x] **M3** — Encryption + (legacy) P2P transport
- [x] **M4** — Conflict UI, pairing flow, settings tab, plugin wiring
- [ ] **M5 — Server pivot** — hosted encrypted store; server transport client (mobile-capable);
  passphrase-derived keys + at-rest encryption; server-config UI; retire P2P server + pairing
- [ ] **M6 — Correctness** — finish deletion propagation, real `ask` delete modal, wire up the
  two settings buttons
- [ ] **M7 — Release** — add a test runner + CI test step, integration test, remove
  sample-plugin leftovers, docs, community submission

## Development

```bash
npm install
npm run dev          # esbuild watch mode → main.js
npm run build        # type-check + production bundle
npm run lint         # eslint (obsidianmd rules)
# npm test           # ⚠️ not wired up yet — no test script / runner (see "What's missing")
```

Install into a vault by copying `main.js`, `manifest.json`, and `styles.css` into
`<Vault>/.obsidian/plugins/obsidian-vault-sync/`, then enable it under
**Settings → Community plugins**.

## File structure

```
src/
  core/                 # ✅ kept as-is (local state + algorithms)
    hlc.ts              # Hybrid Logical Clock
    file-registry.ts    # UUID ↔ path mapping
    content-store.ts    # Content-addressed ancestor storage
    operation-logger.ts # Vault event hooks + debounce
  merge/                # ✅ kept (client-side merge)
    diff3.ts            # Patience/Myers diff + three-way merge
    state-merge.ts      # Vault-state merge
  network/
    encryption.ts       # ♻️ reuse — re-key to vault passphrase, encrypt at rest
    sync-client.ts      # ♻️ reuse — retarget to server endpoints
    sync-server.ts      # ❌ replace — P2P responder, superseded by hosted store
    sync-applicator.ts  # ✅ kept — applies merge actions to the vault
  ui/
    conflict-modal.ts   # ✅ kept — conflict resolution UI
    pairing-modal.ts    # ❌ replace — with server-URL + passphrase setup
    settings-tab.ts     # ✅ kept + extend — add server config
  main.ts               # ⚠️ adapt — swap client/server role logic for server sync
  types.ts              # ♻️ payload types reuse; peer-handshake messages retire
  settings.ts           # ⚠️ orphaned sample-plugin leftover — to be removed
__tests__/
  core.test.ts          # Unit tests (HLC, diff3, state merge) — runner not yet configured

(new)                   # ❌ hosted encrypted server service — separate, not yet in repo
```

## Privacy & security

- Notes sync through a **self-hostable server** that stores **only encrypted blobs** — it can't
  read your vault. All merge/conflict resolution happens on your devices.
- Content is encrypted with AES-256-GCM using a key derived (PBKDF2, 100k iterations) from a
  **vault passphrase** you set; TLS protects the connection to the server.
- The plugin only reads/writes inside your vault (`.vault-sync/` for its own state).
- Open item: plaintext content hashes are visible to the server for dedup/diffing — to be
  blinded if a strict E2E threat model is required.

## License

0-BSD — see [LICENSE](LICENSE).
