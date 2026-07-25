// ─────────────────────────────────────────────
//  ServerApi over Node global `fetch`  (integration tests only)
// ─────────────────────────────────────────────
//
//  A test-side twin of src/network/server-http.ts (HttpServerApi). That prod
//  class speaks the same endpoints over Obsidian's `requestUrl`, which is
//  unavailable under vitest/Node — so this one uses global `fetch` instead. The
//  wire contract it implements is identical; the shared contract suite runs the
//  same scenarios through this against the real Go server that it runs through
//  FakeSyncServer, which is what keeps the fake honest.

import { ServerApi, PullOpsResult, AppendOp, AppendResult, BlobUpload } from '../../src/network/server-sync';
import { BatchTooLargeError } from '../../src/network/sync-errors';
import { bytesToBase64, base64ToBytes } from '../../src/core/encoding';

export class FetchServerApi implements ServerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly vaultId: string,
  ) {}

  private vaultBase(): string {
    const root = this.baseUrl.replace(/\/+$/, '');
    return `${root}/v1/vaults/${encodeURIComponent(this.vaultId)}`;
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async pullOps(since: number, limit: number): Promise<PullOpsResult> {
    const resp = await fetch(`${this.vaultBase()}/ops?since=${since}&limit=${limit}`, {
      method: 'GET', headers: this.auth(),
    });
    if (resp.status !== 200) throw new Error(`GET /ops failed: ${resp.status}`);
    return (await resp.json()) as PullOpsResult;
  }

  async appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
    const resp = await fetch(`${this.vaultBase()}/ops`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseCursor, ops }),
    });
    // 422 = a referenced blob was never uploaded (spec §4.2); surface it as an
    // error so callers see the same rejection the FakeSyncServer raises.
    if (resp.status !== 200) throw new Error(`POST /ops failed: ${resp.status}`);
    return (await resp.json()) as AppendResult;
  }

  async checkBlobs(hashes: string[]): Promise<{ missing: string[] }> {
    const resp = await fetch(`${this.vaultBase()}/blobs:check`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
    if (resp.status !== 200) throw new Error(`POST /blobs:check failed: ${resp.status}`);
    return (await resp.json()) as { missing: string[] };
  }

  async putBlobBatch(blobs: BlobUpload[]): Promise<void> {
    const resp = await fetch(`${this.vaultBase()}/blobs:batch`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ blobs: blobs.map(b => ({ hash: b.hash, data: bytesToBase64(b.bytes) })) }),
    });
    if (resp.status !== 200) throw new Error(`POST /blobs:batch failed: ${resp.status}`);
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const resp = await fetch(`${this.vaultBase()}/blobs/${hash}`, {
      method: 'PUT',
      headers: { ...this.auth(), 'Content-Type': 'application/octet-stream' },
      // Copy into a standalone ArrayBuffer — the view may span a larger buffer.
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    if (resp.status !== 200 && resp.status !== 201) {
      throw new Error(`PUT /blobs failed: ${resp.status}`);
    }
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    const resp = await fetch(`${this.vaultBase()}/blobs/${hash}`, {
      method: 'GET', headers: this.auth(),
    });
    if (resp.status === 404) return null;
    if (resp.status !== 200) throw new Error(`GET /blobs failed: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  async preflight(keyCheckKey: string): Promise<{ claimed: boolean; keyCheck: Uint8Array | null }> {
    const q = keyCheckKey ? `?keyCheck=${encodeURIComponent(keyCheckKey)}` : '';
    const resp = await fetch(`${this.vaultBase()}/preflight${q}`, {
      method: 'GET', headers: this.auth(),
    });
    if (resp.status !== 200) throw new Error(`GET /preflight failed: ${resp.status}`);
    const json = (await resp.json()) as { claimed: boolean; keyCheck: string | null };
    return { claimed: json.claimed, keyCheck: json.keyCheck ? base64ToBytes(json.keyCheck) : null };
  }

  async getBlobBatch(hashes: string[]): Promise<{ blobs: Map<string, Uint8Array>; missing: string[] }> {
    const resp = await fetch(`${this.vaultBase()}/blobs:fetch`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
    if (resp.status === 413) throw new BatchTooLargeError();
    if (resp.status !== 200) throw new Error(`POST /blobs:fetch failed: ${resp.status}`);
    const json = (await resp.json()) as { blobs: { hash: string; data: string }[]; missing: string[] };
    const blobs = new Map<string, Uint8Array>();
    for (const b of json.blobs) blobs.set(b.hash, base64ToBytes(b.data));
    return { blobs, missing: json.missing };
  }
}
