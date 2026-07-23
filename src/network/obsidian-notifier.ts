// ─────────────────────────────────────────────
//  ObsidianNotifier — live Notifier implementation
// ─────────────────────────────────────────────
//
//  Surfaces the coordinator's user-facing messages as Obsidian `Notice` toasts.
//  Thin adapter; the message text/formatting is the coordinator's concern.

import { Notice } from 'obsidian';
import { Notifier, NotifierAction } from '../ports/notifier';

export class ObsidianNotifier implements Notifier {
  info(msg: string): void {
    new Notice(msg);
  }

  error(msg: string): void {
    new Notice(msg);
  }

  /** A setup-class failure the user must act on: a persistent (timeout 0) notice,
   *  error-colored via a CSS class rather than an emoji, optionally carrying a
   *  clickable action link. Stays until dismissed so it survives the moment the
   *  round failed even if the user wasn't looking. */
  setupError(msg: string, action?: NotifierAction): void {
    const frag = createFragment(f => {
      f.createSpan({ text: msg });
      if (action) {
        f.createEl('br');
        const link = f.createEl('a', { text: action.label, cls: 'vault-sync-notice-link' });
        link.addEventListener('click', () => action.run());
      }
    });
    const notice = new Notice(frag, 0);
    notice.noticeEl.addClass('vault-sync-notice-error');
  }
}
