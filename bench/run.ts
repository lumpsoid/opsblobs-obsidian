// ─────────────────────────────────────────────
//  Bench runner — Layers 1 & 2 of the mobile perf baseline
// ─────────────────────────────────────────────
//
//  Implements scenarios B1–B9 (docs/mobile-perf-baseline-spec.md §5) against the
//  vault profiles in §2, driving the REAL sync stack over in-memory fakes. Emits a
//  machine-readable results JSON and a Markdown table (spec §7.4 / §8), and prints
//  a per-scenario summary. Run it with:
//
//      npm run bench                 # default profiles: xs, s, m
//      BENCH_PROFILES=xs,s,m,l npm run bench
//
//  Reminder (spec §4): the wall-time / heap numbers here are Layer-1 — a *relative*
//  regression signal, NEVER the mobile number. The op-counts and byte-counts are
//  Layer-2 — device-independent and exact. Absolute on-device time comes from the
//  Layer-3 manual pass (the `perfLog` setting), recorded separately in the baseline.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestDevice } from '../__tests__/helpers/test-device';
import { FakeSyncServer } from '../src/network/fake-server';
import { threeWayMerge } from '../src/merge/diff3';
import { METADATA_WRITE_FS_AMPLIFICATION } from '../__tests__/helpers/fakes/io-counters';
import {
  measure, medianMs, nowMs, rssMB, heapUsedMB,
  installInstrumentation, snapshotCpu, diffCpu,
  snapshotVaultIo, diffVaultIo,
  makeCrypto, makeClient, makeText, makeRepetitiveText,
  seedVault, seedExistingVault, pushOffline,
} from './harness';

// ─── Profiles (spec §2) ─────────────────────────────────────────────────────────

interface Profile { name: string; F: number; B: number }
const ALL_PROFILES: Record<string, Profile> = {
  xs: { name: 'XS', F: 50, B: 2_048 },
  s: { name: 'S', F: 500, B: 4_096 },
  m: { name: 'M', F: 2_000, B: 6_144 },
  l: { name: 'L', F: 10_000, B: 8_192 },
  xl: { name: 'XL', F: 20_000, B: 8_192 },
};

const selected = (process.env.BENCH_PROFILES ?? 'xs,s,m')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PROFILES: Profile[] = selected.map(k => {
  const p = ALL_PROFILES[k];
  if (!p) { console.warn(`[bench] unknown profile '${k}' — skipping`); return null; }
  return p;
}).filter((p): p is Profile => p !== null);

// ─── Scenario / sweep selectors (constrained-host escape hatches) ─────────────────
// A phone under Termux can't run the whole sweep — BENCH_FULL's K=1000 point alone
// builds ~20k hashed edits *of setup* per scenario (B2/B2b/B4), which reads as an
// "eternity" hang on mobile. These let a run pick a subset that actually completes:
//   BENCH_ONLY=b1,b3     run only these scenarios (default: all)
//   BENCH_K=20           override the B2/B2b/B4 K-sweep (default: [20,50], full: [20,50,200,1000])
//   BENCH_ROUNDS=10      B6 session length (default: 50)
//   BENCH_C=3,5          override the B7 concurrency sweep (default: [3,5,10])
const ONLY = (process.env.BENCH_ONLY ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const want = (name: string): boolean => ONLY.length === 0 || ONLY.includes(name);
const parseNums = (v: string | undefined, fallback: number[]): number[] =>
  v ? v.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0) : fallback;
const K_SWEEP = parseNums(process.env.BENCH_K, process.env.BENCH_FULL ? [20, 50, 200, 1000] : [20, 50]);
const B6_ROUNDS = Math.max(1, Number(process.env.BENCH_ROUNDS ?? 50));
const C_SWEEP = parseNums(process.env.BENCH_C, [3, 5, 10]);

// ─── Result rows ────────────────────────────────────────────────────────────────

interface Row {
  scenario: string;
  variant: string;
  /** Exact, device-independent Layer-2 counts. */
  counts: Record<string, number>;
  /** Layer-1 relative signals (wall ms, heap MB). */
  timing: Record<string, number>;
  note?: string;
}
const rows: Row[] = [];
function record(row: Row): void {
  rows.push(row);
  const c = Object.entries(row.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  const t = Object.entries(row.timing).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' ');
  console.log(`  ${row.scenario} ${row.variant.padEnd(20)} | ${c}  [${t}]`);
}

const cpu = installInstrumentation();

// A helper: measure one operation, capturing L1 timing + L2 CPU + I/O deltas.
async function profileOp(dev: TestDevice, fn: () => Promise<void>): Promise<{
  ms: number; heapMB: number; cpu: ReturnType<typeof diffCpu>; io: ReturnType<typeof diffVaultIo>;
}> {
  const cpu0 = snapshotCpu(cpu);
  const io0 = snapshotVaultIo(dev);
  const { ms, heapMB } = await measure(fn);
  return { ms, heapMB, cpu: diffCpu(cpu0, snapshotCpu(cpu)), io: diffVaultIo(io0, snapshotVaultIo(dev)) };
}

// ─── B1 — steady-state round vs F (buildLocalState re-read/re-hash) ──────────────

async function b1(p: Profile): Promise<void> {
  const server = new FakeSyncServer();
  const crypto = await makeCrypto();
  const dev = await TestDevice.create('b1');
  await seedVault(dev, p.F, p.B);
  await makeClient(server, crypto, dev).runSync();     // converge
  // Warm the stat cache: `seedVault` drives ONLINE creates, which record a head but
  // no mtime/size, so the FIRST capture is an O(F) stat-recording pass. A synced
  // vault is past that — one warm capture records every file's stat, modelling the
  // steady state the round optimization targets. Outside the profiled region.
  await dev.opLogger.captureOfflineChanges();

  // A one-file edit, then the real per-edit sync sequence: the coordinator always
  // runs `captureOfflineChanges` (the mtime/size drift scan) *before* the round
  // (sync-coordinator.ts:110-114), so profile that prelude + the round together —
  // measuring the round alone models a sequence production never runs. Post R1 both
  // the capture pass and the round's buildLocalState share the mtime/size gate, so
  // the whole sequence hashes ≈1 (the one edited file), not ≈F.
  await dev.editFile('notes/note-0.md', makeText(p.B, 'f0-edit'), 5_000_000);
  const r = await profileOp(dev, async () => {
    await dev.opLogger.captureOfflineChanges();
    await makeClient(server, crypto, dev).runSync();
  });

  record({
    scenario: 'B1', variant: `${p.name} F=${p.F}`,
    counts: {
      fileReads: r.io.files.reads, sha256: r.cpu.sha256,
      metaWrites: r.io.meta.writes, bytesWritten: r.io.meta.bytesWritten,
    },
    timing: { roundMs: r.ms, heapMB: r.heapMB },
    note: `capture+round hashes ≈ 1, not F (F=${p.F})`,
  });
}

// ─── B2 — round vs history H (DAG walks) ─────────────────────────────────────────

async function b2(K: number): Promise<void> {
  const FILES = 20;
  const server = new FakeSyncServer();
  const crypto = await makeCrypto();
  const A = await TestDevice.create('b2-a');
  const B = await TestDevice.create('b2-b');

  await seedVault(A, FILES, 2_048);
  await makeClient(server, crypto, A).runSync();
  await makeClient(server, crypto, B).runSync();       // B receives the base

  // A builds deep per-file lineage (H ≈ FILES·K), pushes it all.
  let wall = 1_000_000;
  for (let k = 0; k < K; k++) {
    for (let i = 0; i < FILES; i++) {
      await A.editFile(`notes/note-${i}.md`, makeText(2_048, `a-${i}-${k}`), wall++);
    }
  }
  await makeClient(server, crypto, A).runSync();

  // B edits each file once concurrently, then syncs → the merge computes
  // mergeBase(deep A lineage, B edit) per divergent file. Measure B's round.
  for (let i = 0; i < FILES; i++) {
    await B.editFile(`notes/note-${i}.md`, makeText(2_048, `b-${i}`), 900_000 + i);
  }
  const r = await profileOp(B, () => makeClient(server, crypto, B).runSync().then(() => {}));

  record({
    scenario: 'B2', variant: `deep-history K=${K} H≈${FILES * K}`,
    counts: {
      dagMergeBase: r.cpu.dagMergeBase, dagIsAncestor: r.cpu.dagIsAncestor,
      dagReachable: r.cpu.dagReachable, sha256: r.cpu.sha256,
    },
    timing: { mergeRoundMs: r.ms, heapMB: r.heapMB },
    note: 'mergeBase super-linear in lineage depth?',
  });
}

// ─── B2b — mergeBase's common² filter (deep SHARED backbone, tip divergence) ─────
//
// B2 diverges at the create version, so each file's LCA `common` set is size 1 and
// mergeBase's `common.filter(common.some(isAncestor))` (version-dag.ts:165) does ~0
// work — B2 measures the ancestors()-walk/rehash cost, NOT this quadratic filter
// (its `isAncestor/mergeBase` ratio stays flat ~1). B2b moves the divergence to the
// TIP of a deep shared backbone: both devices fast-forward onto a depth-K lineage,
// then each makes one concurrent edit, so mergeBase(a1,b1) sees a `common` set of
// size ≈ K. This is the topology that actually exercises the filter. The signature:
// `mergeBase` call count stays constant (≈ per-file) while `isAncestor` scales as
// ≈ FILES·(2K+1) — the ratio climbs linearly with depth (measured 11→41→161→321→641
// at K=5/20/80/160/320), and the round goes super-linear in wall time (≈ O(K²) work
// over constant files). fileReads/reachable stay FLAT — the complement of B2.
async function b2b(K: number): Promise<void> {
  const FILES = 20;
  const server = new FakeSyncServer();
  const crypto = await makeCrypto();
  const A = await TestDevice.create('b2b-a');
  const B = await TestDevice.create('b2b-b');

  await seedVault(A, FILES, 2_048);
  await makeClient(server, crypto, A).runSync();
  await makeClient(server, crypto, B).runSync();       // both at the create version v0

  // A builds a deep backbone (depth K) and pushes it; B pulls the whole chain and
  // FAST-FORWARDS to the tip vK — so the backbone is genuinely SHARED ancestry.
  let wall = 1_000_000;
  for (let k = 0; k < K; k++)
    for (let i = 0; i < FILES; i++)
      await A.editFile(`notes/note-${i}.md`, makeText(2_048, `bb-${i}-${k}`), wall++);
  await makeClient(server, crypto, A).runSync();
  await makeClient(server, crypto, B).runSync();       // B fast-forwards to vK (shared)

  // Tip divergence: A edits once more and pushes (a1 = vK→child); B edits once
  // concurrently off vK (b1), then syncs → mergeBase(b1,a1) with common ≈ {v0..vK}.
  for (let i = 0; i < FILES; i++)
    await A.editFile(`notes/note-${i}.md`, makeText(2_048, `a-tip-${i}`), 2_000_000 + i);
  await makeClient(server, crypto, A).runSync();
  for (let i = 0; i < FILES; i++)
    await B.editFile(`notes/note-${i}.md`, makeText(2_048, `b-tip-${i}`), 2_500_000 + i);

  const r = await profileOp(B, () => makeClient(server, crypto, B).runSync().then(() => {}));
  const isAncPerBase = Math.round((r.cpu.dagIsAncestor / Math.max(1, r.cpu.dagMergeBase)) * 100) / 100;
  record({
    scenario: 'B2b', variant: `deep-shared-backbone K=${K} H≈${FILES * K}`,
    counts: {
      dagMergeBase: r.cpu.dagMergeBase, dagIsAncestor: r.cpu.dagIsAncestor,
      isAncPerBase, dagReachable: r.cpu.dagReachable, fileReads: r.io.files.reads,
    },
    timing: { mergeRoundMs: r.ms, heapMB: r.heapMB },
    note: 'common ≈ K → mergeBase O(common²) filter bites: isAncPerBase climbs ~2K, mergeBase/reads flat',
  });
}

// ─── B3 — cold startup vs F (captureOfflineChanges) ──────────────────────────────

async function b3(p: Profile): Promise<void> {
  const dev = await TestDevice.create('b3');
  await seedExistingVault(dev, p.F, p.B);              // files on disk, no ops
  const fresh = await dev.reload();                    // fresh stack over the same disk

  const r = await profileOp(fresh, () => fresh.opLogger.captureOfflineChanges());
  record({
    scenario: 'B3', variant: `${p.name} F=${p.F}`,
    counts: {
      sha256: r.cpu.sha256, fileReads: r.io.files.reads,
      metaWrites: r.io.meta.writes, registryBytes: r.io.meta.bytesWritten,
      fsSyscalls: r.io.meta.writes * METADATA_WRITE_FS_AMPLIFICATION,
    },
    timing: { captureMs: r.ms, heapMB: r.heapMB },
    note: 'O(F·B) hash + up to O(F²) registry bytes',
  });
}

// ─── B4 — cold pull / DAG rebuild vs H ───────────────────────────────────────────

async function b4(K: number): Promise<void> {
  const FILES = 20;
  const H = FILES + FILES * K;
  const server = new FakeSyncServer();
  const crypto = await makeCrypto();
  const A = await TestDevice.create('b4-a');
  await seedVault(A, FILES, 2_048);
  let wall = 1_000_000;
  for (let k = 0; k < K; k++)
    for (let i = 0; i < FILES; i++)
      await A.editFile(`notes/note-${i}.md`, makeText(2_048, `a-${i}-${k}`), wall++);
  await makeClient(server, crypto, A).runSync();       // server now holds ≈H ops

  // A fresh joining device pulls the whole log from cursor 0.
  const B = await TestDevice.create('b4-b');
  const r = await profileOp(B, () => makeClient(server, crypto, B).runSync().then(() => {}));
  record({
    scenario: 'B4', variant: `join H≈${H} (ops=${server.opCount})`,
    counts: {
      aesDecrypt: r.cpu.aesDecrypt, sha256: r.cpu.sha256,
      metaWrites: r.io.meta.writes, metaAppends: r.io.meta.appends,
    },
    timing: { coldPullMs: r.ms, heapMB: r.heapMB },
    note: 'O(H) decrypts + O(H) in-memory ops on first join',
  });
}

// ─── B5 — write amplification per round / per op (L2 only) ───────────────────────

async function b5(p: Profile): Promise<void> {
  // Batch capture: seed F files on disk, then capture them all in one pass.
  const dev = await TestDevice.create('b5');
  await seedExistingVault(dev, p.F, p.B);
  const fresh = await dev.reload();
  const io0 = snapshotVaultIo(fresh);
  await fresh.opLogger.captureOfflineChanges();
  const io = diffVaultIo(io0, snapshotVaultIo(fresh));

  record({
    scenario: 'B5', variant: `${p.name} batch-capture F=${p.F}`,
    counts: {
      metaWrites: io.meta.writes, metaAppends: io.meta.appends, metaRemoves: io.meta.removes,
      fsSyscalls: io.meta.writes * METADATA_WRITE_FS_AMPLIFICATION + io.meta.removes + io.meta.appends,
      bytesWritten: io.meta.bytesWritten, bytesAppended: io.meta.bytesAppended,
      writesPerFile: Math.round((io.meta.writes / p.F) * 10) / 10,
    },
    timing: {},
    note: 'registry rewrites O(F) per file → O(F²) per batch; journal is delta-sized',
  });
}

// ─── B6 — memory over a session (unbounded memCache) ─────────────────────────────

async function b6(p: Profile, rounds = 50): Promise<void> {
  const server = new FakeSyncServer();
  const crypto = await makeCrypto();
  const dev = await TestDevice.create('b6');
  // Need ≥`rounds` distinct files to touch a fresh one each round; each edit stages
  // NEW distinct content into ContentStore.memCache, which is never cleared.
  await seedVault(dev, Math.max(p.F, rounds), p.B);
  await makeClient(server, crypto, dev).runSync();

  const heap0 = heapUsedMB();
  const rss0 = rssMB();
  let wall = 6_000_000;
  for (let r = 0; r < rounds; r++) {
    // Fresh distinct content every round (a unique key) → a new memCache entry.
    await dev.editFile(`notes/note-${r}.md`, makeText(p.B, `r${r}-${wall}`), wall++);
    await makeClient(server, crypto, dev).runSync();
  }
  const heap1 = heapUsedMB();
  const rss1 = rssMB();
  record({
    scenario: 'B6', variant: `${p.name} ${rounds} rounds`,
    counts: {},
    timing: {
      heapStartMB: heap0, heapEndMB: heap1, heapGrowthMB: heap1 - heap0,
      rssGrowthMB: rss1 - rss0,
    },
    note: 'ContentStore.memCache never cleared → post-GC heap grows toward total distinct content',
  });
}

// ─── B7 — concurrent-head fold vs C (reconcileConcurrentHeads) ───────────────────
//
// The fold loop re-runs the FULL `buildLocalState()` (whole-vault re-read + re-hash +
// base staging) once per fold — so its hypothesised cost is O(folds·(F·B + G)), the
// F·B term being the whole-vault rebuild, NOT just the one concurrent file. To make
// that term observable we seed a background vault of `B7_BG` quiet files alongside the
// single wide-concurrency file: every fold re-reads all of them even though only
// `note.md` diverges. Without a background vault (F=1) the per-fold rebuild reads one
// file and the O(C·F) curve is invisible — the whole point of B7. The device-independent
// signal is `fileReads`: with the background vault it lands at ≈ folds·(B7_BG+1), i.e. it
// scales with BOTH the fold count (C) and the vault size (F) — the product the hypothesis
// names. `readsPerFold` normalises out C so the F attribution is legible at a glance.
const B7_BG = 200; // quiet background files the per-fold buildLocalState needlessly re-reads

async function b7(C: number): Promise<void> {
  const server = new FakeSyncServer();
  const crypto = await makeCrypto();
  const base = await TestDevice.create('b7-base');
  // A background vault of quiet files + the one file the peers will diverge on. The
  // quiet files never get a second head, so they never fold — they exist only to give
  // each per-fold `buildLocalState` a whole vault to needlessly re-read (the F·B term).
  await seedVault(base, B7_BG, 2_048);
  await base.seedFile('note.md', 'base\n', 900_000);
  await makeClient(server, crypto, base).runSync();

  // C peers each fork `note.md` concurrently from the shared base. ALL receive the
  // base (+ background) first — while the server holds only the base, so nobody pulls a
  // sibling head — then each edits offline and pushes WITHOUT a reconciling round
  // (pushOffline), so all C heads land on the server as genuine concurrent leaves.
  const peers: TestDevice[] = [];
  for (let i = 0; i < C; i++) {
    const peer = await TestDevice.create(`b7-peer-${i}`);
    await makeClient(server, crypto, peer).runSync();     // receive base + background
    peers.push(peer);
  }
  for (let i = 0; i < C; i++) {
    await peers[i]!.editFile('note.md', `base\nhead-${i}\n`, 2_000_000 + i);
    await pushOffline(server, crypto, peers[i]!);          // land head i, no reconcile
  }

  // A fresh target device's FIRST sync pulls the base + background + all C concurrent
  // heads in one round → reconcileConcurrentHeads' fold loop runs right here (a warm-up
  // sync would converge it first and measure nothing). Its content store is empty, so the
  // per-fold buildLocalState genuinely re-reads the whole vault — the C·F scaling we want.
  const target = await TestDevice.create('b7-target');
  const r = await profileOp(target, () => makeClient(server, crypto, target).runSync().then(() => {}));
  const readsPerFold = Math.round((r.io.files.reads / Math.max(1, C - 1)) * 10) / 10;
  record({
    scenario: 'B7', variant: `wide-concurrency C=${C} (bg F=${B7_BG})`,
    counts: {
      fileReads: r.io.files.reads, readsPerFold, dagLeaves: r.cpu.dagLeaves,
      dagMergeBase: r.cpu.dagMergeBase, sha256: r.cpu.sha256,
    },
    timing: { foldRoundMs: r.ms, heapMB: r.heapMB },
    note: 'fold loop re-runs buildLocalState (whole-vault re-read) per fold → fileReads ≈ folds·(F+1), superlinear in C·F',
  });
}

// ─── B8 — diff3 large-file merge vs B and line-uniqueness ────────────────────────

async function b8(): Promise<void> {
  const cases: Array<{ variant: string; base: string; local: string; remote: string; note: string }> = [];
  for (const kb of [64, 256, 1024]) {
    const base = makeText(kb * 1024, 'base');
    const lines = base.split('\n');
    const local = lines.map((l, i) => (i % 50 === 0 ? l + ' L' : l)).join('\n');
    const remote = lines.map((l, i) => (i % 70 === 0 ? l + ' R' : l)).join('\n');
    cases.push({ variant: `big-file ${kb}KB unique`, base, local, remote, note: 'normal file ≈ O(L)' });
  }
  for (const n of [1_000, 4_000, 8_000]) {
    const base = makeRepetitiveText(n);
    const local = base + 'L\n';
    const remote = 'R\n' + base;
    cases.push({ variant: `low-unique ${n} lines`, base, local, remote, note: 'Myers O(L_a·L_b) DP cliff' });
  }
  for (const c of cases) {
    const ms = await medianMs(async () => { threeWayMerge(c.base, c.local, c.remote); }, 3);
    const res = threeWayMerge(c.base, c.local, c.remote);
    record({
      scenario: 'B8', variant: c.variant,
      counts: { conflicts: res.conflicts.length },
      timing: { mergeMs: ms },
      note: c.note,
    });
  }
}

// ─── B9 — crypto attribution ─────────────────────────────────────────────────────

async function b9(): Promise<void> {
  // PBKDF2 (one-time passphrase derive).
  {
    const t0 = nowMs();
    await makeCrypto();
    record({ scenario: 'B9', variant: 'PBKDF2 derive (one-time)', counts: {}, timing: { deriveMs: nowMs() - t0 }, note: 'fixed one-time cost' });
  }
  const crypto = await makeCrypto();
  // Per-op AES-GCM (tiny payload) and per-blob AES-GCM / SHA-256 over B bytes.
  const op = { v: 1, id: 'x', hlcTimestamp: { wallTime: 1, counter: 0, deviceId: 'd' }, fileId: 'f', type: 'update', path: 'p', contentHash: 'h', parents: [] };
  const opMs = await medianMs(async () => { await crypto.encryptOp(op); }, 20);
  record({ scenario: 'B9', variant: 'AES-GCM per op', counts: {}, timing: { encryptOpMs: opMs }, note: 'per-op seal' });

  for (const kb of [64, 1024, 5 * 1024]) {
    const bytes = new Uint8Array(kb * 1024);
    for (let i = 0; i < bytes.length; i += 97) bytes[i] = i & 0xff;
    const encMs = await medianMs(async () => { await crypto.encryptBlob(bytes); }, 5);
    const hashMs = await medianMs(async () => { await crypto.blindHash('a'.repeat(64)); }, 5);
    const shaMs = await medianMs(async () => { await crypto2sha(bytes); }, 5);
    record({
      scenario: 'B9', variant: `blob ${kb}KB`,
      counts: {},
      timing: { encryptBlobMs: encMs, blindHashMs: hashMs, sha256Ms: shaMs },
      note: 'per-blob AES-GCM + SHA-256 over B bytes',
    });
  }
}
async function crypto2sha(bytes: Uint8Array): Promise<void> { await crypto.subtle.digest('SHA-256', bytes as BufferSource); }

// ─── Report emission (spec §7.4 / §8) ────────────────────────────────────────────

function toMarkdown(stamp: string): string {
  const byScenario = new Map<string, Row[]>();
  for (const r of rows) (byScenario.get(r.scenario) ?? byScenario.set(r.scenario, []).get(r.scenario)!).push(r);

  let md = `# Mobile perf baseline — Layer 1 & 2 results\n\n`;
  md += `Run: \`${stamp}\` · Node ${process.version}\n\n`;
  md += `> Layer-1 wall/heap are **relative** signals (this machine, not a phone). `;
  md += `Layer-2 counts are **exact and device-independent**. Absolute on-device time = Layer-3 (perfLog), recorded separately.\n\n`;
  md += `Profiles run: ${PROFILES.map(p => `${p.name}(F=${p.F},B=${p.B})`).join(', ')}\n\n`;
  for (const [scenario, rs] of byScenario) {
    md += `## ${scenario}\n\n`;
    if (rs[0]?.note) md += `_${rs[0].note}_\n\n`;
    const metricKeys = Array.from(new Set(rs.flatMap(r => [...Object.keys(r.counts), ...Object.keys(r.timing)])));
    md += `| variant | ${metricKeys.join(' | ')} |\n`;
    md += `|---|${metricKeys.map(() => '--:').join('|')}|\n`;
    for (const r of rs) {
      const cells = metricKeys.map(k => {
        if (k in r.counts) return String(r.counts[k]);
        if (k in r.timing) return r.timing[k]!.toFixed(1);
        return '';
      });
      md += `| ${r.variant} | ${cells.join(' | ')} |\n`;
    }
    md += `\n`;
  }
  return md;
}

async function main(): Promise<void> {
  if (!(globalThis as { gc?: unknown }).gc) {
    console.warn('[bench] running WITHOUT --expose-gc — heap deltas will be noisy. Use `npm run bench`.\n');
  }
  console.log(`[bench] profiles: ${PROFILES.map(p => p.name).join(', ')}\n`);
  const t0 = nowMs();

  if (ONLY.length) console.log(`[bench] scenarios: ${ONLY.join(', ')} · K=${K_SWEEP.join(',')} · B6 rounds=${B6_ROUNDS}\n`);
  if (want('b1')) { console.log('B1 — steady-state round vs F');
    for (const p of PROFILES) await b1(p); }
  if (want('b2')) { console.log('B2 — round vs history H (DAG walks)');
    for (const K of K_SWEEP) await b2(K); }
  if (want('b2b')) { console.log('B2b — mergeBase common² filter (deep shared backbone)');
    for (const K of K_SWEEP) await b2b(K); }
  if (want('b3')) { console.log('B3 — cold startup vs F');
    for (const p of PROFILES) await b3(p); }
  if (want('b4')) { console.log('B4 — cold pull / DAG rebuild vs H');
    for (const K of K_SWEEP) await b4(K); }
  if (want('b5')) { console.log('B5 — write amplification (L2 only)');
    for (const p of PROFILES) await b5(p); }
  if (want('b6')) { console.log('B6 — memory over a session');
    for (const p of PROFILES) await b6(p, B6_ROUNDS); }
  if (want('b7')) { console.log('B7 — concurrent-head fold vs C');
    for (const C of C_SWEEP) await b7(C); }
  if (want('b8')) { console.log('B8 — diff3 large-file merge');
    await b8(); }
  if (want('b9')) { console.log('B9 — crypto attribution');
    await b9(); }

  const elapsed = ((nowMs() - t0) / 1000).toFixed(1);
  console.log(`\n[bench] done in ${elapsed}s — ${rows.length} rows`);

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, 'results');
  mkdirSync(outDir, { recursive: true });

  // Stamp the artifact with the date + the profiles it covers, so a run can never
  // silently clobber a different one — an `xs` smoke test writes `<date>_xs.*`, the
  // full baseline writes `<date>_xs-s-m.*`. The stamped files are the durable,
  // committable record; `latest.*` is only a transient convenience pointer (and is
  // gitignored — see bench/results/.gitignore). `BENCH_DATE` overrides the date so a
  // regenerated baseline can match its `docs/perf-baseline-<date>.md` companion.
  const date = process.env.BENCH_DATE ?? new Date().toISOString().slice(0, 10);
  const stamp = `${date}_${PROFILES.map(p => p.name.toLowerCase()).join('-')}`;
  const md = toMarkdown(stamp);
  const payload = {
    date,
    stamp,
    generatedElapsedSec: Number(elapsed),
    node: process.version,
    profiles: PROFILES,
    rows,
  };
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(outDir, `${stamp}.md`), md);
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(outDir, 'latest.md'), md);
  console.log(`[bench] wrote bench/results/${stamp}.{json,md}  (+ transient latest.*)`);
}

main().catch(err => { console.error(err); process.exit(1); });
