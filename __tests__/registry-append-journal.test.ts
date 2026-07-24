// ─────────────────────────────────────────────
//  FileRegistry append-journal (spec: docs/registry-append-journal-spec.md §6)
// ─────────────────────────────────────────────
//
//  The registry persists as a snapshot (file-registry.json) + an append-only NDJSON
//  journal of the entries touched since that snapshot (file-registry.journal). A
//  checkpoint `flush()` appends only the touched delta (O(delta)) instead of rewriting
//  the whole map (O(N)); `load()` replays the journal last-write-wins onto the snapshot
//  and rebuilds the IDENTICAL Map; `compact()` folds the journal back and truncates it.
//  These tests drive the REAL FileRegistry over the in-memory fakes.

import { describe, test, expect } from 'vitest';
import { FileRegistry } from '../src/core/file-registry';
import { FileEntry, HLC, SyncSettings } from '../src/types';
import { FakeMetadataStore } from './helpers/fakes/metadata-store';
import { FakeVaultFiles } from './helpers/fakes/vault-files';

const REGISTRY_PATH = '.vault-sync/file-registry.json';
const JOURNAL_PATH = '.vault-sync/file-registry.journal';
const hlc: HLC = { wallTime: 1, counter: 0, deviceId: 'dev' };

const settings = (() => ({}) as SyncSettings);

const makeRegistry = (meta: FakeMetadataStore): FileRegistry =>
  new FileRegistry(meta, new FakeVaultFiles(), 'dev', settings);

/** Load a fresh registry over the same on-disk metadata — the "reboot" every
 *  round-trip test hinges on (durable state came from disk, not memory). */
const reload = async (meta: FakeMetadataStore): Promise<FileRegistry> => {
  const reg = makeRegistry(meta);
  await reg.load();
  return reg;
};

/** Capture the exact strings passed to `metadata.append(JOURNAL_PATH, …)`. */
const trackJournalAppends = (meta: FakeMetadataStore): string[] => {
  const deltas: string[] = [];
  const orig = meta.append.bind(meta);
  meta.append = async (p: string, d: string) => {
    if (p === JOURNAL_PATH) deltas.push(d);
    return orig(p, d);
  };
  return deltas;
};

const lines = (s: string): string[] => s.split('\n').filter(l => l !== '');

describe('FileRegistry append-journal — round-trip & replay (§6)', () => {
  test('N entries flushed at a checkpoint round-trip through a reload (Map + pathIndex)', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();

    // Mimic the capture batch: suspend per-mutation saves, mutate, one flush().
    reg.suspendSaves();
    for (let i = 0; i < 50; i++) {
      const id = await reg.registerFile(`notes/n-${i}.md`, hlc, `hash-${i}`, { mtime: i, size: i * 10 });
      await reg.setHeadVersion(id, `v-${i}`);
    }
    reg.resumeSaves();
    await reg.flush();

    const reloaded = await reload(meta);
    // The rebuilt Map is identical — the "zero consumers change" invariant (§0 fact 1).
    expect(reloaded.getAllEntries()).toEqual(reg.getAllEntries());
    // pathIndex was rebuilt from it — a path lookup resolves to the same entry.
    expect(reloaded.getByPath('notes/n-7.md')).toEqual(reg.getByPath('notes/n-7.md'));
    expect(reloaded.getByPath('notes/n-7.md')?.headVersionId).toBe('v-7');
  });

  test('last-write-wins across two separate flushes — the later state wins on reload', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();

    const id = await reg.registerFile('note.md', hlc, 'v1', { mtime: 1, size: 1 });
    await reg.flush();                                  // journal line: content v1
    const hlc2: HLC = { ...hlc, counter: 1 };
    await reg.updateContentHash('note.md', 'v2', hlc2); // journal line: content v2
    await reg.flush();

    const reloaded = await reload(meta);
    expect(reloaded.getById(id)?.contentHash).toBe('v2');   // later line wins
  });

  test('hard delete: adoptRemote drops a divergent duplicate — a {del} line is journalled', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();

    // Local file at note.md under a generated id; then the remote is adopted under a
    // DIFFERENT id at the same path → the local duplicate is hard-dropped from the Map.
    const localId = await reg.registerFile('note.md', hlc, 'local', { mtime: 1, size: 1 });
    await reg.adoptRemote('remote-id', 'note.md', 'remote', hlc);

    // A `{del}` line for the dropped local id is on disk (not merely a tombstone flag).
    const jrnl = (await meta.read(JOURNAL_PATH))!;
    expect(jrnl).toContain(`{"del":"${localId}"}`);

    const reloaded = await reload(meta);
    expect(reloaded.getById(localId)).toBeUndefined();       // dropped id absent
    expect(reloaded.getById('remote-id')?.contentHash).toBe('remote'); // kept id present
    // pathIndex resolves note.md to the surviving remote id, not the dropped one.
    expect(reloaded.getByPath('note.md')?.id).toBe('remote-id');
  });

  test('intra-window collapse: register+setHeadVersion+recordStat on one id → ONE journal line', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();

    const deltas = trackJournalAppends(meta);
    reg.suspendSaves();
    const id = await reg.registerFile('note.md', hlc, 'h', { mtime: 1, size: 1 });
    await reg.setHeadVersion(id, 'v1');
    await reg.recordStat('note.md', 2, 20);
    reg.resumeSaves();
    await reg.flush();

    // Three mutations to the same id collapsed to a single appended line (strictly
    // better than the three writes the old per-mutation autosave would have made).
    expect(deltas).toHaveLength(1);
    expect(lines(deltas[0]!)).toHaveLength(1);

    // …and that one line carries the FINAL state (head + refreshed stat).
    const reloaded = await reload(meta);
    const e = reloaded.getById(id)!;
    expect(e.headVersionId).toBe('v1');
    expect(e.mtime).toBe(2);
    expect(e.size).toBe(20);
  });

  test('torn trailing line (crash mid-append) is dropped on load; the intact prefix survives', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();

    const a = await reg.registerFile('a.md', hlc, 'ha', { mtime: 1, size: 1 });
    const b = await reg.registerFile('b.md', hlc, 'hb', { mtime: 1, size: 1 });
    await reg.flush();

    // Simulate a crash mid-append: a half-written final line is left on the journal.
    const raw = (await meta.read(JOURNAL_PATH))!;
    meta.set(JOURNAL_PATH, raw + '{"id":"c","path":"c.m');   // truncated JSON — unparseable

    const reloaded = await reload(meta);
    // The torn line is dropped; the two intact entries survive, never throws.
    expect(reloaded.getById(a)?.contentHash).toBe('ha');
    expect(reloaded.getById(b)?.contentHash).toBe('hb');
    expect(reloaded.getAllEntries().size).toBe(2);
  });
});

describe('FileRegistry append-journal — compaction (§3)', () => {
  test('compact() folds the journal into the snapshot and truncates it; reload is identical', async () => {
    const meta = new FakeMetadataStore();
    const reg = makeRegistry(meta);
    await reg.load();

    reg.suspendSaves();
    for (let i = 0; i < 20; i++) await reg.registerFile(`n-${i}.md`, hlc, `h-${i}`, { mtime: i, size: i });
    reg.resumeSaves();
    await reg.flush();
    await reg.compact();

    // Journal truncated to empty; snapshot now holds everything.
    expect(await meta.read(JOURNAL_PATH)).toBe('');
    const snap = (await meta.read(REGISTRY_PATH))!;
    // The snapshot is NOT pretty-printed (machine-read; `null, 2` ~doubles the bytes).
    expect(snap).not.toContain('\n');
    expect(JSON.parse(snap).entries).toHaveLength(20);

    const reloaded = await reload(meta);
    expect(reloaded.getAllEntries()).toEqual(reg.getAllEntries());
  });

  test('crash between snapshot write and truncate: the redundant journal replays idempotently', async () => {
    // Simulate the exact §3 crash window: snapshot already reflects the current state,
    // but the truncate never happened, so the journal still holds the same records.
    const meta = new FakeMetadataStore();
    const entryA: FileEntry = {
      id: 'a', path: 'a.md', contentHash: 'v2', hlcTimestamp: hlc,
      deleted: false, lastSyncedPath: null, headVersionId: 'v2',
    };
    meta.set(REGISTRY_PATH, JSON.stringify({ version: 1, entries: [['a', entryA]] }));
    meta.set(JOURNAL_PATH, JSON.stringify(entryA) + '\n');   // redundant, not yet truncated

    const reg = await reload(meta);
    // Last-write-wins onto an already-current snapshot → exactly one entry, correct state.
    expect(reg.getAllEntries().size).toBe(1);
    expect(reg.getById('a')?.contentHash).toBe('v2');
  });
});

describe('FileRegistry append-journal — migration (§5)', () => {
  test('an old pretty-printed snapshot with no journal loads identically; first flush appends a journal', async () => {
    const meta = new FakeMetadataStore();
    const old: FileEntry = {
      id: 'a', path: 'a.md', contentHash: 'h', hlcTimestamp: hlc,
      deleted: false, lastSyncedPath: null, headVersionId: null,
    };
    // Today's on-disk format: flat, pretty-printed, and NO sibling journal.
    meta.set(REGISTRY_PATH, JSON.stringify({ version: 1, entries: [['a', old]] }, null, 2));

    const reg = makeRegistry(meta);
    await reg.load();
    expect(reg.getById('a')).toEqual(old);                 // identical behaviour
    expect(reg.getByPath('a.md')?.id).toBe('a');
    expect(meta.has(JOURNAL_PATH)).toBe(false);            // nothing created yet

    // The first mutation's flush creates the journal (append-only from here on).
    await reg.updateContentHash('a.md', 'h2', hlc);
    expect(meta.has(JOURNAL_PATH)).toBe(true);
    const reloaded = await reload(meta);
    expect(reloaded.getById('a')?.contentHash).toBe('h2');
  });

  test('opportunistic compaction on load folds a journal that dwarfs its snapshot', async () => {
    const meta = new FakeMetadataStore();
    // A tiny snapshot (one entry) with a journal far larger than it — the load-time
    // valve (§3.3) should rewrite the snapshot and clear the journal for free.
    const base: FileEntry = {
      id: 'a', path: 'a.md', contentHash: 'h', hlcTimestamp: hlc,
      deleted: false, lastSyncedPath: null, headVersionId: null,
    };
    meta.set(REGISTRY_PATH, JSON.stringify({ version: 1, entries: [['a', base]] }));
    let jrnl = '';
    for (let i = 0; i < 100; i++) {
      jrnl += JSON.stringify({ ...base, id: `b-${i}`, path: `b-${i}.md` }) + '\n';
    }
    meta.set(JOURNAL_PATH, jrnl);

    const reg = makeRegistry(meta);
    await reg.load();

    // The journal was replayed AND compacted away: it is now empty, the snapshot holds
    // all 101 entries, and a subsequent load reads them with no journal replay at all.
    expect(await meta.read(JOURNAL_PATH)).toBe('');
    expect(JSON.parse((await meta.read(REGISTRY_PATH))!).entries).toHaveLength(101);
    expect(reg.getAllEntries().size).toBe(101);
  });
});
