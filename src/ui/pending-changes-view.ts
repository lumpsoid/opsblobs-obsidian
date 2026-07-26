// ─────────────────────────────────────────────
//  Pending changes panel — full detail for "waiting to sync" (redesign spec)
// ─────────────────────────────────────────────
//
//  The sync-status modal collapses pending/deferred/stranded to one summary line
//  ("12 pending · 2 deferred · 1 waiting on content"); this ItemView, opened as a
//  main-area tab (mirroring ConflictsView/PerfLogView), is where the full detail
//  behind that line lives:
//    - Pending: every local edit not yet pushed, one row per file, color-coded by
//      the op's type (create/update/delete/move) instead of a plain path string.
//    - Deferred: F5 on-disk-drift files, retried automatically — path list + the
//      explanation of why nothing needs doing.
//    - Stranded: content stranded waiting on a blob (F3) — count only, since these
//      are identified solely by content hash and have no meaningful per-item detail.
//  Obsidian glue only; no sync-engine decisions live here.

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { OperationType } from '../types';
import { DeferredFile } from '../network/sync-state-store';

export const PENDING_CHANGES_VIEW_TYPE = 'vault-sync-pending-changes';

export interface PendingOpRow {
  path: string;
  type: OperationType;
}

/** The narrow surface the view needs from the plugin — keeps it decoupled from
 *  plugin internals (and from `obsidian` beyond rendering). */
export interface PendingChangesViewHost {
  /** Local edits not yet pushed, with their op type for the color-coded row. */
  listPendingOps(): PendingOpRow[];
  /** F5 drift files — retried automatically, no user action needed. */
  listDeferred(): DeferredFile[];
  /** Count of content stranded waiting on a blob (F3) — no per-item detail exists. */
  strandedCount(): number;
  /** Subscribe to "this may have changed" (an op recorded/cleared, a round
   *  finished); returns an unsubscribe. */
  onChange(cb: () => void): () => void;
}

const OP_LABELS: Record<OperationType, string> = {
  create: 'New',
  update: 'Edited',
  delete: 'Deleted',
  move: 'Moved',
};

export class PendingChangesView extends ItemView {
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private host: PendingChangesViewHost) {
    super(leaf);
  }

  getViewType(): string { return PENDING_CHANGES_VIEW_TYPE; }
  getDisplayText(): string { return 'Pending changes'; }
  getIcon(): string { return 'clock'; }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.host.onChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Public so the plugin can force a refresh right after a sync round. */
  refresh(): void { this.render(); }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('vault-sync-pending-view');

    root.createEl('h3', { text: 'Pending changes' });

    const ops = [...this.host.listPendingOps()].sort((a, b) => a.path.localeCompare(b.path));
    const deferred = this.host.listDeferred();
    const stranded = this.host.strandedCount();

    // ── Pending ────────────────────────────────────────────────────────────
    root.createEl('h4', { text: `Pending (${ops.length})` });
    if (ops.length === 0) {
      root.createEl('p', { text: 'Everything is pushed.', cls: 'setting-item-description' });
    } else {
      const list = root.createEl('ul', { cls: 'vault-sync-pending-list' });
      for (const op of ops) {
        const li = list.createEl('li', { cls: 'vault-sync-pending-row' });
        li.createSpan({ cls: `vault-sync-optype vault-sync-optype-${op.type}`, text: OP_LABELS[op.type] });
        li.createSpan({ cls: 'vault-sync-pending-path', text: op.path });
      }
    }

    // ── Deferred (F5 drift) ────────────────────────────────────────────────
    root.createEl('h4', { text: `Deferred — changed during sync (${deferred.length})` });
    if (deferred.length === 0) {
      root.createEl('p', { text: 'None.', cls: 'setting-item-description' });
    } else {
      root.createEl('p', {
        text: 'These files changed on disk while a sync was in flight, so their incoming update ' +
          'was held. They retry automatically on the next sync.',
        cls: 'setting-item-description',
      });
      const list = root.createEl('ul', { cls: 'vault-sync-pending-list' });
      for (const d of deferred) list.createEl('li', { text: d.path });
    }

    // ── Stranded (F3, count only — identified by content hash) ────────────
    root.createEl('h4', { text: `Waiting on content (${stranded})` });
    if (stranded === 0) {
      root.createEl('p', { text: 'None.', cls: 'setting-item-description' });
    } else {
      root.createEl('p', {
        text: `${stranded} incoming change${stranded !== 1 ? 's were' : ' was'} received but the ` +
          "file content hasn't arrived from the server yet. This retries automatically on the next sync.",
        cls: 'setting-item-description',
      });
    }
  }
}
