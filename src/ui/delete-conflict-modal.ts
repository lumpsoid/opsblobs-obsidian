// ─────────────────────────────────────────────
//  Delete-conflict modal
// ─────────────────────────────────────────────
// Shown when a file was deleted on one device and modified on another, and the
// deleteConflictStrategy is 'ask'. The user chooses which side to keep — or defers
// the decision. Dismissing the modal (Esc / click-away) is treated as "decide later"
// (defer), never a silent pick, so a destructive outcome is only ever chosen by an
// explicit button press (UX audit §3).

import { App, Modal } from 'obsidian';
import { DEFER_CONFLICT, DeferConflict } from '../network/sync-applicator';

export class DeleteConflictModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private path: string,
    private side: 'local_deleted' | 'remote_deleted',
    private resolve: (decision: 'keep_deleted' | 'restore' | DeferConflict) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Delete conflict' });

    const deletedHere = this.side === 'local_deleted';
    contentEl.createEl('p', {
      text: `"${this.path}" was deleted on ${deletedHere ? 'this device' : 'another device'} ` +
        `but modified on ${deletedHere ? 'another device' : 'this device'}. ` +
        'Keep the deletion, or restore the modified version?',
    });

    const buttons = contentEl.createDiv({ cls: 'delete-conflict-buttons' });

    const restoreBtn = buttons.createEl('button', {
      text: 'Keep modified version',
      cls: 'mod-cta',
    });
    restoreBtn.addEventListener('click', () => this.decide('restore'));

    const deleteBtn = buttons.createEl('button', {
      text: 'Keep deleted',
      cls: 'mod-warning',
    });
    deleteBtn.addEventListener('click', () => this.decide('keep_deleted'));

    // An explicit "decide later" — the same outcome dismissing the modal produces,
    // but discoverable. Your current version is kept and the conflict re-presents on
    // the next manual sync.
    const laterBtn = buttons.createEl('button', { text: 'Decide later' });
    laterBtn.addEventListener('click', () => this.decide(DEFER_CONFLICT));
  }

  private decide(decision: 'keep_deleted' | 'restore' | DeferConflict) {
    this.decided = true;
    this.resolve(decision);
    this.close();
  }

  onClose() {
    // Dismissed without an explicit choice — defer rather than silently picking a
    // (possibly destructive) default. The round holds its cursor so the conflict
    // re-presents next manual sync; nothing on disk is changed.
    if (!this.decided) this.resolve(DEFER_CONFLICT);
    this.contentEl.empty();
  }
}
