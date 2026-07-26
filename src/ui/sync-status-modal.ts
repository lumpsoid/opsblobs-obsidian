// ─────────────────────────────────────────────
//  Sync status modal  (S2 → redesigned per docs/sync-status-modal-redesign-spec.md)
// ─────────────────────────────────────────────
//
//  A live "what's happening / what needs me" glance, grouped by actionability
//  rather than chronology:
//    1. Live progress (first-enable indexing / in-flight sync round) — unchanged.
//    2. Last error, with a Dismiss action.
//    3. Needs your attention — a one-line conflict count + "Open Conflicts panel".
//       The per-conflict list lives in ConflictsView, not here (no duplication).
//    4. Waiting to sync — one line of pending/deferred/stranded counts + "View
//       details", which opens the new PendingChangesView main-area tab.
//    5. Last sync one-liner.
//  Connection info (server/fingerprint/device) is dropped from the modal
//  entirely — it lives in settings-tab.ts, which already owns configuring it.

import { App, Modal, Setting } from 'obsidian';
import { SyncState } from '../network/sync-state-store';

/** Progress of the first-enable capture — the initial pass that scans the local vault
 *  into the registry/op log so there's a DAG to sync from. On a large vault this runs
 *  for minutes, so the modal surfaces how far along it is instead of looking idle. */
export interface IndexingProgress {
  scanned: number;
  total: number;
}

/** Live progress of the blob-upload phase of a push `(uploaded, total)` — the first
 *  sync of a large vault uploads one blob per note and can run for minutes, so the
 *  modal draws a determinate bar from these counts. */
export interface UploadProgress {
  uploaded: number;
  total: number;
}

/** The read-only snapshot the modal renders, plus the actions it can trigger. */
export interface SyncStatusSnapshot {
  /** Two-headed text conflicts + auto-deferred delete/binary conflicts — the same
   *  derived count the ribbon/status-bar use. Replaces rendering `state.conflicts`
   *  in full; ConflictsView owns the per-conflict listing. */
  conflictCount: number;
  /** The three "not yet fully synced" states, combined into one summary line. */
  waitingCounts: { pending: number; deferred: number; stranded: number };
  state: SyncState;
  /** Live progress of the first-enable capture, or null when it isn't running. Read on
   *  each refresh tick (not captured once) so the bar advances while the modal is open. */
  getIndexingProgress: () => IndexingProgress | null;
  /** The current phase of an in-flight sync round ("Pulling changes…", "Uploading
   *  files 340/8000…", "Merging…"), or null when no round is running. Read on each tick
   *  so the modal is a live "what's happening right now" surface — the mobile answer to
   *  the missing status bar. */
  getSyncActivity: () => string | null;
  /** Live blob-upload counts for a determinate bar during the push, or null. The phase
   *  label from {@link getSyncActivity} carries the same counts as text. */
  getUploadProgress: () => UploadProgress | null;
  /** Open the Conflicts panel — where delete/binary conflicts are resolved (§3).
   *  Closes the modal first. */
  onOpenConflicts: () => void;
  /** Open the PendingChangesView — where the full pending/deferred/stranded detail
   *  lives. Closes the modal first. */
  onOpenPendingChanges: () => void;
  /** Dismiss the last error (`syncState.clearError()`). Does not fix the underlying
   *  cause — if the same failure recurs on the next sync, the section reappears. */
  onDismissError: () => void;
}

export class SyncStatusModal extends Modal {
  /** Containers for the two live sections (first-enable indexing and the in-flight sync
   *  round), re-rendered on a timer while the modal is open so their progress advances
   *  live. A single timer runs for the whole time the modal is open — so activity that
   *  *starts* after the modal opens (or the indexing→push transition) is still caught. */
  private indexingEl: HTMLElement | null = null;
  private activityEl: HTMLElement | null = null;
  private liveTimer: number | null = null;

  constructor(app: App, private snap: SyncStatusSnapshot) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'OpsBlobs status' });

    // ── Live progress (first-enable indexing, then the in-flight round) ───────────
    // Rendered at the top: while either is running it's the most relevant thing. Both
    // self-update on one shared timer and remove themselves when nothing is running.
    this.indexingEl = contentEl.createDiv();
    this.activityEl = contentEl.createDiv();
    this.renderLive();
    // Poll while the modal is open (cheap DOM diff). Unconditional so a round that
    // begins *after* the modal is open still shows — the user's common flow is to
    // start a long sync, then open this to check it's moving.
    this.liveTimer = window.setInterval(() => this.renderLive(), 2000);

    // ── Last error, with a Dismiss action ─────────────────────────────────────
    this.renderError(contentEl.createDiv());

    // ── Needs your attention (conflicts) ──────────────────────────────────────
    contentEl.createEl('h3', { text: 'Needs your attention' });
    if (this.snap.conflictCount === 0) {
      contentEl.createEl('p', { text: 'No conflicts waiting.', cls: 'setting-item-description' });
    } else {
      const n = this.snap.conflictCount;
      new Setting(contentEl)
        .setName(`${n} conflict${n !== 1 ? 's' : ''} waiting`)
        .setDesc('Open the Conflicts panel to choose which version to keep for each.')
        .addButton(btn => {
          btn.setButtonText('Open Conflicts panel').setCta().onClick(() => {
            this.close();
            this.snap.onOpenConflicts();
          });
        });
    }

    // ── Waiting to sync (pending / deferred / stranded, combined) ─────────────
    contentEl.createEl('h3', { text: 'Waiting to sync' });
    const { pending, deferred, stranded } = this.snap.waitingCounts;
    if (pending + deferred + stranded === 0) {
      contentEl.createEl('p', { text: 'Everything is synced.', cls: 'setting-item-description' });
    } else {
      const parts: string[] = [];
      if (pending > 0) parts.push(`${pending} pending`);
      if (deferred > 0) parts.push(`${deferred} deferred`);
      if (stranded > 0) parts.push(`${stranded} waiting on content`);
      new Setting(contentEl)
        .setName(parts.join(' · '))
        .addButton(btn => {
          btn.setButtonText('View details').onClick(() => {
            this.close();
            this.snap.onOpenPendingChanges();
          });
        });
    }

    // ── Last sync ─────────────────────────────────────────────────────────────
    const last = this.snap.state.lastSync;
    contentEl.createEl('h3', { text: 'Last sync' });
    if (last) {
      contentEl.createEl('p', {
        text: `${this.rel(last.at)} — pushed ${last.pushed}, pulled ${last.pulled}` +
          (last.conflicts > 0 ? `, ${last.conflicts} conflict(s)` : ''),
        cls: 'setting-item-description',
      });
    } else {
      contentEl.createEl('p', { text: 'Never synced.', cls: 'setting-item-description' });
    }
  }

  onClose() {
    if (this.liveTimer !== null) {
      window.clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    this.contentEl.empty();
  }

  /** (Re)render the last-error section into `el`, or leave it empty when there is
   *  none. Dismissing calls the host action and empties `el` immediately — no need
   *  to close/reopen the modal or re-render anything else. */
  private renderError(el: HTMLElement): void {
    el.empty();
    const err = this.snap.state.lastError;
    if (!err) return;
    el.createEl('h3', { text: 'Last error' });
    el.createEl('p', { text: `${this.rel(err.at)} — ${err.message}`, cls: 'setting-item-description' });
    new Setting(el)
      .addButton(btn => {
        btn.setButtonText('Dismiss').onClick(() => {
          this.snap.onDismissError();
          el.empty();
        });
      });
  }

  /** Re-render both live sections from the latest progress. Called on open and on every
   *  timer tick; the timer itself only stops when the modal closes, so a section can
   *  appear, advance, and vanish (and a later one appear) all within one open modal. */
  private renderLive(): void {
    this.renderIndexing();
    this.renderActivity();
  }

  /** (Re)render the first-enable indexing section, or empty it when the capture isn't
   *  running — so it shows during the initial scan and vanishes once that finishes. */
  private renderIndexing(): void {
    const el = this.indexingEl;
    if (!el) return;
    const p = this.snap.getIndexingProgress();
    el.empty();
    if (!p) return;
    const pct = p.total > 0 ? Math.min(100, Math.round((p.scanned / p.total) * 100)) : 0;
    el.createEl('h3', { text: 'Building sync index' });
    el.createEl('p', {
      text: 'Scanning your vault to prepare it for its first sync. This runs once and ' +
        'syncing starts as soon as it finishes.',
      cls: 'setting-item-description',
    });
    const bar = el.createDiv({ cls: 'vault-sync-indexing-bar' });
    bar.createDiv({ cls: 'vault-sync-indexing-fill' }).style.width = `${pct}%`;
    el.createEl('div', {
      text: `${p.scanned} of ${p.total} files (${pct}%)`,
      cls: 'setting-item-description',
    });
  }

  /** (Re)render the in-flight sync-round section: the current phase label, plus a
   *  determinate bar while uploading (the minutes-long push) and an indeterminate
   *  moving bar for phases without a count (pull/merge). Empties when idle — so opening
   *  the modal mid-sync answers "what's happening right now?" without a status bar. */
  private renderActivity(): void {
    const el = this.activityEl;
    if (!el) return;
    const label = this.snap.getSyncActivity();
    el.empty();
    if (!label) return;
    el.createEl('h3', { text: 'Sync in progress' });
    el.createEl('p', { text: label, cls: 'setting-item-description' });
    const upload = this.snap.getUploadProgress();
    if (upload && upload.total > 0) {
      // Determinate: the push is the long phase, and a filling bar shows real headway.
      const pct = Math.min(100, Math.round((upload.uploaded / upload.total) * 100));
      const bar = el.createDiv({ cls: 'vault-sync-indexing-bar' });
      bar.createDiv({ cls: 'vault-sync-indexing-fill' }).style.width = `${pct}%`;
      el.createEl('div', {
        text: `${upload.uploaded} of ${upload.total} files (${pct}%)`,
        cls: 'setting-item-description',
      });
    } else {
      // Indeterminate: a moving stripe just says "working" for a phase with no count.
      const bar = el.createDiv({ cls: 'vault-sync-indexing-bar' });
      bar.createDiv({ cls: 'vault-sync-indexing-fill vault-sync-indexing-indeterminate' });
    }
  }

  private rel(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 0) return 'just now';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
