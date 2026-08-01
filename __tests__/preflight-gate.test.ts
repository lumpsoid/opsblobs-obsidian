// ─────────────────────────────────────────────
//  Round step 0: the preflight reachability gate
// ─────────────────────────────────────────────
//
//  A round's first server contact decides how long an unreachable network costs the
//  user. It used to be `getBlob(keyCheck)`, which rides the *blob* budget (sized for
//  multi-megabyte attachments on a slow link — two minutes), so an offline device
//  wedged the round, the ribbon, and every control gated on it for that entire budget.
//
//  It is now `preflight`: a tight-budget, non-claiming read that returns the same
//  key-check bytes, retried across a momentary blip (0 / 500 ms / 1 s) and then failed
//  fast. These tests pin the properties that matter — which call opens a round, what
//  is retried, what is not, and that a round which never got through leaves no trace
//  on the server.
//
//  Drives the genuine ServerSyncClient against the fake server.

import { describe, test, expect } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import type { ServerApi } from '../src/network/server-sync';
import { AuthError, NetworkError, TimeoutError } from '../src/network/sync-errors';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([9, 9, 8, 7, 6, 5, 4, 3, 9, 9, 8, 7, 6, 5, 4, 3]);

async function crypto(passphrase = 'gate-test-passphrase'): Promise<VaultCrypto> {
  const vc = new VaultCrypto();
  await vc.deriveFromPassphrase(passphrase, SALT);
  return vc;
}

/**
 * Records the order of every ServerApi call and can make the first `n` preflights
 * fail with a chosen error — the two things these tests assert about. Everything
 * else delegates to the real fake server, so a round that gets past the gate still
 * runs for real.
 */
class RecordingApi implements ServerApi {
  readonly calls: string[] = [];
  preflightAttempts = 0;

  constructor(
    private readonly inner: FakeSyncServer,
    private readonly failures: { count: number; error: () => Error } = { count: 0, error: () => new NetworkError('checking the server') },
  ) {}

  private note(name: string): void {
    this.calls.push(name);
  }

  async preflight(keyCheckKey: string) {
    this.note('preflight');
    this.preflightAttempts++;
    if (this.preflightAttempts <= this.failures.count) throw this.failures.error();
    return this.inner.preflight(keyCheckKey);
  }
  async pullOps(since: number, limit: number) { this.note('pullOps'); return this.inner.pullOps(since, limit); }
  async appendOps(baseCursor: number, ops: Parameters<ServerApi['appendOps']>[1]) { this.note('appendOps'); return this.inner.appendOps(baseCursor, ops); }
  async checkBlobs(hashes: string[]) { this.note('checkBlobs'); return this.inner.checkBlobs(hashes); }
  async putBlob(hash: string, bytes: Uint8Array) { this.note('putBlob'); return this.inner.putBlob(hash, bytes); }
  async putBlobBatch(blobs: Parameters<ServerApi['putBlobBatch']>[0]) { this.note('putBlobBatch'); return this.inner.putBlobBatch(blobs); }
  async getBlob(hash: string) { this.note('getBlob'); return this.inner.getBlob(hash); }
  async getBlobBatch(hashes: string[]) { this.note('getBlobBatch'); return this.inner.getBlobBatch(hashes); }
}

/** A client whose retry schedule waits are recorded instead of slept, so the
 *  schedule is assertable without spending real time. */
function client(api: ServerApi, vc: VaultCrypto, d: TestDevice, waits: number[], delays?: number[]) {
  return new ServerSyncClient({
    api,
    crypto: vc,
    host: d.host,
    hlc: d.hlc,
    preflightRetryDelaysMs: delays,
    sleep: async (ms: number) => { waits.push(ms); },
  });
}

describe('preflight gate: a round opens on the cheap, retried, non-claiming call', () => {
  test('step 0 is preflight — the key check no longer rides the blob path', async () => {
    const server = new FakeSyncServer();
    const api = new RecordingApi(server);
    const A = await TestDevice.create('dev-a');
    await A.seedFile('note.md', 'hello\n', 1000);

    await client(api, await crypto(), A, []).runSync();

    // The very first thing a round does on the wire.
    expect(api.calls[0]).toBe('preflight');
    // And the key-check record itself never costs a blob GET: the round's only blob
    // traffic is its own content (uploads), never a read of the key-check slot.
    expect(api.calls).not.toContain('getBlob');
  });

  test('a link that blips is retried on the schedule and the round proceeds', async () => {
    const server = new FakeSyncServer();
    // Down for the first two attempts, up for the third.
    const api = new RecordingApi(server, { count: 2, error: () => new NetworkError('checking the server') });
    const A = await TestDevice.create('dev-a');
    await A.seedFile('note.md', 'hello\n', 1000);
    const waits: number[] = [];

    await client(api, await crypto(), A, waits).runSync();

    expect(api.preflightAttempts).toBe(3);
    // First attempt fires immediately (a 0 wait is skipped, not slept); the retries
    // are spaced 500 ms then 1 s.
    expect(waits).toEqual([500, 1000]);
    expect(server.opCount).toBe(1);   // the round really ran
  });

  test('a link that is genuinely down fails after the schedule, leaving the vault unclaimed', async () => {
    const server = new FakeSyncServer();
    const api = new RecordingApi(server, { count: Infinity, error: () => new NetworkError('checking the server') });
    const A = await TestDevice.create('dev-a');
    await A.seedFile('note.md', 'hello\n', 1000);
    const waits: number[] = [];

    await expect(client(api, await crypto(), A, waits).runSync()).rejects.toBeInstanceOf(NetworkError);

    expect(api.preflightAttempts).toBe(3);          // three tries, then give up
    expect(waits).toEqual([500, 1000]);             // ~1.5s of waiting, not 120s
    expect(api.calls).toEqual(['preflight', 'preflight', 'preflight']);
    // Nothing else was even attempted, so the round left no trace: preflight is the
    // one endpoint that doesn't claim an unclaimed vault.
    expect(server.isClaimed).toBe(false);
    // The user's work is untouched and still pending for the next attempt.
    expect(A.pendingOps.length).toBeGreaterThan(0);
  });

  test('a timeout counts as a blip; an answer from the server does not', async () => {
    const A = await TestDevice.create('dev-a');
    await A.seedFile('note.md', 'hello\n', 1000);

    // A timed-out request never reached the server — retry it.
    const timedOut = new RecordingApi(new FakeSyncServer(), {
      count: 1, error: () => new TimeoutError('checking the server', 5000),
    });
    await client(timedOut, await crypto(), A, []).runSync();
    expect(timedOut.preflightAttempts).toBe(2);

    // A 401 IS an answer: re-asking would only delay an actionable message, so it
    // surfaces on the first attempt.
    const B = await TestDevice.create('dev-b');
    await B.seedFile('note.md', 'hello\n', 1000);
    const rejected = new RecordingApi(new FakeSyncServer(), { count: Infinity, error: () => new AuthError(401) });
    await expect(client(rejected, await crypto(), B, []).runSync()).rejects.toBeInstanceOf(AuthError);
    expect(rejected.preflightAttempts).toBe(1);
  });
});
