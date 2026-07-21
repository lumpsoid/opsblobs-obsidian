// ─────────────────────────────────────────────
//  Sync status modal  (S2)
// ─────────────────────────────────────────────
//
//  The inspectable "current state of sync" surface — replaces the transient
//  8-second Notice. Shows the last round's result, still-pending changes, and
//  anything that needs attention: conflicts the user skipped, files deferred for
//  on-disk drift, content stranded waiting on a blob, and the last error. Each
//  outstanding conflict gets a "Resolve now" action that re-pulls the history so
//  the conflict is re-presented (via the host's recheckConflicts).

import { App, Modal, Setting } from 'obsidian';
import { SyncState } from '../network/sync-state-store';

/** The read-only snapshot the modal renders, plus the one action it can trigger. */
export interface SyncStatusSnapshot {
  serverUrl: string;
  fingerprint: string | null;
  deviceId: string;
  pendingPaths: string[];
  state: SyncState;
  /** Re-pull the whole history and recompute merges, bringing back a skipped
   *  conflict. Closes the modal and runs a sync. */
  onResolveConflicts: () => void;
}

export class SyncStatusModal extends Modal {
  constructor(app: App, private snap: SyncStatusSnapshot) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Vault sync status' });

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

    // ── Outstanding conflicts ─────────────────────────────────────────────────
    const conflicts = s.outstandingConflicts;
    contentEl.createEl('h3', { text: `Needs your attention (${conflicts.length})` });
    if (conflicts.length === 0) {
      contentEl.createEl('p', { text: 'No skipped or unresolved conflicts.', cls: 'setting-item-description' });
    } else {
      contentEl.createEl('p', {
        text: 'You skipped or dismissed these conflicts. Your current version is kept until you resolve them.',
        cls: 'setting-item-description',
      });
      for (const c of conflicts) {
        contentEl.createEl('div', { text: `⚠️ ${c.path} (${c.kind}) — since ${this.rel(c.firstSeen)}`, cls: 'setting-item-description' });
      }
      new Setting(contentEl)
        .setName('Resolve skipped conflicts')
        .setDesc('Re-pull the full history and re-present each conflict for resolution.')
        .addButton(btn => {
          btn.setButtonText('Resolve now').setCta().onClick(() => {
            this.close();
            this.snap.onResolveConflicts();
          });
        });
    }

    // ── Deferred (drift) ──────────────────────────────────────────────────────
    if (s.deferred.length > 0) {
      contentEl.createEl('h3', { text: `Deferred — changed during sync (${s.deferred.length})` });
      contentEl.createEl('p', {
        text: 'These files changed on disk while a sync was in flight, so their incoming update was held. They retry automatically on the next sync.',
        cls: 'setting-item-description',
      });
      this.pathList(s.deferred.map(d => d.path));
    }

    // ── Stranded (missing content) ────────────────────────────────────────────
    if (s.stranded.length > 0) {
      contentEl.createEl('h3', { text: `Waiting on content (${s.stranded.length})` });
      contentEl.createEl('p', {
        text: 'A change was received but its content blob was not available yet. It retries automatically on the next sync.',
        cls: 'setting-item-description',
      });
      this.pathList(s.stranded.map(h => h.contentHash.slice(0, 12) + '…'));
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
      text: `Vault key: ${this.snap.fingerprint ? `ready (${this.snap.fingerprint})` : 'not derived'}`,
      cls: 'setting-item-description',
    });
    contentEl.createEl('div', {
      text: `Device ID: ${this.snap.deviceId.slice(0, 8)}…`,
      cls: 'setting-item-description',
    });
  }

  onClose() {
    this.contentEl.empty();
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
