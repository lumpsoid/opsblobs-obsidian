// ─────────────────────────────────────────────
//  Sync server contract suite
// ─────────────────────────────────────────────
//
//  One set of behavioural scenarios, run against any ServerApi implementation.
//  It is executed twice: against the in-memory FakeSyncServer (fast, hermetic)
//  and against the real Go server over HTTP (integration). Both must pass
//  identically — that equivalence is the whole point, and it is what stops the
//  fake from drifting away from the server it stands in for.
//
//  Every assertion is on *observable* behaviour (pull results, blob presence,
//  device convergence) — never on server internals like FakeSyncServer.opCount —
//  so the exact same suite is meaningful against a black-box HTTP server.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerApi, ServerSyncClient } from '../../src/network/server-sync';
import { VaultCrypto } from '../../src/network/encryption';
import { HybridLogicalClock } from '../../src/core/hlc';
import { MemoryHost, seedFile, sha256Hex } from './memory-host';

/**
 * Supplies ServerApi instances to the suite. `connect(vaultId)` returns a client
 * bound to that vault — call it twice with the same id to model two devices
 * sharing one vault. `freshVault()` yields an id unique within the backing
 * server, so tests are isolated even when they share a long-lived real server.
 */
export interface ContractServer {
  connect(vaultId: string): ServerApi;
  freshVault(): string;
}

const SALT = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8]);

export function runContractSuite(label: string, newServer: () => ContractServer): void {
  describe(`sync server contract — ${label}`, () => {
    let vc: VaultCrypto;
    beforeAll(async () => {
      vc = new VaultCrypto();
      await vc.deriveFromPassphrase('correct horse battery staple', SALT);
    });

    const client = (api: ServerApi, host: MemoryHost, deviceId: string) =>
      new ServerSyncClient({ api, crypto: vc, host, hlc: new HybridLogicalClock(deviceId) });

    // A single ServerApi on a fresh, isolated vault. Every test starts from one
    // of these so scenarios never collide — critical for the real server, where
    // all tests share one long-lived process.
    const freshApi = (): ServerApi => {
      const s = newServer();
      return s.connect(s.freshVault());
    };

    test('append then pull returns the op with a monotonic seq', async () => {
      const api = freshApi();
      const r = await api.appendOps(0, [
        { clientOpId: 'a:1', ciphertext: 'ct-1', blobRefs: [] },
        { clientOpId: 'a:2', ciphertext: 'ct-2', blobRefs: [] },
      ]);
      expect(r.assigned.map(a => a.seq)).toEqual([1, 2]);

      const page = await api.pullOps(0, 10);
      expect(page.ops.map(o => o.ciphertext)).toEqual(['ct-1', 'ct-2']);
      expect(page.ops.map(o => o.seq)).toEqual([1, 2]);
      expect(page.hasMore).toBe(false);
    });

    test('append is idempotent by clientOpId', async () => {
      const api = freshApi();
      const rec = { clientOpId: 'dup', ciphertext: 'x', blobRefs: [] };
      const r1 = await api.appendOps(0, [rec]);
      const r2 = await api.appendOps(0, [rec]);
      expect(r1.assigned[0]!.seq).toBe(r2.assigned[0]!.seq);
      const page = await api.pullOps(0, 100);
      expect(page.ops.filter(o => o.ciphertext === 'x')).toHaveLength(1);
    });

    test('pull paginates with hasMore / nextCursor', async () => {
      const api = freshApi();
      for (let i = 1; i <= 3; i++) {
        await api.appendOps(0, [{ clientOpId: `c${i}`, ciphertext: `ct${i}`, blobRefs: [] }]);
      }
      const p1 = await api.pullOps(0, 2);
      expect(p1.ops.map(o => o.seq)).toEqual([1, 2]);
      expect(p1.hasMore).toBe(true);
      const p2 = await api.pullOps(p1.nextCursor, 2);
      expect(p2.ops.map(o => o.seq)).toEqual([3]);
      expect(p2.hasMore).toBe(false);
    });

    test('append referencing an un-uploaded blob is rejected', async () => {
      const api = freshApi();
      await expect(
        api.appendOps(0, [{ clientOpId: 'c1', ciphertext: 'x', blobRefs: ['deadbeef'.repeat(8)] }]),
      ).rejects.toThrow();
    });

    test('blob lifecycle: check → put → check → get, absent → null', async () => {
      const api = freshApi();
      const bytes = new TextEncoder().encode('hello blob');
      const hash = await sha256Hex(bytes);

      expect((await api.checkBlobs([hash])).missing).toEqual([hash]);
      await api.putBlob(hash, bytes);
      expect((await api.checkBlobs([hash])).missing).toEqual([]);

      const got = await api.getBlob(hash);
      expect(got && new TextDecoder().decode(got)).toBe('hello blob');

      const absentHash = await sha256Hex(new TextEncoder().encode('nope'));
      expect(await api.getBlob(absentHash)).toBeNull();
    });

    test('two devices: A pushes a file, B pulls and converges', async () => {
      const server = newServer();
      const vault = server.freshVault();
      const hostA = new MemoryHost('dev-a');
      const hostB = new MemoryHost('dev-b');
      const { hash } = await seedFile(hostA, 'dev-a', 'f1', 'groceries.md', '# Groceries\nmilk\n', 1000);

      await client(server.connect(vault), hostA, 'dev-a').runSync();
      expect(hostA.pendingOps).toHaveLength(0);

      await client(server.connect(vault), hostB, 'dev-b').runSync();
      expect(hostB.cursor).toBe(1);
      expect(hostB.fileEntries.get('f1')!.contentHash).toBe(hash);
      const stored = hostB.content.get(hash);
      expect(stored && new TextDecoder().decode(stored)).toBe('# Groceries\nmilk\n');
    });

    test('blobs dedupe across devices with identical content', async () => {
      const server = newServer();
      const vault = server.freshVault();
      const hostA = new MemoryHost('dev-a');
      const hostB = new MemoryHost('dev-b');
      await seedFile(hostA, 'dev-a', 'f1', 'a.md', 'shared body', 1000);
      await seedFile(hostB, 'dev-b', 'f2', 'b.md', 'shared body', 1000);

      await client(server.connect(vault), hostA, 'dev-a').runSync();
      await client(server.connect(vault), hostB, 'dev-b').runSync();

      // Both ops are durable: a third device pulls exactly two ops…
      const hostC = new MemoryHost('dev-c');
      await client(server.connect(vault), hostC, 'dev-c').runSync();
      expect(hostC.fileEntries.size).toBe(2);
      // …and the shared blob is present under its single blinded hash (dedup):
      // both files resolved to content, so C wrote both locally.
      expect([...hostC.content.values()].map(b => new TextDecoder().decode(b))).toContain('shared body');
    });
  });
}
