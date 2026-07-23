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
  /** Escalate to a type-to-confirm gate (UX audit §4): the confirm button stays
   *  disabled until the user types this exact phrase, so the most dangerous actions
   *  can't be fired by a single reflexive click. Also renders the button in the
   *  loud danger style. */
  requireTyped?: string;
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

    const typed = this.opts.requireTyped;

    const buttons = contentEl.createDiv({ cls: 'confirm-modal-buttons' });

    const confirmBtn = buttons.createEl('button', {
      text: this.opts.confirmText ?? 'Confirm',
      cls: (this.opts.warning || typed) ? 'mod-warning' : 'mod-cta',
    });
    if (typed) confirmBtn.addClass('vault-sync-danger-btn');
    confirmBtn.addEventListener('click', () => this.decide(true));

    const cancelBtn = buttons.createEl('button', { text: this.opts.cancelText ?? 'Cancel' });
    cancelBtn.addEventListener('click', () => this.decide(false));

    // Type-to-confirm gate: keep the confirm button disabled until the phrase matches.
    // The hint + input sit above the buttons so the escalation is obvious, not hidden.
    if (typed) {
      const hint = contentEl.createEl('p', {
        text: `Type “${typed}” below to enable the button.`,
        cls: 'setting-item-description',
      });
      const input = contentEl.createEl('input', { type: 'text', cls: 'vault-sync-confirm-input' });
      input.placeholder = typed;
      confirmBtn.disabled = true;
      input.addEventListener('input', () => { confirmBtn.disabled = input.value.trim() !== typed; });
      contentEl.insertBefore(hint, buttons);
      contentEl.insertBefore(input, buttons);
      window.setTimeout(() => input.focus(), 0);
    }
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
