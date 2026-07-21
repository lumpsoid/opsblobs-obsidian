// ─────────────────────────────────────────────
//  Confirm modal — a small reusable yes/no prompt
// ─────────────────────────────────────────────
// A generic confirmation dialog resolving a boolean: `true` if the user confirms,
// `false` if they cancel or dismiss it. Used before any maintenance action that a
// user might want to think twice about (e.g. rebuilding sync metadata).

import { App, Modal } from 'obsidian';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Text on the confirm button (default "Confirm"). */
  confirmText?: string;
  /** Text on the cancel button (default "Cancel"). */
  cancelText?: string;
  /** Style the confirm button as a warning (destructive-looking) action. */
  warning?: boolean;
}

export class ConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private opts: ConfirmOptions,
    private resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.opts.title });
    contentEl.createEl('p', { text: this.opts.message });

    const buttons = contentEl.createDiv({ cls: 'confirm-modal-buttons' });

    const confirmBtn = buttons.createEl('button', {
      text: this.opts.confirmText ?? 'Confirm',
      cls: this.opts.warning ? 'mod-warning' : 'mod-cta',
    });
    confirmBtn.addEventListener('click', () => this.decide(true));

    const cancelBtn = buttons.createEl('button', { text: this.opts.cancelText ?? 'Cancel' });
    cancelBtn.addEventListener('click', () => this.decide(false));
  }

  private decide(confirmed: boolean) {
    this.decided = true;
    this.resolve(confirmed);
    this.close();
  }

  onClose() {
    // Dismissed without choosing — treat as cancel so nothing happens by accident.
    if (!this.decided) this.resolve(false);
    this.contentEl.empty();
  }
}
