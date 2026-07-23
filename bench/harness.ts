// ─────────────────────────────────────────────
//  Bench harness — Layer-1 (CPU/alloc) + Layer-2 (I/O counts) utilities
// ─────────────────────────────────────────────
//
//  The measurement infrastructure for docs/mobile-perf-baseline-spec.md. Drives the
//  REAL production stack (via `TestDevice` / `ServerSyncClient` / `FakeSyncServer`)
//  over in-memory fakes, so a benchmark exercises production code — never a
//  reimplementation (testing doctrine, engineering guide §8). Nothing here is
//  shipped; it lives under `bench/` and runs via `npm run bench`.
//
//  Three kinds of number (spec §3):
//    · Layer 1 — wall time + heap delta (this file's `time()` / `measure()`), run
//      under `node --expose-gc` so `global.gc()` makes the heap delta meaningful.
//      A Layer-1 wall time is a *relative* signal only — never the mobile number.
//    · Layer 2 — device-independent I/O counts, read straight off the fakes' `io`
//      counters and the CPU-op counters this module installs by monkey-patching
//      `crypto.subtle` + the `VersionDag` prototype (external, no production edit —
//      spec §7.2 prefers wrapping in the harness over touching shipped code).

import { TestDevice } from '../__tests__/helpers/test-device';
import { FakeSyncServer } from '../src/network/fake-server';
import { ServerSyncClient } from '../src/network/server-sync';
import { PhaseTimingSink } from '../src/network/perf-timer';
import { VaultCrypto } from '../src/network/encryption';
import { VersionDag } from '../src/core/version-dag';
import {
  IoCounters, newIoCounters, snapshotIoCounters, diffIoCounters,
} from '../__tests__/helpers/fakes/io-counters';

export { snapshotIoCounters, diffIoCounters };

// A fixed salt so runs are reproducible; the passphrase never leaves the bench.
const SALT = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

// ─── Layer 1: timing + allocation ──────────────────────────────────────────────

const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;

export function nowMs(): number {
  return performance.now();
}

/** Time a single async op. Returns wall ms and the heap-delta (MB) it retained —
 *  a pre-op `global.gc()` (needs `--expose-gc`) makes the delta a real signal
 *  rather than GC noise. The delta is net-retained + not-yet-collected transient
 *  (an over-approximation of true transient peak, which needs sampling), so it is
 *  reported as an approximate proxy, not an exact peak. */
export async function measure(fn: () => Promise<void>): Promise<{ ms: number; heapMB: number }> {
  if (gc) gc();
  const before = process.memoryUsage().heapUsed;
  const t0 = nowMs();
  await fn();
  const t1 = nowMs();
  const after = process.memoryUsage().heapUsed;
  return { ms: t1 - t0, heapMB: (after - before) / 1e6 };
}

/** Median wall time (ms) over `iters` runs of `fn` — a stable Layer-1 signal that
 *  smooths JIT warm-up and GC jitter. `iters` defaults to 5. */
export async function medianMs(fn: () => Promise<void>, iters = 5): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = nowMs();
    await fn();
    times.push(nowMs() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/** Resident set size (MB) — used post-GC to sample session-lifetime growth (B6). */
export function rssMB(): number {
  if (gc) gc();
  return process.memoryUsage().rss / 1e6;
}

/** Post-GC retained heap (MB) — a finer session-growth signal than RSS (which is
 *  dominated by the V8 baseline). What survives a `global.gc()` is genuinely
 *  reachable, so a monotonic climb here across rounds is the unbounded-cache
 *  signature (B6). */
export function heapUsedMB(): number {
  if (gc) gc();
  return process.memoryUsage().heapUsed / 1e6;
}

// ─── Layer 2: CPU-op counters (external monkey-patch, no production change) ──────

export interface CpuCounters {
  /** SHA-256 digests (`crypto.subtle.digest('SHA-256', …)`) — content hashing. */
  sha256: number;
  /** AES-GCM encrypts (op + blob sealing). */
  aesEncrypt: number;
  /** AES-GCM decrypts (op + blob opening). */
  aesDecrypt: number;
  /** PBKDF2 key derivations (`deriveKey`/`deriveBits`) — the one-time passphrase cost. */
  pbkdf2: number;
  /** `VersionDag.isAncestor` calls (a full parent-DFS each). */
  dagIsAncestor: number;
  /** `VersionDag.mergeBase` calls (LCA; its `common²` filter walks isAncestor). */
  dagMergeBase: number;
  /** `VersionDag.leaves` calls (a full node scan each). */
  dagLeaves: number;
  /** `VersionDag.reachableContentHashes` calls (a full ancestor walk each). */
  dagReachable: number;
}

export function newCpuCounters(): CpuCounters {
  return {
    sha256: 0, aesEncrypt: 0, aesDecrypt: 0, pbkdf2: 0,
    dagIsAncestor: 0, dagMergeBase: 0, dagLeaves: 0, dagReachable: 0,
  };
}

let installed: CpuCounters | null = null;

/** Patch `crypto.subtle` and the `VersionDag` prototype to tally CPU-bound ops.
 *  Idempotent — returns the same live counter object on repeat calls. Device-
 *  independent: these counts are identical on a laptop and a phone (spec §3, "the
 *  most portable signal"). */
export function installInstrumentation(): CpuCounters {
  if (installed) return installed;
  const c = newCpuCounters();
  installed = c;

  const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => unknown>;
  const nameOf = (algo: unknown): string =>
    typeof algo === 'string' ? algo : (algo as { name?: string })?.name ?? '';

  const wrap = (method: string, bump: (algo: unknown) => void) => {
    const orig = subtle[method]!.bind(crypto.subtle);
    subtle[method] = (...args: unknown[]) => { bump(args[0]); return orig(...args); };
  };
  wrap('digest', a => { if (/sha-?256/i.test(nameOf(a))) c.sha256++; });
  wrap('encrypt', a => { if (/aes-gcm/i.test(nameOf(a))) c.aesEncrypt++; });
  wrap('decrypt', a => { if (/aes-gcm/i.test(nameOf(a))) c.aesDecrypt++; });
  wrap('deriveKey', a => { if (/pbkdf2/i.test(nameOf(a))) c.pbkdf2++; });
  wrap('deriveBits', a => { if (/pbkdf2/i.test(nameOf(a))) c.pbkdf2++; });

  const proto = VersionDag.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const wrapDag = (method: string, key: keyof CpuCounters) => {
    const orig = proto[method]!;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      c[key]++;
      return orig.apply(this, args);
    };
  };
  wrapDag('isAncestor', 'dagIsAncestor');
  wrapDag('mergeBase', 'dagMergeBase');
  wrapDag('leaves', 'dagLeaves');
  wrapDag('reachableContentHashes', 'dagReachable');

  return c;
}

export function snapshotCpu(c: CpuCounters): CpuCounters { return { ...c }; }
export function diffCpu(before: CpuCounters, after: CpuCounters): CpuCounters {
  const out = newCpuCounters();
  for (const k of Object.keys(out) as (keyof CpuCounters)[]) out[k] = after[k] - before[k];
  return out;
}

// ─── Combined I/O snapshot across both fakes ────────────────────────────────────

export interface VaultIo { meta: IoCounters; files: IoCounters }

export function snapshotVaultIo(dev: TestDevice): VaultIo {
  return { meta: snapshotIoCounters(dev.metadata.io), files: snapshotIoCounters(dev.files.io) };
}

export function diffVaultIo(before: VaultIo, after: VaultIo): VaultIo {
  return {
    meta: diffIoCounters(before.meta, after.meta),
    files: diffIoCounters(before.files, after.files),
  };
}

// ─── Crypto + client wiring (the real ServerSyncClient) ─────────────────────────

export async function makeCrypto(): Promise<VaultCrypto> {
  const vc = new VaultCrypto();
  await vc.deriveFromPassphrase('bench-passphrase-do-not-ship', SALT);
  return vc;
}

export function makeClient(
  api: FakeSyncServer,
  crypto: VaultCrypto,
  dev: TestDevice,
  perfLog?: PhaseTimingSink,
): ServerSyncClient {
  return new ServerSyncClient({ api, crypto, host: dev.host, hlc: dev.hlc, perfLog });
}

// ─── Seeding helpers (loop the real op-logger path) ─────────────────────────────

/** ~`bytes` of deterministic, line-oriented text with mostly-unique lines (so a
 *  three-way merge stays on the fast path, not the diff3 O(L²) cliff). `key` seeds
 *  the line contents so distinct files/versions differ. */
export function makeText(bytes: number, key: string): string {
  const lines: string[] = [];
  let size = 0;
  let n = 0;
  while (size < bytes) {
    const line = `${key}:${n}:the quick brown fox jumps over lazy dog ${n * 2654435761 % 1_000_000}`;
    lines.push(line);
    size += line.length + 1;
    n++;
  }
  return lines.join('\n') + '\n';
}

/** A pathological low-unique-line file: `lines` copies of the same short line —
 *  drives the diff3 Myers O(L_a·L_b) DP fallback (spec B8). */
export function makeRepetitiveText(lines: number): string {
  return (`same repeated line\n`).repeat(lines);
}

/** Seed F files of ~B bytes each through the genuine create path (id assignment,
 *  hashing, op emission, registry + content + oplog writes). Returns the file ids.
 *  This IS the B3/B5 write-amplification workload when measured. */
export async function seedVault(dev: TestDevice, F: number, B: number, wallStart = 1000): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < F; i++) {
    ids.push(await dev.seedFile(`notes/note-${i}.md`, makeText(B, `f${i}`), wallStart + i));
  }
  return ids;
}

/** Place F files on disk WITHOUT events/ops (models pre-existing files a fresh
 *  enable must capture). Exercise the cold-start path via `captureOfflineChanges`. */
export async function seedExistingVault(dev: TestDevice, F: number, B: number): Promise<void> {
  for (let i = 0; i < F; i++) {
    await dev.seedExistingFile(`notes/note-${i}.md`, makeText(B, `f${i}`));
  }
}

/** Bring a device to convergence with the server (push everything, save cursor). */
export async function syncToConvergence(client: ServerSyncClient): Promise<void> {
  await client.runSync();
}

/** Push a device's pending ops to the server WITHOUT a pulling/merging round —
 *  faithfully reproducing the wire push (encrypt op, upload blob, append) so several
 *  devices can each land a concurrent head off a shared base while mutually offline
 *  (nobody pulls the others). This manufactures the genuine multi-head divergence
 *  B7 needs; a normal `runSync` would pull-and-reconcile siblings first and collapse
 *  the very concurrency we want to measure. */
export async function pushOffline(server: FakeSyncServer, crypto: VaultCrypto, dev: TestDevice): Promise<void> {
  const local = await dev.host.buildLocalState();
  for (const op of local.pendingOps) {
    const refs: string[] = [];
    if (op.type !== 'delete') {
      const content = local.contentStore.get(op.contentHash);
      if (content) {
        const blinded = await crypto.blindHash(op.contentHash);
        await server.putBlob(blinded, await crypto.encryptBlob(content));
        refs.push(blinded);
      }
    }
    await server.appendOps(0, [{ clientOpId: op.id, ciphertext: await crypto.encryptOp(op), blobRefs: refs }]);
  }
}
