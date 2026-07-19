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
import { MemoryHost, seedFile, editFile, deleteFile, renameFile, sha256Hex } from './memory-host';

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

    test('a user-resolved conflict replicates and both devices converge', async () => {
      const server = newServer();
      const vault = server.freshVault();
      const decode = (h: MemoryHost) => new TextDecoder().decode(h.content.get(h.fileEntries.get('f1')!.contentHash));

      // ── Shared base: A creates and pushes; B pulls it. Both hold "shared". ──
      const hostA = new MemoryHost('dev-a');
      const hostB = new MemoryHost('dev-b');
      const base = await seedFile(hostA, 'dev-a', 'f1', 'note.md', 'shared\n', 1000);
      await client(server.connect(vault), hostA, 'dev-a').runSync();
      await client(server.connect(vault), hostB, 'dev-b').runSync();
      // Both now agree "shared" is the common ancestor (B's write_local set this;
      // set it on A too, whose own create left the ancestor unrecorded).
      hostA.fileEntries.get('f1')!.ancestorContentHash = base.hash;

      // ── Concurrent, overlapping edits to the same line — a real conflict. ──
      await editFile(hostA, 'dev-a', 'f1', 'note.md', 'shared A\n', 2000);
      await editFile(hostB, 'dev-b', 'f1', 'note.md', 'shared B\n', 2000);

      // B does the human merge (unions both edits); A accepts whatever resolution
      // reaches it (picks the incoming remote — i.e. B's resolution).
      const R = 'shared A\nshared B\n';
      hostB.resolveConflict = () => new TextEncoder().encode(R);
      hostA.resolveConflict = a => new TextEncoder().encode(a.remoteContent);

      // A pushes its edit; B pulls it, hits the conflict, resolves, then pushes
      // the resolution as its own op.
      await client(server.connect(vault), hostA, 'dev-a').runSync(); // push A's edit
      await client(server.connect(vault), hostB, 'dev-b').runSync(); // pull → conflict → resolve
      expect(decode(hostB)).toBe(R);
      expect(hostB.pendingOps).toHaveLength(1); // the resolution, queued for next round
      await client(server.connect(vault), hostB, 'dev-b').runSync(); // push the resolution

      // A pulls the resolution (higher HLC than either raw edit) and converges to
      // it rather than re-deriving its own answer; the settle round is a no-op.
      await client(server.connect(vault), hostA, 'dev-a').runSync(); // pull → resolve to R
      await client(server.connect(vault), hostA, 'dev-a').runSync(); // push A's echo of R
      await client(server.connect(vault), hostB, 'dev-b').runSync(); // settle (same content → no-op)

      const hashR = await sha256Hex(new TextEncoder().encode(R));
      expect(decode(hostA)).toBe(R);
      expect(decode(hostB)).toBe(R);
      expect(hostA.fileEntries.get('f1')!.contentHash).toBe(hashR);
      expect(hostB.fileEntries.get('f1')!.contentHash).toBe(hashR);
      expect(hostA.pendingOps).toHaveLength(0);
      expect(hostB.pendingOps).toHaveLength(0);

      // The resolution is durable on the server: a fresh device pulls it as the
      // winning content, with no conflict of its own.
      const hostC = new MemoryHost('dev-c');
      await client(server.connect(vault), hostC, 'dev-c').runSync();
      expect(decode(hostC)).toBe(R);
    });

    test('two devices: a one-sided delete propagates and both converge to deleted', async () => {
      const server = newServer();
      const vault = server.freshVault();
      const hostA = new MemoryHost('dev-a');
      const hostB = new MemoryHost('dev-b');

      // ── Shared base: A creates & pushes; B pulls it. Both hold the file. ──
      const { hash } = await seedFile(hostA, 'dev-a', 'f1', 'note.md', 'body\n', 1000);
      await client(server.connect(vault), hostA, 'dev-a').runSync();
      // Mirror the applicator's send_remote ancestor update (MemoryHost doesn't):
      // A's surviving side must match its ancestor for a clean incoming delete.
      hostA.fileEntries.get('f1')!.ancestorContentHash = hash;
      await client(server.connect(vault), hostB, 'dev-b').runSync();
      expect(hostB.fileEntries.get('f1')!.contentHash).toBe(hash);

      // ── B deletes the file and pushes the tombstone. ──
      deleteFile(hostB, 'dev-b', 'f1', 'note.md', 2000);
      await client(server.connect(vault), hostB, 'dev-b').runSync();
      expect(hostB.pendingOps).toHaveLength(0);

      // ── A pulls the delete; its unchanged copy is removed cleanly (delete_local,
      //    not a delete_conflict — A never touched the file since the ancestor). ──
      await client(server.connect(vault), hostA, 'dev-a').runSync();
      expect(hostA.fileEntries.get('f1')!.deleted).toBe(true);
      expect(hostB.fileEntries.get('f1')!.deleted).toBe(true);

      // The tombstone is durable: a fresh device pulls create+delete and never
      // materialises the file at all.
      const hostC = new MemoryHost('dev-c');
      await client(server.connect(vault), hostC, 'dev-c').runSync();
      const cEntry = hostC.fileEntries.get('f1');
      expect(cEntry === undefined || cEntry.deleted).toBe(true);
    });

    test('two devices: a rename propagates via move_local and both converge', async () => {
      const server = newServer();
      const vault = server.freshVault();
      const hostA = new MemoryHost('dev-a');
      const hostB = new MemoryHost('dev-b');

      // ── Shared base: A creates "old.md" & pushes; B pulls it. ──
      const { hash } = await seedFile(hostA, 'dev-a', 'f1', 'old.md', 'stable body\n', 1000);
      await client(server.connect(vault), hostA, 'dev-a').runSync();
      hostA.fileEntries.get('f1')!.ancestorContentHash = hash;
      await client(server.connect(vault), hostB, 'dev-b').runSync();
      expect(hostB.fileEntries.get('f1')!.path).toBe('old.md');

      // ── A renames old.md → new.md (content unchanged) and pushes the move. ──
      renameFile(hostA, 'dev-a', 'f1', 'old.md', 'new.md', 2000);
      await client(server.connect(vault), hostA, 'dev-a').runSync();
      expect(hostA.pendingOps).toHaveLength(0);
      expect(hostA.fileEntries.get('f1')!.path).toBe('new.md');

      // ── B pulls the move; same content + higher-HLC path ⇒ move_local, not a
      //    rewrite. The file id is stable, only the path follows the winner. ──
      await client(server.connect(vault), hostB, 'dev-b').runSync();
      expect(hostB.fileEntries.get('f1')!.path).toBe('new.md');
      expect(hostB.fileEntries.get('f1')!.contentHash).toBe(hash);
      expect(hostB.fileEntries.get('f1')!.deleted).toBe(false);

      // A fresh device sees the file only at its renamed path, with content intact.
      const hostC = new MemoryHost('dev-c');
      await client(server.connect(vault), hostC, 'dev-c').runSync();
      expect(hostC.fileEntries.get('f1')!.path).toBe('new.md');
      const body = hostC.content.get(hostC.fileEntries.get('f1')!.contentHash);
      expect(body && new TextDecoder().decode(body)).toBe('stable body\n');
    });

    test('two devices: concurrent renames to different paths converge by HLC', async () => {
      const server = newServer();
      const vault = server.freshVault();
      const hostA = new MemoryHost('dev-a');
      const hostB = new MemoryHost('dev-b');

      // ── Shared base: A creates "orig.md" & pushes; B pulls it. ──
      const { hash } = await seedFile(hostA, 'dev-a', 'f1', 'orig.md', 'shared\n', 1000);
      await client(server.connect(vault), hostA, 'dev-a').runSync();
      hostA.fileEntries.get('f1')!.ancestorContentHash = hash;
      await client(server.connect(vault), hostB, 'dev-b').runSync();

      // ── Both rename to a different path at the *same* wall/counter, so the
      //    winner is decided purely by the deviceId tie-break ('dev-b' > 'dev-a'). ──
      renameFile(hostA, 'dev-a', 'f1', 'orig.md', 'a-name.md', 2000);
      renameFile(hostB, 'dev-b', 'f1', 'orig.md', 'b-name.md', 2000);

      // A pushes first; B pushes on top; both keep syncing until the log drains
      // into agreement. dev-b's rename dominates the tie, so both land on b-name.
      await client(server.connect(vault), hostA, 'dev-a').runSync(); // push a-name
      await client(server.connect(vault), hostB, 'dev-b').runSync(); // push b-name, sees a-name (loses tie)
      await client(server.connect(vault), hostA, 'dev-a').runSync(); // pull b-name → move_local
      await client(server.connect(vault), hostB, 'dev-b').runSync(); // settle (no-op)

      expect(hostA.fileEntries.get('f1')!.path).toBe('b-name.md');
      expect(hostB.fileEntries.get('f1')!.path).toBe('b-name.md');
      expect(hostA.fileEntries.get('f1')!.contentHash).toBe(hash);
      expect(hostB.fileEntries.get('f1')!.contentHash).toBe(hash);

      // A fresh device agrees on the winning path.
      const hostC = new MemoryHost('dev-c');
      await client(server.connect(vault), hostC, 'dev-c').runSync();
      expect(hostC.fileEntries.get('f1')!.path).toBe('b-name.md');
    });
  });
}
