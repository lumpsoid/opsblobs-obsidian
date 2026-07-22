// ─────────────────────────────────────────────
//  HTTP transport for the sync server  (Phase 3)
// ─────────────────────────────────────────────
//
//  ServerApi over Obsidian `requestUrl` — mobile-capable (no Node `http`, unlike
//  the retired P2P server). All paths live under `/v1/vaults/{vaultId}/` and
//  carry a `Bearer` token. JSON for metadata, `application/octet-stream` for
//  blob bodies. Kept in its own module (the only `obsidian` import) so the
//  orchestrator in server-sync.ts stays unit-testable.

import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
  ServerApi,
  PullOpsResult,
  AppendOp,
  AppendResult,
} from './server-sync';
import {
  StaleCursorError,
  AuthError,
  NotFoundError,
  ServerError,
  NetworkError,
} from './sync-errors';
import { withTimeout } from './with-timeout';

/** Default per-request time budget for the small metadata calls (ops/checks). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Blob bodies can be large on a slow link, so they get a longer budget. */
const DEFAULT_BLOB_TIMEOUT_MS = 120_000;

export interface HttpServerConfig {
  /** e.g. https://sync.example.com — trailing slash optional. */
  baseUrl: string;
  vaultId: string;
  /** Bearer token scoped to the vault (issuance is out of scope — spec §9.2). */
  token: string;
  /** Per-request timeout for metadata calls (ms). Default 30s. `0` disables. */
  timeoutMs?: number;
  /** Per-request timeout for blob transfers (ms). Default 120s. `0` disables. */
  blobTimeoutMs?: number;
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

  /**
   * Issue one request, bounded by a timeout, translating transport outcomes into the
   * user-actionable typed-error family: a thrown `requestUrl` (no response — offline,
   * bad host, DNS/TLS) → `NetworkError`; a `TimeoutError` from the bound propagates as
   * itself. Status mapping (401/403 → auth, 404 → not-found, 5xx/other → server) is
   * left to each caller, which knows which statuses are legitimate (e.g. blob 404 is
   * "absent", not an error). `throw: false` so we inspect the status ourselves.
   */
  private async request(operation: string, params: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse> {
    try {
      return await withTimeout(requestUrl({ ...params, throw: false }), timeoutMs, operation);
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      // withTimeout's TimeoutError (and anything already typed) passes through; a raw
      // requestUrl rejection means the request never got a response.
      if (err instanceof Error && err.name === 'TimeoutError') throw err;
      throw new NetworkError(operation, err);
    }
  }

  private get metaTimeout(): number { return this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS; }
  private get blobTimeout(): number { return this.cfg.blobTimeoutMs ?? DEFAULT_BLOB_TIMEOUT_MS; }

  /** Map a non-success status to the typed error family (shared across endpoints). */
  private statusError(status: number, operation: string): Error {
    if (status === 401 || status === 403) return new AuthError(status);
    if (status === 404) return new NotFoundError();
    return new ServerError(status, operation);
  }

  async pullOps(since: number, limit: number): Promise<PullOpsResult> {
    const url = `${this.vaultBase()}/ops?since=${since}&limit=${limit}`;
    const resp = await this.request('pulling changes', { url, method: 'GET', headers: this.authHeader() }, this.metaTimeout);
    if (resp.status !== 200) throw this.statusError(resp.status, 'pulling changes');
    return resp.json as PullOpsResult;
  }

  async appendOps(baseCursor: number, ops: AppendOp[]): Promise<AppendResult> {
    const resp = await this.request('pushing changes', {
      url: `${this.vaultBase()}/ops`,
      method: 'POST',
      headers: { ...this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseCursor, ops }),
    }, this.metaTimeout);
    if (resp.status === 409) throw new StaleCursorError();
    if (resp.status !== 200) throw this.statusError(resp.status, 'pushing changes');
    return resp.json as AppendResult;
  }

  async checkBlobs(hashes: string[]): Promise<{ missing: string[] }> {
    const resp = await this.request('checking the server', {
      url: `${this.vaultBase()}/blobs:check`,
      method: 'POST',
      headers: { ...this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    }, this.metaTimeout);
    if (resp.status !== 200) throw this.statusError(resp.status, 'checking the server');
    return resp.json as { missing: string[] };
  }

  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const resp = await this.request('uploading a file', {
      url: `${this.vaultBase()}/blobs/${hash}`,
      method: 'PUT',
      headers: { ...this.authHeader(), 'Content-Type': 'application/octet-stream' },
      body: toArrayBuffer(bytes),
    }, this.blobTimeout);
    // 201 created · 200 already existed — both fine (idempotent by hash).
    if (resp.status !== 200 && resp.status !== 201) throw this.statusError(resp.status, 'uploading a file');
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    const resp = await this.request('downloading a file', {
      url: `${this.vaultBase()}/blobs/${hash}`,
      method: 'GET',
      headers: this.authHeader(),
    }, this.blobTimeout);
    if (resp.status === 404) return null; // absent — a legitimate "not held", not an error
    if (resp.status !== 200) throw this.statusError(resp.status, 'downloading a file');
    return new Uint8Array(resp.arrayBuffer);
  }
}

/** Copy the exact bytes into a standalone ArrayBuffer (a Uint8Array may be a
 *  view over a larger backing buffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
