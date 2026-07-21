// ─────────────────────────────────────────────
//  Sync-state persistence  (S2 — observable sync state)
// ─────────────────────────────────────────────
//
//  The plugin's answer to "what is the current state of sync, and what still
//  needs my attention?" — persisted at `.vault-sync/sync-state.json` so it
//  survives restarts. Distinct from the *cursor* (how far we've consumed the
//  server log): this records the things a normal round would otherwise swallow —
//  a conflict the user skipped, a destructive action deferred because the file
//  drifted mid-round (F5), an op stranded because its blob wasn't available (F3),
//  the last error, and a one-line summary of the last round.
//
//  Obsidian-free (backed by a MetadataStore port) so it's directly unit-testable.
//  It never reads the wall clock itself — callers pass `at`/`firstSeen` in — so
//  the module stays deterministic like the rest of the obsidian-free stack.

import { MetadataStore } from '../ports/metadata-store';

const STATE_PATH = '.vault-sync/sync-state.json';

/** A conflict the user hasn't settled: skipped, dismissed, or (S5) deferred by an
 *  unattended auto-sync. Keyed by fileId so it can be cleared on resolution. */
export interface OutstandingConflict {
  fileId: string;
  path: string;
  kind: 'content' | 'delete' | 'binary';
  firstSeen: number; // wall ms, supplied by the caller
}

/** A destructive merge action skipped because the file changed on disk during the
 *  round (F5). Informational — the round already holds the cursor so it retries. */
export interface DeferredFile {
  fileId: string;
  path: string;
  reason: 'drift';
  at: number;
}

/** An op whose content blob couldn't be fetched this round (F3). Its file is
 *  stranded until the blob appears; the round holds the cursor to retry. */
export interface StrandedContent {
  contentHash: string;
  at: number;
}

export interface SyncRoundSummaryRecord {
  at: number;
  pushed: number;
  pulled: number;
  conflicts: number;
}

/** Everything the status surface needs to explain the current sync state. */
export interface SyncState {
  outstandingConflicts: OutstandingConflict[];
  deferred: DeferredFile[];
  stranded: StrandedContent[];
  lastError: { message: string; at: number } | null;
  lastSync: SyncRoundSummaryRecord | null;
}

function emptyState(): SyncState {
  return { outstandingConflicts: [], deferred: [], stranded: [], lastError: null, lastSync: null };
}

export class SyncStateStore {
  private state: SyncState = emptyState();

  constructor(private metadata: MetadataStore) {}

  /** Current in-memory state (the last loaded/mutated value). */
  get(): SyncState {
    return this.state;
  }

  /** Load persisted state; absent or corrupt → a clean empty state (never throws,
   *  so a garbled file can't wedge the plugin — worst case we lose the advisory
   *  record, never vault data). */
  async load(): Promise<SyncState> {
    const raw = await this.metadata.read(STATE_PATH);
    if (raw === null) {
      this.state = emptyState();
      return this.state;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SyncState>;
      this.state = {
        outstandingConflicts: Array.isArray(parsed.outstandingConflicts) ? parsed.outstandingConflicts : [],
        deferred: Array.isArray(parsed.deferred) ? parsed.deferred : [],
        stranded: Array.isArray(parsed.stranded) ? parsed.stranded : [],
        lastError: parsed.lastError ?? null,
        lastSync: parsed.lastSync ?? null,
      };
    } catch {
      this.state = emptyState();
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    if (!(await this.metadata.exists('.vault-sync'))) {
      await this.metadata.mkdir('.vault-sync');
    }
    await this.metadata.write(STATE_PATH, JSON.stringify(this.state, null, 2));
  }

  /** Directly overwrite the whole state (rare — mostly tests / a reset). */
  async save(state: SyncState): Promise<void> {
    this.state = state;
    await this.persist();
  }

  // ─── Mutators ───────────────────────────────────────────────────────────────

  /** Record an unresolved conflict, deduped by fileId (a re-skip of the same file
   *  updates nothing rather than piling up duplicates). */
  async recordConflict(entry: OutstandingConflict): Promise<void> {
    if (!this.state.outstandingConflicts.some(c => c.fileId === entry.fileId)) {
      this.state.outstandingConflicts.push(entry);
      await this.persist();
    }
  }

  /** Drop a conflict once the user has resolved it. No-op if not present. */
  async clearConflict(fileId: string): Promise<void> {
    const before = this.state.outstandingConflicts.length;
    this.state.outstandingConflicts = this.state.outstandingConflicts.filter(c => c.fileId !== fileId);
    if (this.state.outstandingConflicts.length !== before) await this.persist();
  }

  /** Drop every outstanding conflict. Used by "Re-check for conflicts", which
   *  replays the whole server log — any still-genuine conflict is re-recorded
   *  during that round, so wiping first self-heals badges left stuck by a file
   *  that resolved automatically without re-entering the conflict handler. */
  async clearAllConflicts(): Promise<void> {
    if (this.state.outstandingConflicts.length === 0) return;
    this.state.outstandingConflicts = [];
    await this.persist();
  }

  /** Replace the last-round summary and the transient per-round lists
   *  (deferred/stranded) with this round's outcome. */
  async setRound(record: SyncRoundSummaryRecord, deferred: DeferredFile[], stranded: StrandedContent[]): Promise<void> {
    this.state.lastSync = record;
    this.state.deferred = deferred;
    this.state.stranded = stranded;
    await this.persist();
  }

  async setError(message: string, at: number): Promise<void> {
    this.state.lastError = { message, at };
    await this.persist();
  }

  async clearError(): Promise<void> {
    if (this.state.lastError !== null) {
      this.state.lastError = null;
      await this.persist();
    }
  }
}
