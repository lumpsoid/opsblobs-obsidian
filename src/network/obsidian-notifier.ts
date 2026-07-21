// ─────────────────────────────────────────────
//  ObsidianNotifier — live Notifier implementation
// ─────────────────────────────────────────────
//
//  Surfaces the coordinator's user-facing messages as Obsidian `Notice` toasts.
//  Thin adapter; the message text/formatting is the coordinator's concern.

import { Notice } from 'obsidian';
import { Notifier } from '../ports/notifier';

export class ObsidianNotifier implements Notifier {
  info(msg: string): void {
    new Notice(msg);
  }

  error(msg: string): void {
    new Notice(msg);
  }
}
