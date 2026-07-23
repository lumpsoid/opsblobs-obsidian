// ─────────────────────────────────────────────
//  Sync-state persistence  (S2 — observable sync state)
// ─────────────────────────────────────────────
//
//  The plugin's answer to "what is the current state of sync, and what still
//  needs my attention?" — persisted at `.vault-sync/sync-state.json` so it
//  survives restarts. Distinct from the *cursor* (how far we've consumed the
//  server log): this records the things a normal round would otherwise swallow —
//  a destructive action deferred because the file drifted mid-round (F5), a
//  delete/binary conflict an unattended auto-round deferred (S5), an op stranded
//  because its blob wasn't available (F3), the last error, and a one-line summary
//  of the last round.
//
//  Note (sync v2 Step 7): text "conflicts" is NOT a hand-maintained set here — it's
//  the *derived* two-headed files (a query over the registry's `conflictParents`).
//  Delete/binary conflicts, however, have no on-disk marker to derive from, so they
//  ARE recorded here as `conflicts` descriptors (UX audit §3, "full inline"): the
//  Conflicts panel renders them and the user resolves them there, recording a
//  `pendingDecisions` entry the next round consumes. Both lists are rebuilt each round
//  from what the round deferred (the held cursor re-surfaces them until resolved), and
//  pending decisions self-heal to the live conflict set — no clear/self-heal bookkeeping.
//
//  Obsidian-free (backed by a MetadataStore port) so it's directly unit-testable.
//  It never reads the wall clock itself — callers pass `at`/`firstSeen` in — so
//  the module stays deterministic like the rest of the obsidian-free stack.

import { MetadataStore } from '../ports/metadata-store';

const STATE_PATH = '.vault-sync/sync-state.json';

/** A merge action the round declined to apply because the file changed on disk during
 *  the sync window (F5): the cursor is held so it re-pulls and re-merges. Retries (and
 *  typically resolves) on the next sync — no user action needed. Delete/binary
 *  conflicts, which DO need a decision, are recorded separately as {@link ConflictDescriptor}.
 *  Derived fresh from the round summary each round (not an accumulating set). */
export interface DeferredFile {
  fileId: string;
  path: string;
  at: number;
}

/** A delete/binary conflict awaiting the user's decision in the Conflicts panel (UX
 *  audit §3, "full inline"). Unlike a text conflict (derived from the registry's
 *  two-headed files), these carry the side metadata the panel renders — there is no
 *  on-disk marker to parse — so they are persisted here. Rebuilt each round from the
 *  conflicts the round deferred; the held cursor re-surfaces them until resolved. */
export interface ConflictDescriptor {
  fileId: string;
  path: string;
  kind: 'delete' | 'binary';
  at: number;
  /** delete/modify: which side deleted the file (the other side modified it). */
  side?: 'local_deleted' | 'remote_deleted';
  /** binary: the two versions' sizes, authoring devices, and times, for the picker. */
  binary?: {
    localBytes: number; remoteBytes: number;
    localDevice: string; remoteDevice: string;
    localAt: number; remoteAt: number;
  };
}

/** The user's inline resolution of a {@link ConflictDescriptor}, recorded from the
 *  panel and consumed by the next sync round's applicator (which mints the merge
 *  node). Keyed by fileId in {@link SyncState.pendingDecisions}. */
export type ConflictDecision =
  | { kind: 'delete'; decision: 'keep_deleted' | 'restore' }
  | { kind: 'binary'; decision: 'keep_local' | 'keep_remote' };

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
  /** F5 drift — retries automatically. */
  deferred: DeferredFile[];
  /** Delete/binary conflicts awaiting a decision in the Conflicts panel. */
  conflicts: ConflictDescriptor[];
  /** The user's inline decisions, keyed by fileId, awaiting the next round. */
  pendingDecisions: Record<string, ConflictDecision>;
  stranded: StrandedContent[];
  lastError: { message: string; at: number } | null;
  lastSync: SyncRoundSummaryRecord | null;
}

function emptyState(): SyncState {
  return { deferred: [], conflicts: [], pendingDecisions: {}, stranded: [], lastError: null, lastSync: null };
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
        deferred: Array.isArray(parsed.deferred) ? parsed.deferred : [],
        conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
        pendingDecisions: (parsed.pendingDecisions && typeof parsed.pendingDecisions === 'object')
          ? parsed.pendingDecisions : {},
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

  /** Replace the last-round summary and the transient per-round lists (deferred /
   *  conflicts / stranded) with this round's outcome, and self-heal `pendingDecisions`
   *  down to the still-live conflict set — a decision whose conflict is gone (consumed
   *  and resolved, or vanished) is dropped, so the map can't leak stale entries. */
  async setRound(
    record: SyncRoundSummaryRecord,
    deferred: DeferredFile[],
    stranded: StrandedContent[],
    conflicts: ConflictDescriptor[] = [],
  ): Promise<void> {
    this.state.lastSync = record;
    this.state.deferred = deferred;
    this.state.stranded = stranded;
    this.state.conflicts = conflicts;
    const live = new Set(conflicts.map(c => c.fileId));
    for (const id of Object.keys(this.state.pendingDecisions)) {
      if (!live.has(id)) delete this.state.pendingDecisions[id];
    }
    await this.persist();
  }

  /** Record the user's inline resolution of a delete/binary conflict (from the panel);
   *  the next sync round's applicator consumes it and mints the merge node. */
  async recordDecision(fileId: string, decision: ConflictDecision): Promise<void> {
    this.state.pendingDecisions[fileId] = decision;
    await this.persist();
  }

  /** The user's pending decision for a fileId, if any. */
  getDecision(fileId: string): ConflictDecision | undefined {
    return this.state.pendingDecisions[fileId];
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
