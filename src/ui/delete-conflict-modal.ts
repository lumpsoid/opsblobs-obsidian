// ─────────────────────────────────────────────
//  Delete-conflict modal
// ─────────────────────────────────────────────
// Shown when a file was deleted on one device and modified on another, and the
// deleteConflictStrategy is 'ask'. The user chooses which side to keep.

import { App, Modal } from 'obsidian';

export class DeleteConflictModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private path: string,
    private side: 'local_deleted' | 'remote_deleted',
    private resolve: (decision: 'keep_deleted' | 'restore') => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '⚠️ Delete conflict' });

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
  }

  private decide(decision: 'keep_deleted' | 'restore') {
    this.decided = true;
    this.resolve(decision);
    this.close();
  }

  onClose() {
    // Dismissed without choosing — default to restoring so no edit is lost.
    if (!this.decided) this.resolve('restore');
    this.contentEl.empty();
  }
}
