// ─────────────────────────────────────────────
//  VaultCrypto — at-rest E2E vault encryption
//  (server-hosted pivot; see docs/server-api-spec.md §D5, §9.1)
// ─────────────────────────────────────────────
//
//  Derives, from a user vault passphrase + per-vault salt, two domain-separated
//  sub-keys and a verification tag:
//    · encKey   — AES-256-GCM, encrypts op records and blob bodies
//    · blindKey — HMAC-SHA256, blinds content hashes into server-facing blob keys
//    · verifyTag — deterministic fingerprint so two devices can confirm they
//                  derived the same key (same passphrase+salt) before syncing
//
//  Chain: PBKDF2 (slow, salted) → 256-bit master → HKDF-Expand (cheap) → sub-keys.
//  Running PBKDF2 once and HKDF-expanding avoids paying the KDF cost per sub-key
//  while still giving each sub-key an independent value (distinct HKDF `info`).

/**
 * PBKDF2 work factor. Deliberately below the OWASP-2023 600k figure: this runs
 * in a mobile WebView (Obsidian mobile is a target), where 600k is ~0.75–1.5 s
 * on a mid/low-end phone vs. ~0.25–0.5 s at 210k. The security cost of the drop
 * is ~1.5 bits of offline brute-force resistance — negligible next to passphrase
 * entropy, which dominates the real threat (an attacker brute-forcing ciphertext
 * pulled off the untrusted server). Part of the envelope version: changing it
 * re-derives all keys/fingerprints, so bump the HKDF `:v1` labels in lockstep.
 */
const PBKDF2_ITERATIONS = 210_000;

/** HKDF domain-separation labels — bump the `:v1` suffix on any envelope change. */
const HKDF_INFO_ENC = 'obsidian-vault-sync:enc:v1';
const HKDF_INFO_BLIND = 'obsidian-vault-sync:blind:v1';
const HKDF_INFO_VERIFY = 'obsidian-vault-sync:verify:v1';

const GCM_NONCE_BYTES = 12;

export class VaultCrypto {
  private encKey: CryptoKey | null = null;   // AES-256-GCM
  private blindKey: CryptoKey | null = null; // HMAC-SHA256
  private verifyTag: string | null = null;   // base64 of a 128-bit HKDF tag

  /**
   * Derive and load the encryption + blinding sub-keys from a vault passphrase
   * and a stable per-vault salt (stored in settings, identical on every device).
   */
  async deriveFromPassphrase(passphrase: string, salt: Uint8Array): Promise<void> {
    const enc = new TextEncoder();

    const pbkdf2Key = await crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const masterBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      pbkdf2Key,
      256,
    );

    const hkdfBase = await crypto.subtle.importKey(
      'raw',
      masterBits,
      'HKDF',
      false,
      ['deriveKey', 'deriveBits'],
    );
    const emptySalt = new Uint8Array(0);

    this.encKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: emptySalt, info: enc.encode(HKDF_INFO_ENC) },
      hkdfBase,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    this.blindKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: emptySalt, info: enc.encode(HKDF_INFO_BLIND) },
      hkdfBase,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const verifyBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: emptySalt, info: enc.encode(HKDF_INFO_VERIFY) },
      hkdfBase,
      128,
    );
    this.verifyTag = bytesToBase64(new Uint8Array(verifyBits));
  }

  isReady(): boolean {
    return this.encKey !== null && this.blindKey !== null;
  }

  /**
   * Deterministic verification fingerprint. Two devices deriving from the same
   * passphrase+salt produce the same value; a mismatch means a mistyped
   * passphrase (or wrong salt) — surfaced in settings before any data is trusted.
   * Reveals nothing usable: it's an HKDF branch disjoint from the encryption key.
   */
  fingerprint(): string {
    if (!this.verifyTag) throw new Error('No vault key derived');
    return this.verifyTag.slice(0, 12);
  }

  // --- Op envelope: JSON ⇄ base64(nonce‖AES-GCM ciphertext) ---------------------

  /** Encrypt a serializable op record. Returns base64 for the JSON `ciphertext` field. */
  async encryptOp(op: unknown): Promise<string> {
    const plaintext = new TextEncoder().encode(JSON.stringify(op));
    return bytesToBase64(await this.seal(plaintext));
  }

  /** Decrypt a base64 op envelope produced by encryptOp(). */
  async decryptOp<T = unknown>(ciphertextBase64: string): Promise<T> {
    const plaintext = await this.open(base64ToBytes(ciphertextBase64));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }

  // --- Blob envelope: raw bytes ⇄ raw bytes (octet-stream body) -----------------

  /** Encrypt raw file content. Returns nonce‖ciphertext as bytes (binary-safe). */
  async encryptBlob(content: Uint8Array): Promise<Uint8Array> {
    return this.seal(content);
  }

  /** Decrypt a blob envelope produced by encryptBlob(). */
  async decryptBlob(envelope: Uint8Array): Promise<Uint8Array> {
    return this.open(envelope);
  }

  // --- Hash blinding: raw content hash → server-facing blob key -----------------

  /**
   * Blind a plaintext content hash (hex SHA-256, as produced by `hashContent`)
   * into the key the server sees: HMAC-SHA256(blindKey, hashHex) as hex.
   * Deterministic under a fixed key, so cross-device dedup is preserved, while
   * the server can't map a blob key back to known plaintext (see spec §9.1).
   */
  async blindHash(rawHashHex: string): Promise<string> {
    if (!this.blindKey) throw new Error('No vault key derived');
    const mac = await crypto.subtle.sign('HMAC', this.blindKey, new TextEncoder().encode(rawHashHex));
    return bytesToHex(new Uint8Array(mac));
  }

  // --- internals ---------------------------------------------------------------

  private async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.encKey) throw new Error('No vault key derived');
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, this.encKey, plaintext as BufferSource);
    const out = new Uint8Array(nonce.length + ct.byteLength);
    out.set(nonce, 0);
    out.set(new Uint8Array(ct), nonce.length);
    return out;
  }

  private async open(envelope: Uint8Array): Promise<Uint8Array> {
    if (!this.encKey) throw new Error('No vault key derived');
    const nonce = envelope.slice(0, GCM_NONCE_BYTES);
    const ct = envelope.slice(GCM_NONCE_BYTES);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, this.encKey, ct as BufferSource);
    return new Uint8Array(pt);
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}
