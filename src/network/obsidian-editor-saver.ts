// ─────────────────────────────────────────────
//  ObsidianEditorSaver — live EditorSaver implementation
// ─────────────────────────────────────────────
//
//  Best-effort flush of unsaved editor buffers to disk before a sync, so the drift
//  capture sees the latest bytes rather than a stale disk copy. Obsidian persists
//  the editor on its own idle debounce anyway, so this only narrows the window —
//  and it must never throw (fully guarded): the on-disk `captureOfflineChanges`
//  pass is the actual safety net. `save` is accessed defensively because its
//  presence in the public typings varies across Obsidian versions. Thin adapter,
//  not unit-tested (like the other obsidian adapters).

import { App, MarkdownView } from 'obsidian';
import { EditorSaver } from '../ports/editor-saver';

export class ObsidianEditorSaver implements EditorSaver {
  constructor(private app: App) {}

  async saveOpenEditors(): Promise<void> {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) continue;
        const save = (view as unknown as { save?: () => Promise<void> }).save;
        if (typeof save === 'function') await save.call(view);
      }
    } catch (err) {
      console.warn('Vault Sync: force-save of open editors failed (non-fatal):', err);
    }
  }
}
