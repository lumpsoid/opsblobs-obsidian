// ─────────────────────────────────────────────
//  Perf log viewer — a main-area tab over .opsblobs/perf-log.txt
// ─────────────────────────────────────────────
//
//  The perf log (perf baseline, Layer 3) lives at `.opsblobs/perf-log.txt` — a
//  dotfolder that is effectively unreachable on iOS, where the Files app hides
//  dot-prefixed folders and Obsidian's mobile file explorer never shows them. This
//  ItemView surfaces the file's contents in a first-class tab (not a sidebar drawer —
//  a tab reads far better on mobile, matching the conflicts-view precedent) so a
//  user can read, copy, or clear the log on-device without a desktop file pull.
//
//  Obsidian glue only: the plugin supplies read/clear through {@link PerfLogViewHost};
//  the view just renders text.

import { ButtonComponent, ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { ConfirmModal } from './confirm-modal';

export const PERF_LOG_VIEW_TYPE = 'vault-sync-perf-log';

/** The narrow surface the viewer needs from the plugin — keeps it decoupled from
 *  plugin internals (and from `obsidian` beyond rendering). */
export interface PerfLogViewHost {
  /** The perf log's vault-relative path, shown so the user knows what they're reading. */
  perfLogPath: string;
  /** Whether the `perfLog` diagnostic is currently on — drives an inline hint when a
   *  user opens an empty log without having enabled logging. */
  perfLogEnabled(): boolean;
  /** Current contents of the perf log, or null when the file doesn't exist yet. */
  readPerfLog(): Promise<string | null>;
  /** Delete the perf log so it starts fresh (a new round/startup re-creates it). */
  clearPerfLog(): Promise<void>;
}

export class PerfLogView extends ItemView {
  /** Guards against overlapping async renders clobbering each other. */
  private renderToken = 0;

  constructor(leaf: WorkspaceLeaf, private host: PerfLogViewHost) {
    super(leaf);
  }

  getViewType(): string { return PERF_LOG_VIEW_TYPE; }
  getDisplayText(): string { return 'Sync perf log'; }
  getIcon(): string { return 'gauge'; }

  async onOpen(): Promise<void> {
    await this.render();
  }

  /** Public so the plugin can force a refresh (e.g. right after a sync round). */
  refresh(): void { void this.render(); }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const content = await this.host.readPerfLog();
    if (token !== this.renderToken) return; // a newer render superseded us

    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('vault-sync-perf-log-view');

    const header = root.createDiv('vault-sync-perf-log-header');
    header.createEl('h3', { text: 'Sync perf log' });
    header.createEl('div', { cls: 'vault-sync-perf-log-path', text: this.host.perfLogPath });

    const text = content ?? '';
    const lineCount = text ? text.trimEnd().split('\n').length : 0;
    header.createEl('div', {
      cls: 'vault-sync-perf-log-count',
      text: lineCount === 0 ? 'Log is empty.' : `${lineCount} line${lineCount === 1 ? '' : 's'}.`,
    });

    // Actions: Refresh re-reads (the log grows out-of-band as sync runs), Copy exports
    // the whole log to the clipboard (the practical way off a phone), Clear truncates it.
    const actions = root.createDiv('vault-sync-perf-log-actions');
    new ButtonComponent(actions)
      .setButtonText('Refresh')
      .onClick(() => { void this.render(); });
    new ButtonComponent(actions)
      .setButtonText('Copy')
      .setDisabled(text.length === 0)
      .onClick(() => { void this.copyToClipboard(text); });
    new ButtonComponent(actions)
      .setButtonText('Clear')
      .setWarning()
      .setDisabled(text.length === 0)
      .onClick(() => { void this.confirmClear(); });

    if (text.length === 0) {
      const empty = root.createDiv('vault-sync-perf-log-empty');
      empty.setText(
        this.host.perfLogEnabled()
          ? 'Nothing logged yet — run a sync or restart Obsidian to capture timings.'
          : 'Performance logging is off. Turn it on in Settings → Diagnostics, then sync to capture timings here.',
      );
      return;
    }

    // A read-only <pre> — the raw log is line-oriented and reads best verbatim.
    root.createEl('pre', { cls: 'vault-sync-perf-log-body', text });
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice('Perf log copied to clipboard.');
    } catch {
      new Notice('Could not copy — clipboard is unavailable on this device.');
    }
  }

  private async confirmClear(): Promise<void> {
    const confirmed = await new Promise<boolean>(resolve => {
      new ConfirmModal(this.app, {
        title: 'Clear perf log?',
        message: 'This deletes .opsblobs/perf-log.txt. A new sync or restart starts a fresh log.',
        confirmText: 'Clear',
        warning: true,
      }, resolve).open();
    });
    if (!confirmed) return;
    await this.host.clearPerfLog();
    await this.render();
  }
}
