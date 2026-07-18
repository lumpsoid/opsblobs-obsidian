// ─────────────────────────────────────────────
//  HTTP transport for the sync server  (Phase 3)
// ─────────────────────────────────────────────
//
//  ServerApi over Obsidian `requestUrl` — mobile-capable (no Node `http`, unlike
//  the retired P2P server). All paths live under `/v1/vaults/{vaultId}/` and
//  carry a `Bearer` token. JSON for metadata, `application/octet-stream` for
//  blob bodies. Kept in its own module (the only `obsidian` import) so the
//  orchestrator in server-sync.ts stays unit-testable.

import { App, normalizePath, requestUrl } from 'obsidian';
import {
  ServerApi,
  PullOpsResult,
  AppendOp,
  AppendResult,
} from './server-sync';

export interface HttpServerConfig {
  /** e.g. https://sync.example.com — trailing slash optional. */
  baseUrl: string;
  vaultId: string;
  /** Bearer token scoped to the vault (issuance is out of scope — spec §9.2). */
  token: string;
}

/** A too-stale `baseCursor` was rejected (spec §9.3 — a server MAY 409). */
export class StaleCursorError extends Error {
  constructor() {
    super('Server rejected append: cursor too stale, re-pull first');
    this.name = 'StaleCursorError';
  }
}

export class HttpServerApi implements ServerApi {
  constructor(private cfg: HttpServerConfig) {}

  private vaultBase(): string {
    const root = this.cfg.baseUrl.replace(/\/+$/, '');
    return `${root}/v1/vaults/${encodeURIComponent(this.cfg.vaultId)}`;
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}` };
  }

  async pullOps(since: number, limit: number): Promise<PullOpsResult> {
    const url = `${this.vaultBase()}/ops?since=${since}&limit=${limit}`;
    const resp = await requestUrl({ url, method: 'GET', headers: this.authHeader(), throw: false });
    if (resp.status !== 200) throw new Error(`GET /ops failed: ${resp.status}`);
    return resp.json as PullOpsResult;
  }

  async appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
    const resp = await requestUrl({
      url: `${this.vaultBase()}/ops`,
      method: 'POST',
      headers: { ...this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseCursor, ops }),
      throw: false,
    });
    if (resp.status === 409) throw new StaleCursorError();
    if (resp.status !== 200) throw new Error(`POST /ops failed: ${resp.status}`);
    return resp.json as AppendResult;
  }

  async checkBlobs(hashes: string[]): Promise<{ missing: string[] }> {
    const resp = await requestUrl({
      url: `${this.vaultBase()}/blobs:check`,
      method: 'POST',
      headers: { ...this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
      throw: false,
    });
    if (resp.status !== 200) throw new Error(`POST /blobs:check failed: ${resp.status}`);
    return resp.json as { missing: string[] };
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const resp = await requestUrl({
      url: `${this.vaultBase()}/blobs/${hash}`,
      method: 'PUT',
      headers: { ...this.authHeader(), 'Content-Type': 'application/octet-stream' },
      body: toArrayBuffer(bytes),
      throw: false,
    });
    // 201 created · 200 already existed — both fine (idempotent by hash).
    if (resp.status !== 200 && resp.status !== 201) {
      throw new Error(`PUT /blobs failed: ${resp.status}`);
    }
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    const resp = await requestUrl({
      url: `${this.vaultBase()}/blobs/${hash}`,
      method: 'GET',
      headers: this.authHeader(),
      throw: false,
    });
    if (resp.status === 404) return null;
    if (resp.status !== 200) throw new Error(`GET /blobs failed: ${resp.status}`);
    return new Uint8Array(resp.arrayBuffer);
  }
}

/** Copy the exact bytes into a standalone ArrayBuffer (a Uint8Array may be a
 *  view over a larger backing buffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// ─── Cursor persistence ─────────────────────────────────────────────────────

const CURSOR_PATH = '.vault-sync/sync-cursor.json';

/**
 * Persists the scalar sync cursor (spec §D3) at `.vault-sync/sync-cursor.json`.
 * A single integer: the highest server `seq` this device has consumed. `0` means
 * "seen nothing" — a fresh device replays the whole log.
 */
export class CursorStore {
  constructor(private app: App) {}

  async load(): Promise<number> {
    try {
      const raw = await this.app.vault.adapter.read(normalizePath(CURSOR_PATH));
      const parsed = (JSON.parse(raw) as { cursor?: number }).cursor;
      return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  async save(cursor: number): Promise<void> {
    const dir = normalizePath('.vault-sync');
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(normalizePath(CURSOR_PATH), JSON.stringify({ cursor }));
  }
}
