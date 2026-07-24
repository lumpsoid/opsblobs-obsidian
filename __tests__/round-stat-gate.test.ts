// ─────────────────────────────────────────────
//  R1 — mtime/size round stat-gate (steady-state-round-optimization-spec §3)
// ─────────────────────────────────────────────
//
//  `PluginVaultSyncHost.buildLocalState()` snapshots the vault for every sync round.
//  Before R1 it unconditionally re-read + re-SHA-256'd EVERY live registry entry, so
//  a one-file delta hashed the whole vault (`sha256 ≈ F+1`, the accumulating CPU cost
//  the mobile-perf baseline flagged as A1/B1). R1 extends the *already-shipped* capture
//  stat-gate (O1, docs/capture-optimization-spec.md) into the round: a tracked file
//  whose on-disk `mtime + size` is unchanged since we last hashed it is staged from the
//  content store WITHOUT a read or a hash, so a routine round is O(touched), not O(F).
//
//  Driven through the REAL device stack (TestDevice over the in-memory fakes), exactly
//  like capture-stat-gate.test.ts. Two ground-truth counters prove the win:
//    · `FakeVaultFiles.io.reads` — a gated file issues no `files.read`.
//    · a wrapped `crypto.subtle.digest('SHA-256', …)` — a gated file issues no hash.
//  The correctness tests (2–4) assert the gate never trades a byte of data safety.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';
import { VaultState } from '../src/types';

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * The pre-A2 whole-vault snapshot, reconstructed from the split host API
 * (`buildLocalIdentity` for the stat-gate hash correction + `stageContent` of every
 * live file's bytes and every head's DAG-reachable bases). A2 moved staging into the
 * round scoped to touched files; these R1 tests still exercise the *gate* (which
 * lives in `buildLocalIdentity`) plus the store-miss disk fallback (in
 * `stageContent`), and staging all files reproduces the exact read/hash counts the
 * pre-split `buildLocalState` produced, so the assertions are unchanged.
 */
async function snapshot(d: TestDevice): Promise<VaultState> {
  const dag = await d.host.loadDag();
  const state = await d.host.buildLocalIdentity(dag);
  // This round's pending ops aren't in the persisted DAG yet — fold into a clone so a
  // fresh head reaches its bases for staging, exactly as the round does.
  const working = dag.clone();
  for (const op of d.opLogger.getPendingOps()) {
    if (op.type === 'move') continue;
    working.addVersion(op.id, op.parents, op.contentHash, op.fileId);
  }
  const hashes = new Set<string>();
  for (const e of state.fileEntries.values()) {
    if (e.deleted) continue;
    if (e.contentHash !== '') hashes.add(e.contentHash);
    if (e.headVersionId) for (const h of working.reachableContentHashes(e.headVersionId)) hashes.add(h);
  }
  await d.host.stageContent(state, hashes);
  return state;
}
const onDisk = async (d: TestDevice, path: string): Promise<string> => {
  const bytes = await d.files.read(path);
  return bytes ? new TextDecoder().decode(bytes) : '<deleted>';
};

/** Count the SHA-256 digests issued while `fn` runs — the objective the round's
 *  re-hash pass drives, mirroring the bench harness's `crypto.subtle.digest` wrap.
 *  Restores the real `digest` in a `finally` so a throw can't leave it patched. */
async function countSha256<T>(fn: () => Promise<T>): Promise<{ result: T; sha256: number }> {
  const subtle = crypto.subtle;
  const real = subtle.digest.bind(subtle);
  let sha256 = 0;
  subtle.digest = ((algo: AlgorithmIdentifier, data: BufferSource) => {
    const name = typeof algo === 'string' ? algo : algo.name;
    if (/sha-?256/i.test(name)) sha256++;
    return real(algo as AlgorithmIdentifier, data);
  }) as typeof subtle.digest;
  try {
    const result = await fn();
    return { result, sha256 };
  } finally {
    subtle.digest = real;
  }
}

describe('R1 round stat-gate', () => {
  // ── 1. THE WIN — a one-file delta hashes ≈1, not F ──────────────────────────
  test('a converged vault with one drifted file re-hashes exactly that file, gating the rest', async () => {
    const A = await TestDevice.create('dev-a');
    const F = 30;
    for (let i = 0; i < F; i++) await A.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);

    // Capture registers every file WITH its stat + head version → all F are gated.
    await A.opLogger.captureOfflineChanges();
    expect(A.activeEntries()).toHaveLength(F);

    // Baseline: with every entry gated, the whole snapshot hashes NOTHING and reads
    // nothing — the steady-state ideal (capture already did the O(touched) work).
    {
      const readsBefore = A.files.io.reads;
      const { sha256 } = await countSha256(async () => snapshot(A));
      expect(sha256).toBe(0);
      expect(A.files.io.reads - readsBefore).toBe(0);
    }

    // Now drift ONE file on disk with no event/capture (a raw write bumps mtime+size).
    // buildLocalState must fall through the gate for THAT file only: exactly 1 hash,
    // exactly 1 read — not F.
    await A.files.write('notes/n-7.md', enc('a much longer, changed body for n-7\n'));

    const readsBefore = A.files.io.reads;
    const { result: state, sha256 } = await countSha256(async () => snapshot(A));
    expect(sha256).toBe(1);                       // ≈1, NOT F+1 — the R1 win
    expect(A.files.io.reads - readsBefore).toBe(1);

    // Fall-through path still self-corrects the snapshot to the real disk hash so the
    // merge compares true content (the un-opped-edit safeguard, §5.1).
    const drifted = [...state.fileEntries.values()].find(e => e.path === 'notes/n-7.md')!;
    expect(state.contentStore.has(drifted.contentHash)).toBe(true);
  });

  // ── 5/fall-through — a never-captured (stat-absent) entry takes the read path ──
  test('an entry with no recorded stat falls through to read + hash (no false gating)', async () => {
    const A = await TestDevice.create('dev-a');
    // seedFile drives the ONLINE create handler, which records a head version but NOT
    // a stat (only capture does) — so `entry.mtime` is undefined and the strict `===`
    // fails to gate: the file is read + hashed exactly as before.
    await A.seedFile('a.md', 'body\n', 1000);
    expect(A.entryByPath('a.md')!.mtime).toBeUndefined();

    const readsBefore = A.files.io.reads;
    const { sha256 } = await countSha256(async () => snapshot(A));
    expect(sha256).toBe(1);                       // hashed, not silently trusted
    expect(A.files.io.reads - readsBefore).toBe(1);
  });

  describe('data safety with the gate active', () => {
    let vc: VaultCrypto;
    beforeAll(async () => {
      vc = new VaultCrypto();
      await vc.deriveFromPassphrase('correct horse battery staple',
        new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]));
    });
    const client = (api: FakeSyncServer, d: TestDevice) =>
      new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

    // ── 2. NO DATA LOSS — a genuine concurrent divergence still conflicts, gate on ─
    test('two devices editing the same file off a shared base still three-way merge; both edits survive', async () => {
      const api = new FakeSyncServer();
      const A = await TestDevice.create('dev-a');
      const B = await TestDevice.create('dev-b');

      await A.seedFile('note.md', 'L1\nL2\nL3\n', 1000);
      await client(api, A).runSync();
      await client(api, B).runSync();

      // Both edit concurrently. A's edit stays local; B pushes first.
      await A.editFile('note.md', 'A1\nL2\nL3\n', 2000);
      await B.editFile('note.md', 'L1\nL2\nB3\n', 3000);
      await client(api, B).runSync();

      // Capture BEFORE A's round self-heals A's stat, so A's note.md is genuinely
      // GATED in buildLocalState (staged from the store under its real head hash) —
      // this is what actually exercises R1 on a diverging file.
      await A.opLogger.captureOfflineChanges();
      expect(A.entryByPath('note.md')!.mtime).toBeDefined();

      await client(api, A).runSync();

      // The two edits touch different lines → a CLEAN three-way merge. The gate must
      // not have aliased a stale base over A's edit: the merge sees both real versions
      // and keeps BOTH (A1 + B3), with no silent adoption of B and no marker noise.
      const merged = await onDisk(A, 'note.md');
      expect(merged).toContain('A1');
      expect(merged).toContain('B3');
      expect(merged).not.toContain('<<<<<<<');
      expect(A.applied.some(a => a.type === 'write_merge')).toBe(true);

      // Both devices converge to the identical merged bytes.
      await client(api, A).runSync();
      await client(api, B).runSync();
      expect(await onDisk(B, 'note.md')).toBe(merged);
    });

    // ── 3. F5 PRESERVED — an in-window edit is not clobbered, gate on ────────────
    test('an edit landing after the (gated) snapshot but before apply is deferred, not overwritten', async () => {
      const api = new FakeSyncServer();
      const A = await TestDevice.create('dev-a');
      const B = await TestDevice.create('dev-b');
      const path = 'note.md';

      await A.seedFile(path, 'L1\nL2\nL3\n', 1000);
      await client(api, A).runSync();
      await client(api, B).runSync();

      await B.editFile(path, 'L1\nL2\nB3\n', 2000);
      await client(api, B).runSync();

      // Make A's base file GATED for the upcoming round (stat recorded), so the
      // snapshot trusts entry.contentHash — the drift check must STILL fire at apply.
      await A.opLogger.captureOfflineChanges();
      expect(A.entryByPath(path)!.mtime).toBeDefined();

      // In the window after buildLocalState, A's user edits the file (disk only).
      A.setWall(3000);
      const realApply = A.host.applyMerge.bind(A.host);
      let injected = false;
      A.host.applyMerge = async (actions, local, remote) => {
        if (!injected) { injected = true; await A.files.write(path, enc('A1\nL2\nL3\n')); }
        return realApply(actions, local, remote);
      };

      await client(api, A).runSync();

      // F5: the in-window edit survives on disk and is re-captured — NOT overwritten
      // by B's pulled content, even though the snapshot had gated the pre-edit bytes.
      expect(await onDisk(A, path)).toBe('A1\nL2\nL3\n');
      expect(A.pendingOps.some(op => op.path === path)).toBe(true);

      // Next round three-way merges: neither edit lost.
      A.host.applyMerge = realApply;
      await client(api, A).runSync();
      const finalA = await onDisk(A, path);
      expect(finalA).toContain('A1');
      expect(finalA).toContain('B3');
    });

    // ── 4. STORE-MISS FALLBACK — a gated file with no blob still stages its bytes ──
    test('a gated file whose content-store blob is absent falls back to a disk read (no hash)', async () => {
      const A = await TestDevice.create('dev-a');
      await A.seedExistingFile('a.md', 'body of a\n');
      await A.seedExistingFile('b.md', 'body of b\n');
      await A.opLogger.captureOfflineChanges();       // both gated, blobs in the store

      const aHash = A.entryByPath('a.md')!.contentHash;
      // Evict a.md's blob from the content store (memCache + disk) so the gate's
      // `contentStore.get` misses and must fall back to a raw disk read.
      await A.contentStore.delete(aHash);
      expect(await A.contentStore.has(aHash)).toBe(false);

      const readsBefore = A.files.io.reads;
      const { result: state, sha256 } = await countSha256(async () => snapshot(A));

      // Still zero hashes (the stat says unchanged — no re-hash on the fallback), and
      // the missing blob was staged from disk so the merge sees a.md's bytes.
      expect(sha256).toBe(0);
      expect(A.files.io.reads - readsBefore).toBe(1);  // exactly the one store miss
      expect(state.contentStore.has(aHash)).toBe(true);
      expect(new TextDecoder().decode(state.contentStore.get(aHash)!)).toBe('body of a\n');
    });
  });
});
