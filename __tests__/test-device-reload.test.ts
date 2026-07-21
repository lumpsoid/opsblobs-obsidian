// ─────────────────────────────────────────────
//  Proves TestDevice.reload() — the restart / crash-recovery harness the
//  durability suite (Part 2 C-series) relies on. A reload must carry over
//  everything that reached disk (vault bytes, registry, oplog, HLC) and drop
//  only in-memory state.
// ─────────────────────────────────────────────

import { describe, test, expect } from 'vitest';
import { hlcCompare } from '../src/core/hlc';
import { TestDevice } from './helpers/test-device';

describe('TestDevice.reload — persistence round-trip', () => {
  test('registry entry, pending op, and logical time survive a restart', async () => {
    const device = await TestDevice.create('dev-a');
    const id = await device.seedFile('note.md', 'hello\n', 1000);
    const hash = device.entry(id)!.contentHash;
    expect(device.pendingOps).toHaveLength(1); // the un-synced create

    const reloaded = await device.reload();

    // Registry entry survived, under the same id, with its content hash intact.
    const entry = reloaded.entry(id);
    expect(entry).toBeDefined();
    expect(entry!.path).toBe('note.md');
    expect(entry!.contentHash).toBe(hash);

    // The un-synced pending op survived (it was persisted to the oplog).
    expect(reloaded.pendingOps).toHaveLength(1);
    expect(reloaded.pendingOps[0]!.fileId).toBe(id);

    // The file bytes are still in the shared vault.
    const bytes = await reloaded.files.read('note.md');
    expect(bytes && new TextDecoder().decode(bytes)).toBe('hello\n');

    // Logical time was seeded from the persisted HLC — the next HLC the reloaded
    // device issues dominates the one stamped on the pre-restart op (no regression).
    const preRestartHlc = device.entry(id)!.hlcTimestamp;
    expect(hlcCompare(reloaded.hlc.now(), preRestartHlc)).toBeGreaterThan(0);
  });

  test('a fresh device (no persisted state) reloads cleanly to the same empty state', async () => {
    const device = await TestDevice.create('dev-a');
    const reloaded = await device.reload();
    expect(reloaded.pendingOps).toHaveLength(0);
    expect(reloaded.activeEntries()).toHaveLength(0);
  });
});
