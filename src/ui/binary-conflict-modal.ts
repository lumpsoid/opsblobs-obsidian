// ─────────────────────────────────────────────
//  Binary-conflict modal
// ─────────────────────────────────────────────
// Shown when the same binary file (image, PDF, attachment…) was edited on two
// devices concurrently. Binary content can't be three-way merged, so instead of
// silently dropping one side by last-writer-wins the user picks which whole
// version to keep. There is no meaningful content diff to render, so each side
// is presented by filename + metadata (source device, size, modified time).

import { App, Modal } from 'obsidian';
import { MergeAction } from '../types';
import { DEFER_CONFLICT, DeferConflict } from '../network/sync-applicator';

type BinaryConflictAction = Extract<MergeAction, { type: 'binary_conflict' }>;

export class BinaryConflictModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private action: BinaryConflictAction,
    private resolve: (decision: 'keep_local' | 'keep_remote' | DeferConflict) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, action } = this;
    contentEl.createEl('h2', { text: 'Binary file conflict' });
    contentEl.createEl('p', {
      text: `"${action.localPath}" was changed on two devices at once. Binary files ` +
        "can't be merged, so choose which version to keep — the other is kept in the " +
        'sync history and can be recovered later.',
    });

    const sides = contentEl.createDiv({ cls: 'binary-conflict-sides' });
    this.renderSide(sides, 'This device', action.localPath, action.localContent.length, action.localHlc.deviceId, action.localHlc.wallTime);
    this.renderSide(sides, 'Other device', action.remotePath, action.remoteContent.length, action.remoteHlc.deviceId, action.remoteHlc.wallTime);

    const buttons = contentEl.createDiv({ cls: 'binary-conflict-buttons' });

    const localBtn = buttons.createEl('button', { text: "Keep this device's version", cls: 'mod-cta' });
    localBtn.addEventListener('click', () => this.decide('keep_local'));

    const remoteBtn = buttons.createEl('button', { text: "Keep other device's version" });
    remoteBtn.addEventListener('click', () => this.decide('keep_remote'));

    // Explicit defer — mirrors dismissing the modal. Both versions stay in the sync
    // history; the conflict re-presents on the next manual sync.
    const laterBtn = buttons.createEl('button', { text: 'Decide later' });
    laterBtn.addEventListener('click', () => this.decide(DEFER_CONFLICT));
  }

  private renderSide(parent: HTMLElement, label: string, path: string, bytes: number, deviceId: string, wallTime: number): void {
    const el = parent.createDiv({ cls: 'binary-conflict-side' });
    el.createEl('div', { text: label, cls: 'binary-conflict-side-label' });
    el.createEl('div', { text: path });
    el.createEl('div', {
      text: `${formatBytes(bytes)} · device ${deviceId.slice(0, 8)} · ${new Date(wallTime).toLocaleString()}`,
      cls: 'binary-conflict-side-meta',
    });
  }

  private decide(decision: 'keep_local' | 'keep_remote' | DeferConflict) {
    this.decided = true;
    this.resolve(decision);
    this.close();
  }

  onClose() {
    // Dismissed without an explicit choice — defer rather than silently keeping one
    // side. The round holds its cursor so the conflict re-presents next manual sync;
    // both versions remain recoverable and nothing on disk is overwritten (§3).
    if (!this.decided) this.resolve(DEFER_CONFLICT);
    this.contentEl.empty();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
