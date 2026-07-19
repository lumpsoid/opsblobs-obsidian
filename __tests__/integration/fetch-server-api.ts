// ─────────────────────────────────────────────
//  ServerApi over Node global `fetch`  (integration tests only)
// ─────────────────────────────────────────────
//
//  A test-side twin of src/network/server-http.ts (HttpServerApi). That prod
//  class speaks the same five endpoints over Obsidian's `requestUrl`, which is
//  unavailable under vitest/Node — so this one uses global `fetch` instead. The
//  wire contract it implements is identical; the shared contract suite runs the
//  same scenarios through this against the real Go server that it runs through
//  FakeSyncServer, which is what keeps the fake honest.

import { ServerApi, PullOpsResult, AppendOp, AppendResult } from '../../src/network/server-sync';

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
}
