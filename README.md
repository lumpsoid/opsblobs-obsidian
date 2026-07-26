# OpsBlobs

An Obsidian plugin that syncs your notes across devices through a **self-hostable,
end-to-end-encrypted server**. The server stores only ciphertext and routing metadata — it can't
read your notes and it never merges — all conflict resolution runs **on your devices**.

> **Status: pre-release (v0.1.2).** The client is code-complete, unit- and integration-tested
> (349 unit tests + a contract suite run against the real server), and the sync-v2 rewrite
> (commit-DAG merge engine) has fully landed. The [hosted server](#the-server) is built in a
> separate repo. What's left is a real-device (iOS/Android) manual-smoke pass, a couple of
> cosmetic conflict-UI polish items, and community-plugin submission.

## How it works

Each device keeps durable local state under `.opsblobs/` in the vault:

- a **file registry** — a stable UUID for every file, so identity survives renames/moves;
- a **version DAG** — a commit graph keyed by operation id (a mini-Git for the vault, see
  [Merge model](#merge-model-a-commit-dag-keyed-by-op-id));
- an **operation log** — debounced create/modify/delete/rename/merge events, each naming its
  causal parent version(s);
- a **content store** — content-addressed (SHA-256) copies of file versions, used as merge bases
  and pruned by an age-and-reachability-aware GC.

A sync round **pulls** new ops since the local cursor, **merges** them into local state with a
deterministic three-way algorithm, applies the result to the vault, **pushes** local ops and any
blobs the server is missing, and advances the cursor. Because the merge is a pure, commutative
function of the DAG, every device that has seen the same ops computes the same result — most
merge output doesn't need to be re-pushed, it's redundant by construction.

The prime directive throughout: **the user's data is critical and must never be silently
overridden, dropped, or left divergent.** Ambiguous cases always degrade to "keep both sides
visible and ask", never to a guess.

## Merge model: a commit DAG keyed by op-id

Earlier versions of this plugin tracked the three-way-merge base as a single mutable scalar per
file, maintained by a policy. A scalar can't represent causal history, so every place the policy
diverged from true causality became a data-loss bug patched locally. The current engine (v2)
records the causal structure directly instead of approximating it:

- **A version is an operation id** (an HLC timestamp, unique and monotonically ordered) — not a
  content hash. Content *recurs* (`empty → "3" → empty`, an undo, a toggled checkbox), so a
  content-hash-keyed graph would form cycles and break ancestor lookups. Op-ids never repeat, so
  the DAG is acyclic by construction.
- **Every op names its causal parents:** a `create` is a DAG root; an ordinary edit's parent is
  the file's previous head; a `delete` is a tombstone version; a `merge` names *both* sides it
  reconciled.
- **A "head" is a leaf version** with no child. One head per file = converged. Two heads = the
  file has diverged and needs reconciling.
- **Merging two heads is pure and total:** find their lowest common ancestor in the DAG; if one
  head is a descendant of the other, fast-forward; otherwise perform a three-way merge over the
  content at (ancestor, head A, head B) — a clean result is recorded as a new merge version, an
  overlapping one is written as inline conflict markers and both heads stay open until a human
  resolves them.

Clean merges are a deterministic function of their inputs, so two devices that independently
merge the same pair converge on identical content without needing to talk to each other. A
*human* conflict resolution is not deterministic, so it's explicitly re-shared as a two-parent
merge version that every peer holding either original head can fast-forward onto — no
"conflicted copy" files, no separate resolution bookkeeping. The rationale, alternatives
considered (including why a text CRDT doesn't fit a file-sync tool), and the full list of
data-safety invariants this design closes are recorded in
[`docs/sync-v2-decisions.md`](docs/sync-v2-decisions.md) and
[`docs/sync-engineering-guide.md`](docs/sync-engineering-guide.md).

## Encryption model

A single vault passphrase drives the whole key chain (`src/network/encryption.ts`, `VaultCrypto`):

- **PBKDF2-SHA256** (210k iterations, per-vault salt derived deterministically from the vault id)
  stretches the passphrase into a 256-bit master key.
- **HKDF-Expand** splits the master key into three domain-separated sub-keys: an
  **AES-256-GCM** encryption key (op records + blob bodies), an **HMAC-SHA256** blinding key, and
  a deterministic **verification tag** so two devices can confirm they derived the same key.
- **Hash blinding** — content hashes are of *plaintext*, so exposing them would leak a dedup
  fingerprint. The server-facing blob key is `HMAC(blindKey, sha256(plaintext))`: dedup still
  works (same content → same key), but the server can't map a key back to known plaintext, nor
  correlate two different vaults.
- **Key-check guard** — a reserved, non-blinded slot lets a device verify its derived key against
  the vault *before* decrypting a single pulled op or pushing under it, so a mistyped passphrase
  fails as a clean, actionable error instead of wedging the vault into two incompatible key
  regimes.

Only the server URL, vault id, access token, and passphrase need to travel between devices — the
salt is derived from the vault id, so there's no separate secret to transfer. TLS protects the
connection; the passphrase-derived key protects data at rest, including against the server
operator.

## Conflict resolution

Merge runs on the device; the server never sees plaintext or resolves anything. Nothing about
conflicts blocks a sync round — there are no modals anywhere in the plugin.

**Automatic (no user action):**
- A file added on one device is written on the other.
- Non-overlapping edits to the same file merge via a three-way (patience diff + line-based) merge.
- A clean one-sided delete propagates to the other device.
- Two devices independently creating the same path converge to one identity, raising a conflict
  only if the content actually differs.

**Surfaced for the user, never blocking:**
- **Overlapping text edits** are written in place at the real path as three-way diff markers —
  the common ancestor (**Original**), this device's version (**Mine**), and the other device's
  version (**Theirs**) — around just the hunks that actually conflict. The **Conflicts** tab (a
  full workspace view, not a sidebar or a popup) lists every affected file with per-device/time
  provenance, a per-hunk three-way compare pane, a live preview of the exact bytes a resolution
  will write, and one-click "keep mine / keep theirs / keep both" actions. Resolving is just
  saving the file — by hand-editing the markers or through the panel — which folds the two
  diverged versions back into one.
- **Delete-vs-modify and binary-file conflicts** can't be represented as inline markers, so they're
  always deferred to the same Conflicts tab as a decision card (unless you've set a standing
  "always keep deleted/modified" policy in settings).

## Settings

**Setup** — server URL, vault ID (switching prompts a confirmation, since it resets local sync
state), access token, vault passphrase, a key fingerprint you compare across devices to confirm
they share the same key, and a connection test — with a live readiness checklist while you fill
them in.

**This device** — a friendly device name; a Diagnostics panel with the read-only device id, a
performance-logging toggle, and an in-app perf-log viewer (useful since `.opsblobs/` is
unreachable from the iOS Files app).

**Sync** — a sync-status view, a manual "Sync now", an auto-sync interval (0 = manual only), and
a delete-conflict strategy (ask each time / always keep the deletion / always keep the
modification).

**Advanced** — whether to sync `.obsidian/` config (snippets, templates — workspace layout is
always excluded), the edit-debounce delay, how long old file versions are retained for merge
bases, a max file size, and glob-based excluded paths.

**Maintenance & danger zone** — clear the merge-base cache (safe), re-check for conflicts you
dismissed by accident, reset corrupted local sync metadata without touching vault content or
losing un-synced changes, and re-baseline this device to the server (force-pushes everything —
guarded by a type-to-confirm prompt, since it can overwrite other devices' concurrent edits).

## Architecture

The engine is built ports-and-adapters style so the sync logic is unit-testable without a
running Obsidian instance: pure `core`/`merge` modules and Obsidian-free `network` orchestration
depend only on narrow port interfaces (`VaultFiles`, `MetadataStore`, `VaultWatcher`,
`EditorSaver`, `Notifier`); thin `obsidian-*` adapters are the only place that imports `obsidian`
besides `main.ts` and `src/ui/`.

| Layer | Path | Role |
|---|---|---|
| **HLC** | `src/core/hlc.ts` | Hybrid Logical Clock — total ordering across devices; mints every op's id. |
| **Version DAG** | `src/core/version-dag.ts` | The commit graph: ancestor/LCA lookups, open-heads, GC keep-set. |
| **File Registry** | `src/core/file-registry.ts` | UUID ↔ path identity, current head per file, rename/move/delete tracking. |
| **Content Store** | `src/core/content-store.ts` | Hash-addressed byte cache with age- and DAG-reachability-aware GC. |
| **Operation Logger** | `src/core/operation-logger.ts` | Vault-event capture, debouncing, cold-start reconciliation. |
| **Operations** | `src/core/operations.ts` | The op-shape catalog (create/update/delete/move/merge). |
| **Conflict inventory / policy** | `src/core/conflict-inventory.ts`, `conflict-policy.ts` | Derived two-headed-file query; pure delete-conflict strategy. |
| **Exclusion policy** | `src/core/exclusion-policy.ts` | Glob-based path exclusion + per-file size cap. |
| **Diff3** | `src/merge/diff3.ts` | Patience/Myers three-way line merge; conflict-marker render/parse/resolve. |
| **State Merge** | `src/merge/state-merge.ts` | `mergeVaultStates` — the pure, commutative merge decision function. |
| **Server Sync Client** | `src/network/server-sync.ts` | Orchestrates one sync round: pull → merge → push → reconcile → cursor. |
| **Sync Applicator** | `src/network/sync-applicator.ts` | Applies merge decisions to the real vault. |
| **Sync Coordinator** | `src/network/sync-coordinator.ts` | Capture → round → record sequence; reset/rebaseline; obsidian-free. |
| **Encryption** | `src/network/encryption.ts` | `VaultCrypto` — at-rest E2E encryption, key derivation, hash blinding. |
| **HTTP transport** | `src/network/server-http.ts`, `fake-server.ts` | Real `requestUrl`-based client vs. an in-memory fake (contract-equivalent). |
| **Ports** | `src/ports/*.ts` | The narrow interfaces the engine depends on instead of `obsidian`. |
| **Conflicts panel** | `src/ui/conflicts-view.ts` | The non-blocking, all-in-one conflict resolution tab. |
| **Settings, status, pending-changes, perf-log views** | `src/ui/*.ts` | Everyday UI surfaces. |
| **Plugin entry** | `src/main.ts` | Thin glue: ribbon/status bar, commands, auto-sync timer, view wiring. |

### The server

The server is a **separate repository** and is untrusted by design: an append-only encrypted
operation log with server-assigned sequence numbers, content-addressed encrypted blobs, and a
scalar pull/push cursor — it never decrypts anything and never merges. The wire contract is
specified in [`docs/server-api-spec.md`](docs/server-api-spec.md); the client is built and tested
against it (via an in-memory fake for unit tests, and the real server for the integration/contract
suite).

## Performance

The sync engine has had a sustained optimization pass to keep large vaults and mobile devices
fast: first-time capture and steady-state rounds went from O(vault-size²) registry/oplog rewrites
to O(changes-since-last-sync) via append-only journals and batched writes; content staging before
a merge is scoped to exactly the bytes that round's merge needs (zero on an already-converged
round); and blob transfer uses batched fetch/push endpoints instead of one round-trip per file.
Work is measured in three tiers — relative wall-clock timing on a dev machine, device-independent
operation/byte counts, and real on-device timing (the in-app perf-log, since `.opsblobs/` isn't
reachable from the iOS Files app) — recorded in `docs/perf-baseline-2026-07-23.md` and the
various `docs/*-optimization-spec.md` documents.

## Development

```bash
npm install
npm run dev              # esbuild watch mode → main.js
npm run build             # type-check + production bundle
npm run lint              # eslint (obsidianmd rules)
npm test                  # vitest (unit, obsidian-free layer)
npm run test:coverage     # coverage — a blind-spot finder, not a target
npm run test:integration  # same scenarios, run against the real Go server
npm run bench             # perf harness (needs --expose-gc, wired in via npm script)
```

Install into a vault for local development with `scripts/link-vault.sh` (symlinks the repo into
`.obsidian/plugins/opsblobs/` for live-reload) or `scripts/copy-to-vault.sh` (copies built
artifacts, for vaults that can't use a symlink — e.g. one that's itself synced or on mobile).
`scripts/deploy-android.sh` pushes a build to a connected Android device via `adb`. Then enable
**OpsBlobs** under Obsidian's **Settings → Community plugins**.

Tests drive the real production stack (registry, content store, oplog, applicator, version DAG)
over in-memory fakes of the Obsidian-facing ports — never a reimplementation of the merge/apply
logic. `TestDevice` (`__tests__/helpers/test-device.ts`) wires that stack for two- and
three-device convergence scenarios; its `.reload()` models a restart/crash-recovery. The contract
suite (`__tests__/helpers/contract-suite.ts`) runs identical scenarios against both the fake and
the real server so the fake can't silently drift from what it stands in for.

See [`docs/sync-engineering-guide.md`](docs/sync-engineering-guide.md) before making any change
under `src/core`, `src/merge`, or `src/network` — it's the living document of how the engine
works, why, and the gotchas found along the way.

## Privacy & security

- Notes sync through a **self-hostable server** that stores **only encrypted blobs and routing
  metadata** — it can't read your vault, and all merge/conflict resolution happens on your
  devices.
- Content is encrypted with **AES-256-GCM** using a key derived (PBKDF2, then HKDF) from a
  **vault passphrase** you set once; TLS protects the connection to the server.
- Content hashes are **HMAC-blinded** with a vault-derived key before they reach the server, so
  it can deduplicate blobs without learning a plaintext fingerprint.
- The plugin only reads/writes inside your vault (`.opsblobs/` for its own state) and excludes
  its own settings file (which holds your passphrase and token in cleartext locally) from sync.

## License

0-BSD — see [LICENSE](LICENSE).
