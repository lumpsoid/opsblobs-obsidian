// ─────────────────────────────────────────────
//  Version-DAG persistence  (sync v2 — snapshot + append-only journal)
// ─────────────────────────────────────────────
//
//  Persists the content {@link VersionDag} via a `MetadataStore` port (so it stays
//  obsidian-free and directly testable). Modeled on cursor-store.ts. A missing or
//  corrupt file loads as an empty DAG — never throws — so a fresh device or a
//  partial write can't wedge a sync round.
//
//  Storage is two files, Git-style, so a round persists only its *new* edges:
//    · `version-dag.json` — the compacted snapshot (the whole graph as of the last
//      compaction; the pre-journal format, so old single-file installs load as-is).
//    · `version-dag.log`  — an append-only JSONL journal of edges recorded since,
//      one compact record per new version.
//  `load()` = snapshot ⊕ journal-replay. A round `appendEdges` only the edges that
//  actually changed the graph (O(new versions), not O(graph)); the O(N) full
//  rewrite happens only at `compact()`, once the journal crosses a threshold. This
//  turns the former per-round full rewrite — whose torn-write window grew with the
//  graph — into a small append, and shrinks the corruption blast radius.

import { MetadataStore } from '../ports/metadata-store';
import { VersionDag } from '../core/version-dag';

const SNAPSHOT_PATH = '.vault-sync/version-dag.json';
const JOURNAL_PATH = '.vault-sync/version-dag.log';

/** Compact (fold the journal into a fresh snapshot, then clear it) once the
 *  journal reaches this many appended edges — so the O(N) full rewrite happens
 *  ~once per this many new versions rather than every round. */
const COMPACT_THRESHOLD = 500;

/** One journaled edge — compact single-letter keys keep the hot-path file small.
 *  `v` versionId · `p` parents · `c` contentHash · `f` fileId. */
export interface EdgeRecord {
  v: string;
  p: string[];
  c: string;
  f: string;
}

export class VersionDagStore {
  constructor(private metadata: MetadataStore) {}

  /**
   * Load the DAG: the compacted snapshot, then every edge appended to the journal
   * since the last compaction, replayed on top. Both layers are corruption-
   * tolerant — a snapshot that won't parse loads as empty, and an unparseable
   * journal line (a torn trailing append) is skipped — so a partial write can
   * never wedge a round. Edge replay is idempotent (`addVersion` unions), so a
   * journal that still holds edges already in the snapshot (a crash between the
   * snapshot write and the journal clear) is harmless.
   */
  async load(): Promise<VersionDag> {
    const dag = await this.loadSnapshot();
    const journal = await this.metadata.read(JOURNAL_PATH);
    if (journal) {
      for (const line of journal.split('\n')) {
        if (!line) continue;
        let rec: EdgeRecord | null = null;
        try { rec = JSON.parse(line) as EdgeRecord; } catch { continue; } // torn/partial line — skip
        if (rec && typeof rec.v === 'string') {
          dag.addVersion(
            rec.v,
            Array.isArray(rec.p) ? rec.p.filter((p): p is string => typeof p === 'string') : [],
            typeof rec.c === 'string' ? rec.c : '',
            typeof rec.f === 'string' ? rec.f : '',
          );
        }
      }
    }
    return dag;
  }

  private async loadSnapshot(): Promise<VersionDag> {
    const raw = await this.metadata.read(SNAPSHOT_PATH);
    if (raw === null) return new VersionDag();
    try {
      return VersionDag.fromJSON(JSON.parse(raw));
    } catch {
      return new VersionDag();
    }
  }

  /**
   * Append newly-recorded edges to the journal — O(new edges), not O(graph). The
   * caller must pass only edges that actually changed the graph (`addVersion`
   * returned true); re-recorded ops (our own re-pull every round) would otherwise
   * bloat the journal without end.
   */
  async appendEdges(records: EdgeRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureDir();
    const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await this.metadata.append(JOURNAL_PATH, lines);
  }

  /** Whether the journal has grown past the compaction threshold. Cheap — the
   *  journal is bounded by the threshold, and it's only consulted after a round
   *  actually appended something. */
  async shouldCompact(): Promise<boolean> {
    const journal = await this.metadata.read(JOURNAL_PATH);
    if (!journal) return false;
    let lines = 0;
    for (const line of journal.split('\n')) {
      if (line && ++lines >= COMPACT_THRESHOLD) return true;
    }
    return false;
  }

  /**
   * Fold the whole in-memory DAG into a fresh snapshot and clear the journal. The
   * snapshot is written FIRST (atomically, via `MetadataStore.write`) and only
   * then is the journal removed, so a crash in between replays already-snapshotted
   * edges (idempotent) rather than losing them. This is the one O(N) write, paid
   * ~once per {@link COMPACT_THRESHOLD} new versions.
   */
  async compact(dag: VersionDag): Promise<void> {
    await this.ensureDir();
    await this.metadata.write(SNAPSHOT_PATH, JSON.stringify(dag.toJSON()));
    if (await this.metadata.exists(JOURNAL_PATH)) {
      await this.metadata.remove(JOURNAL_PATH);
    }
  }

  /** Persist the whole DAG wholesale as a fresh snapshot (folding away any
   *  journal). Equivalent to a forced {@link compact}; kept for callers that hold
   *  the entire graph and want it flushed. The round persists incrementally via
   *  {@link appendEdges} + {@link compact}. */
  async save(dag: VersionDag): Promise<void> {
    await this.compact(dag);
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.metadata.exists('.vault-sync'))) {
      await this.metadata.mkdir('.vault-sync');
    }
  }
}
