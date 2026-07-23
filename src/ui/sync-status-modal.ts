// ─────────────────────────────────────────────
//  Sync status modal  (S2)
// ─────────────────────────────────────────────
//
//  The inspectable "current state of sync" surface — replaces the transient
//  8-second Notice. Shows the last round's result, still-pending changes, and
//  anything that needs attention: delete/binary conflicts awaiting a decision, files
//  deferred for on-disk drift (retry automatically), content stranded waiting on a
//  blob, and the last error. The conflicts get an "Open Conflicts panel" action — the
//  panel is where they (and text conflicts) are actually resolved (§3 "full inline").

import { App, Modal, Setting } from 'obsidian';
import { SyncState } from '../network/sync-state-store';

/** Progress of the first-enable capture — the initial pass that scans the local vault
 *  into the registry/op log so there's a DAG to sync from. On a large vault this runs
 *  for minutes, so the modal surfaces how far along it is instead of looking idle. */
export interface IndexingProgress {
  scanned: number;
  total: number;
}

/** The read-only snapshot the modal renders, plus the one action it can trigger. */
export interface SyncStatusSnapshot {
  serverUrl: string;
  fingerprint: string | null;
  deviceId: string;
  /** This device's friendly name (settings) — shown instead of the raw UUID (§5). */
  deviceName: string;
  pendingPaths: string[];
  state: SyncState;
  /** Live progress of the first-enable capture, or null when it isn't running. Read on
   *  each refresh tick (not captured once) so the bar advances while the modal is open. */
  getIndexingProgress: () => IndexingProgress | null;
  /** Open the Conflicts panel — where delete/binary conflicts are resolved (§3).
   *  Closes the modal first. */
  onOpenConflicts: () => void;
}

export class SyncStatusModal extends Modal {
  /** Container for the indexing section, re-rendered on a timer while the first-enable
   *  capture runs so its progress bar advances live. */
  private indexingEl: HTMLElement | null = null;
  private indexingTimer: number | null = null;

  constructor(app: App, private snap: SyncStatusSnapshot) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Vault Sync status' });

    // ── Building sync index (first-enable capture) ────────────────────────────
    // Rendered at the top: while it's running nothing else can sync yet, so it's the
    // most relevant thing. Self-updates on a timer and removes itself when done.
    this.indexingEl = contentEl.createDiv();
    this.renderIndexing();
    if (this.snap.getIndexingProgress()) {
      this.indexingTimer = window.setInterval(() => this.renderIndexing(), 2000);
    }

    const s = this.snap.state;

    // ── Last sync ─────────────────────────────────────────────────────────────
    const last = s.lastSync;
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

    // ── Pending changes ───────────────────────────────────────────────────────
    contentEl.createEl('h3', { text: `Pending changes (${this.snap.pendingPaths.length})` });
    if (this.snap.pendingPaths.length === 0) {
      contentEl.createEl('p', { text: 'Everything is synced.', cls: 'setting-item-description' });
    } else {
      this.pathList(this.snap.pendingPaths);
    }

    // ── Delete/binary conflicts (resolved in the Conflicts panel) ─────────────
    const conflicts = s.conflicts;
    contentEl.createEl('h3', { text: `Needs your attention (${conflicts.length})` });
    if (conflicts.length === 0) {
      contentEl.createEl('p', { text: 'No conflicts waiting.', cls: 'setting-item-description' });
    } else {
      contentEl.createEl('p', {
        text: 'These delete/binary conflicts are waiting for your decision. Your current version is kept until you choose.',
        cls: 'setting-item-description',
      });
      for (const c of conflicts) {
        // Flagged by color, not an emoji (no-emoji UI decision, §5).
        contentEl.createEl('div', {
          text: `${c.path} (${c.kind}) — since ${this.rel(c.at)}`,
          cls: 'setting-item-description vault-sync-status-attention',
        });
      }
      new Setting(contentEl)
        .setName('Resolve conflicts')
        .setDesc('Open the Conflicts panel to choose which version to keep for each.')
        .addButton(btn => {
          btn.setButtonText('Open Conflicts panel').setCta().onClick(() => {
            this.close();
            this.snap.onOpenConflicts();
          });
        });
    }

    // ── Deferred (drift) ──────────────────────────────────────────────────────
    const drift = s.deferred; // deferred is F5-drift only now (conflicts are separate)
    if (drift.length > 0) {
      contentEl.createEl('h3', { text: `Deferred — changed during sync (${drift.length})` });
      contentEl.createEl('p', {
        text: 'These files changed on disk while a sync was in flight, so their incoming update was held. They retry automatically on the next sync.',
        cls: 'setting-item-description',
      });
      this.pathList(drift.map(d => d.path));
    }

    // ── Stranded (missing content) ────────────────────────────────────────────
    if (s.stranded.length > 0) {
      // The stranded items are content blobs identified only by hash — a raw hex
      // fragment means nothing to the user (§5), so we report the count and what it
      // means rather than listing opaque ids.
      const n = s.stranded.length;
      contentEl.createEl('h3', { text: `Waiting on content (${n})` });
      contentEl.createEl('p', {
        text: `${n} incoming change${n !== 1 ? 's were' : ' was'} received but the file content ` +
          "hasn't arrived from the server yet. This retries automatically on the next sync.",
        cls: 'setting-item-description',
      });
    }

    // ── Last error ────────────────────────────────────────────────────────────
    if (s.lastError) {
      contentEl.createEl('h3', { text: 'Last error' });
      contentEl.createEl('p', { text: `${this.rel(s.lastError.at)} — ${s.lastError.message}`, cls: 'setting-item-description' });
    }

    // ── Connection ────────────────────────────────────────────────────────────
    contentEl.createEl('h3', { text: 'Connection' });
    contentEl.createEl('div', {
      text: `Server: ${this.snap.serverUrl || '(not configured)'}`,
      cls: 'setting-item-description',
    });
    contentEl.createEl('div', {
      text: `Vault key: ${this.snap.fingerprint ? `unlocked (${this.snap.fingerprint})` : 'locked'}`,
      cls: 'setting-item-description',
    });
    contentEl.createEl('div', {
      text: `This device: ${this.snap.deviceName || 'unnamed'}`,
      cls: 'setting-item-description',
    });
  }

  onClose() {
    if (this.indexingTimer !== null) {
      window.clearInterval(this.indexingTimer);
      this.indexingTimer = null;
    }
    this.contentEl.empty();
  }

  /** (Re)render the indexing section from live progress. Empties when the capture isn't
   *  running — so the section shows during the first sync and vanishes once it finishes,
   *  at which point the timer is stopped. */
  private renderIndexing(): void {
    const el = this.indexingEl;
    if (!el) return;
    const p = this.snap.getIndexingProgress();
    el.empty();
    if (!p) {
      // Capture finished (or never large enough to report) — nothing more to poll for.
      if (this.indexingTimer !== null) {
        window.clearInterval(this.indexingTimer);
        this.indexingTimer = null;
      }
      return;
    }
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

  private pathList(paths: string[]): void {
    const ul = this.contentEl.createEl('ul', { cls: 'vault-sync-status-list' });
    for (const p of paths.slice(0, 50)) ul.createEl('li', { text: p });
    if (paths.length > 50) {
      this.contentEl.createEl('div', { text: `…and ${paths.length - 50} more`, cls: 'setting-item-description' });
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
