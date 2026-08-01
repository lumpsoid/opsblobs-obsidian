// ─────────────────────────────────────────────
//  FileRegistry tombstone reclamation + allocation-free entry iteration
// ─────────────────────────────────────────────
//
//  From the 2026-08-01 over-time degradation audit. Two growths in FileRegistry:
//
//   A) `markDeleted` only flips `deleted = true`, so the entry set never shrinks — the
//      registry grew with the vault's LIFETIME file churn even when the live file count
//      was flat, and every dead entry was re-serialized by `compact()`, re-parsed by
//      `load()`, re-iterated by `buildLocalIdentity`, and unioned by every merge.
//      Fixed by reclaiming tombstones inside `compact()` (the one place that already
//      rewrites the whole snapshot), gated on a retention horizon + "its delete op is
//      already pushed" + "no unresolved conflict".
//   B) `getAllEntries()` copies the whole Map, and the status-bar/ribbon conflict count
//      calls it after EVERY debounced edit. `entriesIterator()` is the read-only,
//      allocation-free accessor those scanning reads use instead.
//
//  These drive the REAL FileRegistry over the in-memory fakes, plus one round-level
//  test through the genuine sync stack (TestDevice) for the post-push wiring.

import { describe, test, expect, beforeAll } from 'vitest';
import { FileRegistry } from '../src/core/file-registry';
import { listTwoHeadedConflicts } from '../src/core/conflict-inventory';
import { HLC, SyncSettings, DEFAULT_SETTINGS } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const DAY = 86_400_000;
/** The floor the registry applies regardless of `ancestorRetentionDays`. */
const HORIZON = 30 * DAY;
const at = (wallTime: number): HLC => ({ wallTime, counter: 0, deviceId: 'dev' });
const NOTHING_PENDING: ReadonlySet<string> = new Set<string>();

const makeRegistry = (
  meta: FakeMetadataStore,
  overrides: Partial<SyncSettings> = {},
): FileRegistry =>
  new FileRegistry(meta, new FakeVaultFiles(), 'dev', () => ({
    ...DEFAULT_SETTINGS,
    ...overrides,
  }) as SyncSettings);

/** A loaded registry holding `live` live files and `dead` files deleted at wall 0. */
const seeded = async (
  meta: FakeMetadataStore,
  live: number,
  dead: number,
  overrides: Partial<SyncSettings> = {},
): Promise<FileRegistry> => {
  const reg = makeRegistry(meta, overrides);
  await reg.load();
  for (let i = 0; i < live; i++) await reg.registerFile(`live-${i}.md`, at(1), `h-live-${i}`);
  for (let i = 0; i < dead; i++) {
    await reg.registerFile(`dead-${i}.md`, at(1), `h-dead-${i}`);
    await reg.markDeleted(`dead-${i}.md`, at(0));
  }
  return reg;
};

describe('FileRegistry — tombstone reclamation at compact()', () => {
  test('create+delete N files then compact() past the horizon returns the entry set to the live count', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 3, 20);
    expect(reg.getAllEntries().size).toBe(23);   // the unbounded growth, pre-fix

    await reg.compact({ now: HORIZON + 1, pinned: NOTHING_PENDING });

    expect(reg.getAllEntries().size).toBe(3);
    expect([...reg.entriesIterator()].every(e => !e.deleted)).toBe(true);
    // The live files are untouched — reclamation only ever drops tombstones.
    expect(reg.getByPath('live-1.md')?.contentHash).toBe('h-live-1');
  });

  test('a re-create at a reclaimed path still works — it mints a fresh id', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 0, 1);
    const oldId = reg.getByPath('dead-0.md')?.id;
    expect(oldId).toBeDefined();

    await reg.compact({ now: HORIZON + 1, pinned: NOTHING_PENDING });
    // The tombstone's path→id mapping went with it, so nothing dangles: `registerFile`
    // must not hand back an id the Map no longer holds.
    expect(reg.getByPath('dead-0.md')).toBeUndefined();

    const newId = await reg.registerFile('dead-0.md', at(HORIZON + 2), 'h-again');
    expect(newId).not.toBe(oldId);
    const entry = reg.getByPath('dead-0.md');
    expect(entry).toMatchObject({ id: newId, deleted: false, contentHash: 'h-again' });
    expect(reg.getAllEntries().size).toBe(1);
  });

  test('the drop is durable — it survives a reload (snapshot rewritten, journal truncated)', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 2, 5);
    await reg.compact({ now: HORIZON + 1, pinned: NOTHING_PENDING });

    const reloaded = makeRegistry(meta);
    await reloaded.load();
    expect(reloaded.getAllEntries()).toEqual(reg.getAllEntries());
    expect(reloaded.getAllEntries().size).toBe(2);
  });

  test('a drop with an EMPTY journal still forces the snapshot rewrite', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 1, 1);
    // Fold everything in first, so the next compact() has nothing journalled to fold.
    await reg.compact({ now: 0, pinned: NOTHING_PENDING });
    expect(reg.getAllEntries().size).toBe(2);   // horizon not reached yet

    await reg.compact({ now: HORIZON + 1, pinned: NOTHING_PENDING });

    // In memory AND on disk — a drop that skipped the rewrite would be resurrected by
    // the next load() while already gone from the Map.
    expect(reg.getAllEntries().size).toBe(1);
    const reloaded = makeRegistry(meta);
    await reloaded.load();
    expect(reloaded.getAllEntries().size).toBe(1);
  });

  test('compact() with no reclaim argument leaves every tombstone alone', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 1, 4);
    await reg.compact();
    expect(reg.getAllEntries().size).toBe(5);
  });
});

describe('FileRegistry — what reclamation must NOT drop', () => {
  test('a tombstone younger than the horizon survives', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 0, 1);
    await reg.compact({ now: HORIZON - 1, pinned: NOTHING_PENDING });
    expect(reg.getAllEntries().size).toBe(1);
    // …and is reclaimed once the horizon is genuinely crossed.
    await reg.compact({ now: HORIZON, pinned: NOTHING_PENDING });
    expect(reg.getAllEntries().size).toBe(0);
  });

  test('a tombstone pinned by a still-pending (un-pushed) op survives', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 0, 2);
    const pinnedId = reg.getByPath('dead-0.md')!.id;

    await reg.compact({ now: HORIZON + 1, pinned: new Set([pinnedId]) });

    // No peer has seen this delete yet, so its identity must stay.
    expect(reg.getById(pinnedId)?.deleted).toBe(true);
    expect(reg.getAllEntries().size).toBe(1);
  });

  test('a tombstone still carrying conflictParents survives — the user has to settle it', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();
    const id = await reg.registerFile('c.md', at(1), 'h');
    await reg.markConflicted('c.md', 'h-markers', at(1), ['head-a', 'head-b']);
    await reg.markDeleted('c.md', at(0));

    await reg.compact({ now: HORIZON + 1, pinned: NOTHING_PENDING });

    expect(reg.getById(id)).toBeDefined();
    // The Conflicts panel reads this straight off the registry.
    expect(listTwoHeadedConflicts(reg.entriesIterator())).toHaveLength(1);
  });

  test('an HLC wall time ahead of real time keeps the tombstone (drift errs toward retention)', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();
    await reg.registerFile('f.md', at(1), 'h');
    // A remote-merged HLC can run ahead of this device's real clock.
    await reg.markDeleted('f.md', at(10 * HORIZON));

    await reg.compact({ now: HORIZON + 1, pinned: NOTHING_PENDING });
    expect(reg.getAllEntries().size).toBe(1);
  });

  test('the horizon is floored, so shrinking ancestorRetentionDays cannot evaporate tombstones', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 0, 1, { ancestorRetentionDays: 1 });
    await reg.compact({ now: 2 * DAY, pinned: NOTHING_PENDING });
    expect(reg.getAllEntries().size).toBe(1);
  });

  test('a garbage ancestorRetentionDays falls back to the floor instead of dropping everything', async () => {
    const meta = new FakeMetadataStore();
    // A missing/NaN setting must not make `wallTime > now - NaN` false for every entry.
    const reg = await seeded(meta, 0, 1, { ancestorRetentionDays: undefined as unknown as number });
    await reg.compact({ now: 2 * DAY, pinned: NOTHING_PENDING });
    expect(reg.getAllEntries().size).toBe(1);
  });
});

describe('FileRegistry.entriesIterator — the allocation-free scanning read', () => {
  test('yields every entry, live and tombstoned, exactly as getAllEntries() does', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 3, 2);
    expect([...reg.entriesIterator()]).toEqual([...reg.getAllEntries().values()]);
    expect([...reg.entriesIterator()]).toHaveLength(5);
  });

  test('the conflict inventory the status bar recomputes per edit reads it without a Map copy', async () => {
    const meta = new FakeMetadataStore();
    const reg = await seeded(meta, 2, 1);
    await reg.markConflicted('live-0.md', 'h-markers', at(2), ['head-a', 'head-b']);

    // The hot path (main.ts `twoHeadedConflicts`) must never call getAllEntries().
    let copies = 0;
    const orig = reg.getAllEntries.bind(reg);
    reg.getAllEntries = () => { copies++; return orig(); };

    const items = listTwoHeadedConflicts(reg.entriesIterator());

    expect(items.map(i => i.path)).toEqual(['live-0.md']);
    expect(copies).toBe(0);
  });
});

describe('tombstone reclamation through a real sync round', () => {
  const SALT = new Uint8Array([9, 1, 9, 1, 7, 7, 7, 7, 9, 1, 9, 1, 7, 7, 7, 7]);
  let vc: VaultCrypto;
  beforeAll(async () => { vc = new VaultCrypto(); await vc.deriveFromPassphrase('pp', SALT); });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('a tombstone survives rounds inside the horizon and is reclaimed by the first round past it', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    await A.seedFile('keep.md', 'K', 1_000);
    const goneId = await A.seedFile('gone.md', 'G', 1_000);
    await client(api, A).runSync();

    // Delete + sync: the delete op reaches the server, but the tombstone is fresh.
    await A.deleteFile('gone.md', 2_000);
    await client(api, A).runSync();
    expect(A.entry(goneId)?.deleted).toBe(true);
    // …and stays put across further rounds inside the window.
    A.setWall(2_000 + HORIZON - 1);
    await client(api, A).runSync();
    expect(A.entry(goneId)?.deleted).toBe(true);

    // First round past the horizon reclaims it — the round's post-apply compact is
    // post-push, so nothing pending pins it any more.
    A.setWall(2_000 + HORIZON);
    await client(api, A).runSync();

    expect(A.entry(goneId)).toBeUndefined();
    expect(A.allEntries().size).toBe(1);
    expect(A.entryByPath('keep.md')).toBeDefined();
    // The reclamation is durable across a plugin restart.
    const reloaded = await A.reload();
    expect(reloaded.allEntries().size).toBe(1);
  });
});
