// ─────────────────────────────────────────────
//  Duplicate ops in the oplog journal (field incident, 2026-08-01)
// ─────────────────────────────────────────────
//
//  A user emptied two vault folders in Finder and pasted a replacement set into each,
//  with Obsidian running. The plugin was idle — this all arrived through the live
//  watcher. Afterwards `oplog.json` held 1988 lines for 290 real ops: 1698 byte-identical
//  duplicates. On the next plugin load those duplicates were replayed into `pendingOps`
//  and pushed, and the server rejected the batch — deterministically, on every retry,
//  because the retry replayed the identical batch. Sync was wedged until the local
//  journal was repaired.
//
//  Root cause: `appendOpLog` read `oplogPersistedCount`, awaited the write, and only then
//  advanced the marker — while nothing serialized its callers. The bulk change delivered
//  a burst of watcher events that all reached it at once, so ~20 appends each sliced from
//  the same un-advanced marker and re-wrote a delta already on disk. The duplicated line
//  indices recovered from the real journal (gaps of 1,2,3,…,19) are exactly that shape.
//
//  A second, independent fault in the same incident: 10 of the 149 replaced files ended up
//  with TWO registry entries for one path (one tombstoned holding the original id, one live
//  holding a fresh one). Their delete event was processed *after* the re-create for the
//  same path, so `markDeleted` tombstoned a file that was live on disk; the next startup
//  capture then saw a live file with no active entry and minted a second id — a duplicate
//  file on every peer.
//
//  These drive the REAL OperationLogger / PluginVaultSyncHost over the fakes.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';
import { dedupeOpsById } from '../src/core/operations';
import { VersionDag } from '../src/core/version-dag';
import { Operation } from '../src/types';

const OPLOG = '.opsblobs/oplog.json';

/** Parse the on-disk NDJSON journal the way `load()` does. */
const journalOps = async (dev: TestDevice): Promise<Operation[]> =>
  ((await dev.metadata.read(OPLOG)) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Operation);

describe('the oplog journal never accumulates duplicate ops', () => {
  test('overlapping appends do not re-write a delta that is already on disk', async () => {
    const dev = await TestDevice.create('oplog-dup-race');

    // Model real append latency: the production bug needs the write to actually yield,
    // so a second caller can observe the un-advanced marker mid-flight. The fake resolves
    // immediately otherwise, which would hide the race entirely.
    const origAppend = dev.metadata.append.bind(dev.metadata);
    dev.metadata.append = async (p: string, d: string) => {
      if (p.endsWith('oplog.json')) await new Promise(r => setTimeout(r, 0));
      return origAppend(p, d);
    };

    // The incident's shape: a folder's worth of files arriving as one concurrent burst,
    // every handler racing into the same persist. NOT awaited one-by-one — awaiting each
    // would serialize them by hand and test nothing.
    const paths = Array.from({ length: 40 }, (_, i) => `DB/games/game-${i}.md`);
    dev.setWall(1_000);
    await Promise.all(
      paths.map(async (p, i) => {
        await dev.files.write(p, new TextEncoder().encode(`body ${i}\n`));
        await dev.watcher.emitCreate(p);
      }),
    );

    const onDisk = await journalOps(dev);
    const distinct = new Set(onDisk.map(o => o.id));
    expect(onDisk.length).toBe(distinct.size);          // no duplicated lines
    expect(distinct.size).toBe(paths.length);           // and every op landed exactly once
    // The journal must also agree with memory — a duplicate-free but *short* journal
    // would mean the serialization dropped a delta instead of ordering it.
    expect(onDisk.map(o => o.id).sort()).toEqual(dev.pendingOps.map(o => o.id).sort());
  });

  test('a journal that already holds duplicates loads clean and is compacted on disk', async () => {
    const seed = await TestDevice.create('oplog-dup-heal');
    await seed.seedFile('notes/a.md', 'a\n', 1_000);
    await seed.seedFile('notes/b.md', 'b\n', 2_000);

    // Reproduce the corrupt on-disk shape: each line re-appended, staircase-style, the
    // way overlapping appends actually wrote it.
    const real = await journalOps(seed);
    expect(real.length).toBe(2);
    const [a, b] = real as [Operation, Operation];
    const corrupt = [a, a, b, a, b].map(o => JSON.stringify(o)).join('\n') + '\n';
    await seed.metadata.write(OPLOG, corrupt);

    const dev = await seed.reload();

    // Loaded clean, order preserved, first occurrence kept.
    expect(dev.pendingOps.map(o => o.id)).toEqual([a.id, b.id]);
    // …and the file itself was healed, so the next load isn't paying for it again.
    expect((await journalOps(dev)).map(o => o.id)).toEqual([a.id, b.id]);
  });

  test('the push payload is deduped even if pending ops were poisoned', async () => {
    const dev = await TestDevice.create('oplog-dup-push');
    await dev.seedFile('notes/a.md', 'a\n', 1_000);

    // Force the fault the guard exists for, without depending on how it arose.
    const real = dev.pendingOps[0]!;
    dev.opLogger.getPendingOps = () => [real, real, real];

    const state = await dev.host.buildLocalIdentity(new VersionDag());
    expect(state.pendingOps.length).toBe(1);
    expect(state.pendingOps[0]!.id).toBe(real.id);
  });

  test('dedupeOpsById keeps the first occurrence and the original order', () => {
    const op = (id: string) => ({ id }) as unknown as Operation;
    expect(dedupeOpsById([op('a'), op('b'), op('a'), op('c'), op('b')]).map(o => o.id))
      .toEqual(['a', 'b', 'c']);
    expect(dedupeOpsById([]).length).toBe(0);
  });
});

describe('a delete event that arrives after its path was re-created', () => {
  test('does not tombstone the live file or mint a second id for it', async () => {
    const dev = await TestDevice.create('stale-delete');
    const originalId = await dev.seedFile('DB/games/Dying Light.md', 'old body\n', 1_000);

    // The Finder sequence: the file is removed and a different file is pasted at the same
    // path, and the delete event is delivered LATE — after the create for the new bytes
    // has already been processed. That ordering is what the burst actually produced.
    dev.setWall(2_000);
    await dev.files.trash('DB/games/Dying Light.md');
    await dev.files.write('DB/games/Dying Light.md', new TextEncoder().encode('new body\n'));
    await dev.watcher.emitCreate('DB/games/Dying Light.md');
    await dev.watcher.emitDelete('DB/games/Dying Light.md');   // ← stale, arrives last

    const entry = dev.registry.getByPath('DB/games/Dying Light.md');
    expect(entry).toBeDefined();
    expect(entry!.deleted).toBe(false);          // the live file is not tombstoned
    expect(entry!.id).toBe(originalId);          // identity preserved across the replace

    // The real damage showed up only after a restart, when the startup capture met a live
    // file with no active entry. Assert the path there too: one entry, one id, no duplicate.
    const restarted = await dev.reload();
    await restarted.opLogger.captureOfflineChanges();

    const all = [...restarted.registry.entriesIterator()]
      .filter(e => e.path === 'DB/games/Dying Light.md');
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe(originalId);
    expect(all[0]!.deleted).toBe(false);
    expect(new TextDecoder().decode((await restarted.files.read('DB/games/Dying Light.md'))!))
      .toBe('new body\n');
  });

  test('a genuine delete still tombstones and emits its op', async () => {
    const dev = await TestDevice.create('real-delete');
    await dev.seedFile('notes/gone.md', 'body\n', 1_000);
    // Drain the pending create so this models a file a peer already has. Without this
    // the create/delete pair cancels by design (an un-synced create + its delete emit
    // nothing), which would prove nothing about the guard.
    await dev.opLogger.clearOps();

    await dev.deleteFile('notes/gone.md', 2_000);

    const entry = dev.registry.getByPath('notes/gone.md');
    expect(entry?.deleted).toBe(true);
    expect(dev.pendingOps.some(o => o.type === 'delete' && o.path === 'notes/gone.md')).toBe(true);
  });

  test('an un-synced create followed by a real delete still cancels to nothing', async () => {
    const dev = await TestDevice.create('prune-pair');
    await dev.seedFile('notes/tmp.md', 'body\n', 1_000);

    await dev.deleteFile('notes/tmp.md', 2_000);

    // The guard must not disturb the existing prune: tombstone stands, no ops survive.
    expect(dev.registry.getByPath('notes/tmp.md')?.deleted).toBe(true);
    expect(dev.pendingOps.filter(o => o.path === 'notes/tmp.md')).toEqual([]);
  });
});
