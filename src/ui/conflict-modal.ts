// ─────────────────────────────────────────────
//  Conflict Resolution Modal
//  Phase 4.3
// ─────────────────────────────────────────────

import { App, Modal, ButtonComponent } from 'obsidian';
import { ThreeWayMergeResult, ConflictResolution } from '../types';
import { resolveConflictChunkLines } from '../merge/diff3';

export class ConflictResolutionModal extends Modal {
  private result: Uint8Array | null = null;
  private resolutions: Map<number, ConflictResolution> = new Map();
  private mergedLines: string[];

  constructor(
    app: App,
    private filePath: string,
    private mergeResult: ThreeWayMergeResult,
    private localContent: string,
    private remoteContent: string,
    private resolve: (result: Uint8Array | null) => void,
  ) {
    super(app);
    this.mergedLines = [...mergeResult.merged];
    // Pre-populate resolutions with 'local' as default
    mergeResult.conflicts.forEach((_chunk, i) => {
      this.resolutions.set(i, { kind: 'local' });
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    // Size the *modal* element (not the content), so the content never overflows
    // its container into a horizontal scrollbar.
    this.modalEl.addClass('vault-sync-conflict-modal');

    // ── Header ────────────────────────────────────────────────────────────
    const header = contentEl.createDiv('conflict-header');
    header.createEl('h2', { text: '⚠️ Merge Conflict' });
    header.createEl('p', {
      text: `Both devices modified "${this.filePath}". Choose how to resolve each conflict below. ` +
        'Skipping keeps your current version (nothing is lost) — you can revisit it later with ' +
        '“Re-check for conflicts” in Settings → Vault Sync.',
      cls: 'conflict-subtitle',
    });

    // ── Global actions ────────────────────────────────────────────────────
    const globalBar = contentEl.createDiv('conflict-global-bar');
    new ButtonComponent(globalBar)
      .setButtonText('Accept All Local')
      .setClass('mod-cta')
      .onClick(() => { this.acceptAll({ kind: 'local' }); this.renderConflicts(conflictsContainer); });

    new ButtonComponent(globalBar)
      .setButtonText('Accept All Remote')
      .onClick(() => { this.acceptAll({ kind: 'remote' }); this.renderConflicts(conflictsContainer); });

    new ButtonComponent(globalBar)
      .setButtonText('Accept All Both')
      .onClick(() => { this.acceptAll({ kind: 'both' }); this.renderConflicts(conflictsContainer); });

    // ── Conflicts list ────────────────────────────────────────────────────
    const conflictsContainer = contentEl.createDiv('conflict-list');
    this.renderConflicts(conflictsContainer);

    // ── Footer ────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv('conflict-footer');

    new ButtonComponent(footer)
      .setButtonText('Apply Resolution')
      .setClass('mod-cta')
      .onClick(() => {
        const merged = this.buildResolvedContent();
        this.result = new TextEncoder().encode(merged);
        this.resolve(this.result);
        this.close();
      });

    new ButtonComponent(footer)
      .setButtonText('Skip for now')
      .setTooltip('Keep your current version unchanged. Re-check later from Settings → Vault Sync.')
      .onClick(() => {
        this.resolve(null);
        this.close();
      });
  }

  onClose() {
    if (!this.result) {
      this.resolve(null);
    }
    this.contentEl.empty();
  }

  private renderConflicts(container: HTMLElement): void {
    container.empty();

    this.mergeResult.conflicts.forEach((chunk, idx) => {
      const current = this.resolutions.get(idx);
      const conflictEl = container.createDiv('conflict-chunk');

      const chunkHeader = conflictEl.createDiv('chunk-header');
      chunkHeader.createEl('span', {
        text: `Conflict ${idx + 1} of ${this.mergeResult.conflicts.length}`,
        cls: 'chunk-index',
      });

      const resolved = current?.kind;
      chunkHeader.createEl('span', {
        text: this.resolutionLabel(resolved),
        cls: `resolution-badge resolution-${resolved ?? 'unset'}`,
      });

      // Side-by-side diff panes
      const panes = conflictEl.createDiv('conflict-panes');

      const localPane = panes.createDiv('conflict-pane pane-local');
      localPane.createEl('div', { text: '← Local', cls: 'pane-label' });
      const localCode = localPane.createEl('pre', { cls: 'conflict-code' });
      localCode.createEl('code', { text: chunk.local.join('\n') || '(deleted)' });

      const remotePane = panes.createDiv('conflict-pane pane-remote');
      remotePane.createEl('div', { text: 'Remote →', cls: 'pane-label' });
      const remoteCode = remotePane.createEl('pre', { cls: 'conflict-code' });
      remoteCode.createEl('code', { text: chunk.remote.join('\n') || '(deleted)' });

      // Action buttons
      const actions = conflictEl.createDiv('chunk-actions');

      const makeBtn = (label: string, resolution: ConflictResolution, cls = '') => {
        new ButtonComponent(actions)
          .setButtonText(label)
          .setClass(cls || 'mod-plain')
          .onClick(() => {
            this.resolutions.set(idx, resolution);
            this.renderConflicts(container);
          });
      };

      makeBtn('Accept Local', { kind: 'local' }, resolved === 'local' ? 'mod-cta' : '');
      makeBtn('Accept Remote', { kind: 'remote' }, resolved === 'remote' ? 'mod-cta' : '');
      makeBtn('Accept Both', { kind: 'both' }, resolved === 'both' ? 'mod-cta' : '');
    });
  }

  private acceptAll(resolution: ConflictResolution): void {
    this.mergeResult.conflicts.forEach((_chunk, idx) => {
      this.resolutions.set(idx, resolution);
    });
  }

  private buildResolvedContent(): string {
    const lines = [...this.mergedLines];
    // Apply in reverse so line indices stay valid
    const sortedConflicts = [...this.mergeResult.conflicts].map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.startLine - a.c.startLine);

    for (const { c, i } of sortedConflicts) {
      const resolution = this.resolutions.get(i) ?? { kind: 'local' };
      const replacementLines = resolveConflictChunkLines(c, resolution);
      lines.splice(c.startLine, c.local.length, ...replacementLines);
    }
    return lines.join('\n');
  }

  private resolutionLabel(kind?: ConflictResolution['kind']): string {
    switch (kind) {
      case 'local': return '✓ Local';
      case 'remote': return '✓ Remote';
      case 'both': return '✓ Both';
      case 'custom': return '✓ Custom';
      default: return '? Unresolved';
    }
  }
}
