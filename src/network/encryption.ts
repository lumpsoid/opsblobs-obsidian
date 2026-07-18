// ─────────────────────────────────────────────
//  Encryption Module
//  AES-256-GCM via Web Crypto API
// ─────────────────────────────────────────────

export class Encryption {
  private key: CryptoKey | null = null;

  /** Import a raw key from a base64-encoded string. */
  async importKey(keyBase64: string): Promise<void> {
    const keyBytes = base64ToBytes(keyBase64);
    this.key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /** Generate a new random AES-256 key, returns base64. */
  static async generateKey(): Promise<string> {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const exported = await crypto.subtle.exportKey('raw', key);
    return bytesToBase64(new Uint8Array(exported));
  }

  /**
   * Derive a shared key from a pairing secret (PBKDF2).
   * Both sides use the same secret → same key.
   */
  static async deriveKey(secret: string, salt: Uint8Array): Promise<string> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const derived = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100_000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const exported = await crypto.subtle.exportKey('raw', derived);
    return bytesToBase64(new Uint8Array(exported));
  }

  /** Encrypt a JSON-serializable message. Returns base64. */
  async encrypt(message: unknown): Promise<string> {
    if (!this.key) throw new Error('No key loaded');
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(message));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      this.key,
      plaintext,
    );
    // Prepend nonce to ciphertext for transport
    const combined = new Uint8Array(nonce.length + ciphertext.byteLength);
    combined.set(nonce, 0);
    combined.set(new Uint8Array(ciphertext), nonce.length);
    return bytesToBase64(combined);
  }

  /** Decrypt a base64-encoded ciphertext produced by encrypt(). */
  async decrypt<T = unknown>(ciphertextBase64: string): Promise<T> {
    if (!this.key) throw new Error('No key loaded');
    const combined = base64ToBytes(ciphertextBase64);
    const nonce = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      this.key,
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }

  isReady(): boolean {
    return this.key !== null;
  }

  /** Return a short fingerprint for display in settings. */
  async keyFingerprint(): Promise<string> {
    if (!this.key) return 'none';
    const exported = await crypto.subtle.exportKey('raw', this.key);
    const hash = await crypto.subtle.digest('SHA-256', exported);
    return bytesToBase64(new Uint8Array(hash)).slice(0, 12);
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

/** Generate a human-readable 6-digit pairing code. */
export function generatePairingCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return (arr[0]! % 1_000_000).toString().padStart(6, '0');
}

/** Generate a random pairing salt (16 bytes). */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}
