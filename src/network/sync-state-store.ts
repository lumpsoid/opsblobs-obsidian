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
//  Note (sync v2 Step 7): "conflicts" is NO LONGER a hand-maintained set here.
//  Text conflicts are the *derived* two-headed files (a query over the registry's
//  `conflictParents`), and the remaining delete/binary auto-defers are just this
//  round's `deferred` entries tagged `reason: 'conflict'` — replaced wholesale
//  every round (the held cursor re-surfaces them, so no record/clear/self-heal
//  bookkeeping is needed).
//
//  Obsidian-free (backed by a MetadataStore port) so it's directly unit-testable.
//  It never reads the wall clock itself — callers pass `at`/`firstSeen` in — so
//  the module stays deterministic like the rest of the obsidian-free stack.

import { MetadataStore } from '../ports/metadata-store';

const STATE_PATH = '.vault-sync/sync-state.json';

/** A merge action the round declined to apply this round, holding the cursor so it
 *  re-pulls and re-merges. Two reasons, distinguished for the UI:
 *   · `'drift'`    — the file changed on disk during the sync window (F5); it retries
 *                    (and typically resolves) on the next sync, no user action needed.
 *   · `'conflict'` — an unattended auto-round deferred a delete/binary conflict (S5);
 *                    it needs a *manual* sync to open the resolution modal.
 *  Derived fresh from the round summary each round (not an accumulating set). */
export interface DeferredFile {
  fileId: string;
  path: string;
  reason: 'drift' | 'conflict';
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
  deferred: DeferredFile[];
  stranded: StrandedContent[];
  lastError: { message: string; at: number } | null;
  lastSync: SyncRoundSummaryRecord | null;
}

function emptyState(): SyncState {
  return { deferred: [], stranded: [], lastError: null, lastSync: null };
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
