// SHA-256 as lowercase hex — the one genuinely-shared pure helper the tests need
// (blob-lifecycle assertions, resolution-hash checks). Kept as a tiny util so no
// test has to reach into a device's internals to hash bytes.

export async function sha256Hex(content: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', content as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
