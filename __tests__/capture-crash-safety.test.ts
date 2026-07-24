// ─────────────────────────────────────────────
//  captureOfflineChanges crash-safety (incremental oplog checkpointing)
// ─────────────────────────────────────────────
//
//  A first-enable capture of a large vault runs for minutes on mobile and can be
//  OOM-killed mid-pass. The registry is persisted per-file, but the oplog used to be
//  written only once at the very end — so an interrupted capture left files marked
//  "captured" in the registry while their ops were never journalled, stranding them
//  (they skip re-capture on the `entry.contentHash === hash` guard and never sync).
//  captureOfflineChanges now checkpoints the oplog every CAPTURE_CHECKPOINT_EVERY (200)
//  ops, bounding that loss to <200 and keeping the live pending count fresh. This
//  drives the REAL OperationLogger over the fakes.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

describe('captureOfflineChanges checkpoints the oplog', () => {
  const seedFiles = async (dev: TestDevice, n: number) => {
    for (let i = 0; i < n; i++) await dev.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);
  };

  test('persists the oplog incrementally, not only at the end', async () => {
    const seed = await TestDevice.create('cap-inc');
    await seedFiles(seed, 500);
    const dev = await seed.reload();

    // The oplog is an append-only NDJSON journal (spec §4): each checkpoint appends only
    // its delta ops, so incremental persistence shows up as multiple `append` calls, not
    // multiple whole-file `write`s.
    let oplogAppends = 0;
    const orig = dev.metadata.append.bind(dev.metadata);
    dev.metadata.append = async (p: string, d: string) => {
      if (p.endsWith('oplog.json')) oplogAppends++;
      return orig(p, d);
    };

    await dev.opLogger.captureOfflineChanges();

    // 500 new files, 200-op checkpoint → appends at 200, 400, + the final tail append.
    expect(oplogAppends).toBeGreaterThanOrEqual(2);
    expect(dev.pendingOps.length).toBe(500);
  });

  test('batches the registry write instead of rewriting it per file (O(F²) → ~O(F))', async () => {
    const seed = await TestDevice.create('cap-batch');
    await seedFiles(seed, 500);
    const dev = await seed.reload();

    let registryWrites = 0;
    const orig = dev.metadata.write.bind(dev.metadata);
    dev.metadata.write = async (p: string, d: string) => {
      if (p.endsWith('file-registry.json')) registryWrites++;
      return orig(p, d);
    };

    await dev.opLogger.captureOfflineChanges();

    // Pre-fix: registerFile + setHeadVersion each save → ~2 writes/file ≈ 1000.
    // Batched: one flush per 200-op checkpoint (200, 400) + the final ≈ 3.
    expect(registryWrites).toBeLessThan(10);
    // …and it still captured everything correctly.
    expect(dev.pendingOps.length).toBe(500);
    expect(dev.activeEntries().length).toBe(500);
  });

  test('an interrupted capture leaves the checkpointed ops durable (recoverable)', async () => {
    const seed = await TestDevice.create('cap-crash');
    await seedFiles(seed, 500);
    const dev = await seed.reload();

    // Simulate an OOM kill: make the vault read throw after ~350 files, well past
    // the first checkpoint (200) but before the end.
    let reads = 0;
    const origRead = dev.files.read.bind(dev.files);
    dev.files.read = async (p: string) => {
      if (++reads > 350) throw new Error('simulated crash (OOM)');
      return origRead(p);
    };
    await expect(dev.opLogger.captureOfflineChanges()).rejects.toThrow('simulated crash');
    dev.files.read = origRead; // restore the shared fake before reloading

    // Reload from disk (the crash discarded in-memory pendingOps). Before the fix,
    // ZERO ops would survive; now the checkpoint at 200 is durable, so the capture
    // is recoverable rather than silently lost.
    const recovered = await dev.reload();
    expect(recovered.pendingOps.length).toBeGreaterThanOrEqual(200);
    expect(recovered.pendingOps.length).toBeLessThan(500);
  });
});

// The registry-before-oplog invariant under the append-journal (registry-append-journal-spec
// §4, the §4-Q3 gate): on disk the registry must never lag the oplog. A crash must land in
// the SAFE direction — registry ahead (files stranded → rebaseline heals) — and NEVER orphan
// an op (an oplog op referencing an unregistered file). Both seams are exercised on the REAL
// capture path; the assertion is the same: every persisted op's fileId has a registry entry.
describe('captureOfflineChanges: registry never lags the oplog (§4-Q3 gate)', () => {
  const seedFiles = async (dev: TestDevice, n: number) => {
    for (let i = 0; i < n; i++) await dev.seedExistingFile(`notes/n-${i}.md`, `body ${i}\n`);
  };
  const REGISTRY_JOURNAL = '.vault-sync/file-registry.journal';

  const assertNoOrphan = (dev: TestDevice) => {
    for (const op of dev.pendingOps) {
      expect(dev.registry.getById(op.fileId)).toBeDefined();
    }
  };

  test('crash after registry.flush but before the oplog append leaves the registry AHEAD, never orphaned', async () => {
    const seed = await TestDevice.create('gate-ahead');
    await seedFiles(seed, 500);
    const dev = await seed.reload();

    // Fail the SECOND oplog append (checkpoint at 400). By then the checkpoint's
    // registry.flush has already committed its journal delta — so on disk the registry
    // is ahead of the oplog, the safe direction. (append now serves BOTH files, so the
    // wrapper gates on the path.)
    let oplogAppends = 0;
    const orig = dev.metadata.append.bind(dev.metadata);
    dev.metadata.append = async (p: string, d: string) => {
      if (p.endsWith('oplog.json') && ++oplogAppends === 2) {
        throw new Error('simulated crash after registry.flush, before oplog append');
      }
      return orig(p, d);
    };
    await expect(dev.opLogger.captureOfflineChanges()).rejects.toThrow('simulated crash');

    const recovered = await dev.reload();
    // Only the first checkpoint's ops are durable in the oplog…
    expect(recovered.pendingOps).toHaveLength(200);
    // …and every one of them resolves to a registry entry — no orphan op.
    assertNoOrphan(recovered);
    // The registry is ahead: it holds the second checkpoint's entries too (stranded
    // files, recoverable via rebaseline), not fewer than the oplog references.
    expect(recovered.activeEntries().length).toBeGreaterThanOrEqual(400);
  });

  test('a torn registry-journal append (process killed mid-write) strands, never orphans', async () => {
    // A clean capture first, so the registry+oplog are consistent and the journal is
    // compacted into the snapshot (finally → compact()).
    const seed = await TestDevice.create('gate-torn');
    await seedFiles(seed, 3);
    const dev = await seed.reload();
    await dev.opLogger.captureOfflineChanges();
    expect(dev.pendingOps).toHaveLength(3);

    // Model the crash seam a real process-kill leaves behind: a checkpoint whose
    // registry.flush append was torn mid-write, and whose oplog append (which comes
    // AFTER) therefore never ran. On disk that is a truncated trailing registry-journal
    // line for a would-be new entry, with NO matching op in the oplog.
    const raw = (await dev.metadata.read(REGISTRY_JOURNAL)) ?? '';
    dev.metadata.set(REGISTRY_JOURNAL, raw + '{"id":"stranded","path":"notes/x.m');

    const recovered = await dev.reload();
    // The torn line is dropped (stranded file re-captures next enable)…
    expect(recovered.registry.getById('stranded')).toBeUndefined();
    // …and the invariant holds: every persisted op still references a registered file.
    assertNoOrphan(recovered);
    expect(recovered.pendingOps).toHaveLength(3);
  });
});
