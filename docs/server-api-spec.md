# Vault Sync — Server API Specification

**Status:** Draft / decision-of-record · **Version:** v1 · **Date:** 2026-07-18

This spec defines the contract between the Obsidian plugin (client) and the sync **server**.
It is a **decision today**; the server is implemented later. The client can be adapted against
this contract in the meantime.

The server is **untrusted**: it stores only ciphertext and the minimum metadata needed to order
and route data. It never decrypts, and it never merges — **all merge/conflict resolution happens
on the client** (see `src/merge/*`).

### Integrity guarantees vs. log completeness (threat model)

"Untrusted" is scoped precisely. The format defends **confidentiality** (E2E AES-256-GCM; the
server sees only ciphertext + blinded hashes) and **per-record integrity** (GCM authenticates each
`OpRecord` body — the server cannot forge or tamper an op without the key). It does **not** attempt
to defend **log completeness** against a malicious server, and this is a deliberate v1 non-goal:

- **Reorder** is neutralized by design — the client folds the log by max-HLC-per-`fileId`, so state
  is replay-order-independent (`reconstructRemoteState`).
- **Replay** of a stale op is neutralized — a lower HLC loses to newer state under LWW.
- **Omission / truncation** (a server withholding ops, or a tail of them) degrades to **staleness**,
  not corruption: the client converges to an older state that self-heals once the ops are delivered.
  Content is content-addressed and **re-hashed on fetch**, so a withholding server can never cause
  fabricated or corrupt bytes to land (upholds the data-safety invariants — no fabricated content,
  no silent overwrite).

The one property not provided is **freshness** — a client cannot *prove* it has seen every op a
peer authored, so a deliberately withholding ("forking") server is indistinguishable from
"hasn't synced yet." Closing that needs device-to-device high-water gossip or a trusted
attestation; a per-record `prevHash` chain does **not** compose with concurrent append (D1: no
compare-and-swap, server-assigned `seq` — a client can't know what precedes its op at append time).
A **per-device** chain (each device chains its own ops by author) is feasible and catches gaps
within one device's subsequence, but not tail-withholding. Both are candidate **v2** hardenings if
freshness ever enters scope; see `OP_FORMAT_AUDIT.md` finding F.

---

## 1. Design decisions

These are settled unless listed under [Open questions](#9-open-questions).

- **D1 — Append-only oplog, not a mutable state document.** The server stores an ordered,
  append-only log of encrypted operation records, each assigned a monotonic **`seq`**. This is
  what makes concurrency trivial: two devices can append concurrently and never clobber each
  other; the client-side CRDT merge reconciles the logical result on the next pull. There is **no
  compare-and-swap on the log**.
- **D2 — Content stored separately, content-addressed.** File contents are encrypted blobs in a
  separate store, keyed by a content hash. Ops reference blobs by hash. Blobs are immutable and
  deduplicated.
- **D3 — Single server-assigned sequence is the cursor.** A device's sync position is one integer
  (`cursor` = the highest `seq` it has consumed). No vector clocks at the transport layer — the
  server linearizes appends, so a scalar is sufficient. (HLCs still live *inside* the encrypted
  ops for client-side causal ordering.)
- **D4 — Optimistic concurrency lives only on the checkpoint** (§6), not on the log or blobs.
- **D5 — Encryption is the client's job.** The server receives ciphertext produced by
  `encryption.ts` (AES-256-GCM, nonce prepended) under the vault-passphrase-derived key. The
  server validates neither plaintext nor that a blob's bytes match its asserted hash.
- **D6 — Idempotent writes.** Blob `PUT` is idempotent by hash. Op `POST` carries a per-op
  `clientOpId` so retries after a dropped response don't double-append.

---

## 2. Concepts & identifiers

| Term | Meaning |
|---|---|
| **vaultId** | Opaque client-generated ID (e.g. UUID) identifying one logical vault. Configured identically on every device syncing that vault. |
| **deviceId** | Stable per-device ID (already exists in the plugin). Appears on op records for tie-breaking/debugging. |
| **seq** | Server-assigned, strictly increasing integer per vault. Assigned at append time. |
| **cursor** | A device's last-consumed `seq`. Persisted locally. `0` = "seen nothing". |
| **hash** | Content address of a blob = `HMAC-SHA256(blindKey, plaintextSHA256Hex)` (hex). Key-blinded so the server can't fingerprint content against known plaintext; still dedups (see [D5], §9.1). |
| **clientOpId** | Client-generated unique string per op, for idempotent append. |

---

## 3. Transport, auth, versioning

- **Base URL:** client-configured (`https://sync.example.com`). **HTTPS/TLS required.**
- **Version prefix:** all paths under `/v1/`. Breaking changes → `/v2/`.
- **Requests** issued from the plugin via Obsidian `requestUrl` (works on mobile — **no Node
  `http`**, unlike the retired P2P server).
- **Auth:** `Authorization: Bearer <deviceToken>`. The token is scoped to a `vaultId` with
  read/write. **How tokens are minted is out of scope for the E2E-content contract** and is an
  open question (§9) — the content-privacy guarantees do not depend on it.
- **Content types:** JSON for metadata endpoints; `application/octet-stream` for blob bodies.
- All ciphertext/binary fields in JSON are **base64** (matching `encryption.ts` helpers).

---

## 4. Oplog endpoints

### 4.1 Pull ops

```
GET /v1/vaults/{vaultId}/ops?since={cursor}&limit={n}
```

Returns ops with `seq > since`, ascending, up to `limit` (server caps, default e.g. 500).

**200**
```json
{
  "ops": [
    {
      "seq": 1043,
      "deviceId": "dev-abc",
      "ts": 1721300000000,
      "ciphertext": "<base64 AES-GCM of the serialized Operation>",
      "blobRefs": ["<hash>", "<hash>"]
    }
  ],
  "nextCursor": 1043,
  "hasMore": false
}
```

- `blobRefs` lists content hashes this op depends on, so the client can prefetch. It is metadata
  the server needs for routing/GC; it does **not** reveal content.
- Client loops (`since = nextCursor`) while `hasMore` is true.

### 4.2 Append ops

```
POST /v1/vaults/{vaultId}/ops
```

```json
{
  "baseCursor": 1043,
  "ops": [
    { "clientOpId": "dev-abc:9f2c...", "ciphertext": "<base64>", "blobRefs": ["<hash>"] }
  ]
}
```

- **`baseCursor`** = the cursor the client merged against. **Advisory** (append-only never
  clobbers). The server MAY reject with `409` if it wants to force very stale clients to
  re-pull first (see §9); the default is to accept.
- Server rejects (`422`) if any `blobRefs` hash is not present in the blob store — **push blobs
  before ops** (§5).
- `clientOpId` makes append idempotent: re-posting an already-appended `clientOpId` returns its
  existing `seq` rather than appending again.

**200**
```json
{
  "assigned": [ { "clientOpId": "dev-abc:9f2c...", "seq": 1044 } ],
  "headCursor": 1044
}
```

---

## 5. Blob endpoints

Blobs are encrypted file contents, immutable, content-addressed.

### 5.1 Check which blobs the server has

```
POST /v1/vaults/{vaultId}/blobs:check
{ "hashes": ["<hash>", "<hash>", "<hash>"] }
```
**200** → `{ "missing": ["<hash>"] }`

Replaces the P2P `hashesNeeded` step. Client uploads only the missing ones.

### 5.2 Upload a blob (idempotent)

```
PUT /v1/vaults/{vaultId}/blobs/{hash}
Content-Type: application/octet-stream
<encrypted bytes>
```
**201** created · **200** already existed (no-op). Server MAY enforce a max size; it **cannot**
verify the bytes hash to `{hash}` (they're encrypted) — hash is client-asserted [D5].

### 5.3 Download a blob

```
GET /v1/vaults/{vaultId}/blobs/{hash}
```
**200** `application/octet-stream` (encrypted bytes) · **404** if absent.

### 5.4 Reserved key-check blob (client convention — no server change)

The client stores a **key-check record** at a reserved, well-known blob key —
`sha256("vault-sync:keycheck:v1")` (a fixed 64-hex value, *not* a blinded content hash, so it
resolves to the same slot on every device regardless of passphrase and can't collide with a real
content hash). The body is `encryptBlob(JSON{v,tag})` sealing the vault's `verifyTag`. On every
round a device GETs this slot and verifies it against its own derived key *before* trusting or
pushing; a mismatch (mistyped passphrase / wrong salt) fails clean rather than wedging the vault
into two key regimes. The first device to establish the vault PUTs it (idempotent, first-write-
wins). **This needs no server support beyond the ordinary blob endpoints** — it is opaque
ciphertext at a normal blob key. GC caveat (phase 2): the key-check blob is referenced by no op,
so a checkpoint-driven blob GC (§6) must treat this reserved key as always-live. Withholding it is
an *availability* degradation (→ the pre-guard status quo), consistent with the §9-non-goal on log
completeness.

---

## 6. Checkpoint endpoints (optional, phase 2)

A checkpoint is a compacted, encrypted snapshot of `VaultState` at a given `seq`, so a fresh
device doesn't replay the entire log. This is the **only** place with compare-and-swap [D4].

### 6.1 Get checkpoint
```
GET /v1/vaults/{vaultId}/checkpoint
```
**200** `{ "seq": 1000, "version": "etag-xyz", "ciphertext": "<base64 encrypted VaultState>" }`
· **404** if none yet.

### 6.2 Put checkpoint (CAS)
```
PUT /v1/vaults/{vaultId}/checkpoint
If-Match: "etag-xyz"          // omit / use If-None-Match: * for the first write
{ "seq": 1100, "ciphertext": "<base64>" }
```
**200** new version · **412 Precondition Failed** if `version` moved (another device
checkpointed first — just retry later; not fatal).

Checkpoints also enable **blob GC**: the server may delete blobs unreferenced by the current
checkpoint *and* by ops after it. Without a checkpoint the server must retain all blobs.

---

## 7. Client sync flow (against this API)

Bootstrapping a **new device**:
1. `GET /checkpoint` → if present, decrypt to seed local state; set `cursor = checkpoint.seq`.
2. `GET /ops?since=cursor` (loop) → decrypt, prefetch `blobRefs`, merge.

A **returning device** sync round:
1. `GET /ops?since=cursor` (loop) → remote ops.
2. For referenced blobs not held locally → `GET /blobs/{hash}`.
3. **Merge locally** (`state-merge` + `diff3`) → produces new local ops + content.
4. `POST /blobs:check` for the new content hashes → `PUT` each missing blob.
5. `POST /ops` with `baseCursor = cursor` and the new ops.
6. `cursor = headCursor` (persist).
7. (Optional) if the log has grown past a threshold since the last checkpoint, `PUT /checkpoint`.

This is the same **pull → merge → push** shape `sync-client.ts` already implements — retargeted
from a peer to these endpoints.

---

## 8. What the server can and cannot see

**Sees (metadata):** `vaultId`, `deviceId`, `seq`, `ts`, blob byte-sizes, referenced content
hashes, request timing/volume.

**Never sees:** file names/paths, file contents, operation types, folder structure — all inside
the encrypted `ciphertext`/blob bodies.

**Residual leak:** content hashes and `deviceId` are visible, enabling dedup fingerprinting and
per-device activity correlation. Mitigation (see §9): key-blind the hash
(`HMAC(vaultKey, plaintextHash)`) and/or rotate/blind `deviceId`. Dedup still works because the
same key yields the same HMAC across devices.

---

## 9. Open questions (need a call before server build)

1. **Hash blinding. — DECIDED (2026-07-19): HMAC-blinded.** The server-facing blob key is
   `HMAC-SHA256(blindKey, plaintextHashHex)` as hex, where `blindKey` is an HKDF sub-key of the
   vault key (domain-separated from the AES-GCM encryption key). Dedup is preserved (same key →
   same HMAC across devices); the server can't map a blob key back to known plaintext. Implemented
   client-side in `VaultCrypto.blindHash` (`src/network/encryption.ts`); the plaintext SHA-256
   from `hashContent` remains the *local* content-store identity, blinded only at the transport
   boundary (P3).
2. **Token/auth issuance.** How does a device obtain its `Bearer` token — pre-shared vault secret
   exchanged out-of-band, an account system, or an admin-issued token? Separate from the
   E2E-content contract, but blocks a real deployment.
3. **Stale-writer policy.** Does `POST /ops` ever `409` on a too-old `baseCursor` to force a
   re-pull, or always accept (append-only + merge makes it safe either way)? *Leaning: always
   accept in v1.*
4. **Checkpoints in v1 or v2?** v1 can ship log-only (replay everything); checkpoints are a
   scaling optimization. *Leaning: v2.*
5. **Blob retention / GC** without checkpoints — retain-all, or a client-driven "in-use hashes"
   sweep endpoint?
6. **Limits** — max blob size, max ops per `POST`, per-vault storage quota.

---

## 10. Out of scope

Server implementation/hosting, storage backend, the token/account system internals, billing,
and any server-side merge (there is none — see the top of this document).

**Log completeness / freshness** against a malicious or buggy server is out of scope for v1 —
it is an *availability* property, not an integrity one (omission/truncation/replay all degrade to
staleness, never silent corruption; see [Integrity guarantees vs. log completeness](#integrity-guarantees-vs-log-completeness-threat-model)).
Detecting deliberate withholding would require gossip or attestation; revisit in v2.
