// ─────────────────────────────────────────────
//  Tests — encoding primitives
// ─────────────────────────────────────────────

import { describe, test, expect } from 'vitest';
import {
  bytesToBase64,
  base64ToBytes,
  uint8ToBase64,
  base64ToUint8,
  bytesToHex,
  randomUuid,
} from '../src/core/encoding';

describe('encoding', () => {
  test('base64 round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 42]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test('uint8/base64 aliases are the same implementation', () => {
    expect(uint8ToBase64).toBe(bytesToBase64);
    expect(base64ToUint8).toBe(base64ToBytes);
  });

  test('bytesToHex zero-pads each byte', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff');
  });

  test('randomUuid returns a v4 UUID shape', () => {
    const uuid = randomUuid();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
