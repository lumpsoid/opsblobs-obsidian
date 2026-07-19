// ─────────────────────────────────────────────
//  Encoding primitives
// ─────────────────────────────────────────────
//
//  Canonical byte↔base64 / byte→hex conversions and UUID generation, shared by
//  the content store, the crypto envelope, and the file/device identity code so
//  the same low-level logic isn't reimplemented per module.

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

// Aliases for the historical content-store names — one implementation, two names.
export const uint8ToBase64 = bytesToBase64;
export const base64ToUint8 = base64ToBytes;

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * A RFC-4122 v4 UUID. Uses `crypto.randomUUID()` where available (all modern
 * platforms including iOS) and falls back to a `Math.random()`-seeded template
 * on the rare host that lacks it.
 */
export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
