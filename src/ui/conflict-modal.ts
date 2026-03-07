// ─────────────────────────────────────────────
//  Conflict Resolution Modal
//  Phase 4.3
// ─────────────────────────────────────────────

import { App, Modal, ButtonComponent, MarkdownRenderer } from 'obsidian';
import { ThreeWayMergeResult, ConflictChunk } from '../types';

export class ConflictResolutionModal extends Modal {
  private result: Uint8Array | null = null;
  private resolvedChunks: Map<number, ConflictChunk> = new Map();
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
    mergeResult.conflicts.forEach((chunk, i) => {
      this.resolvedChunks.set(i, { ...chunk, resolution: 'local' });
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vault-sync-conflict-modal');

    // ── Header ────────────────────────────────────────────────────────────
    const header = contentEl.createDiv('conflict-header');
    header.createEl('h2', { text: '⚠️ Merge Conflict' });
    header.createEl('p', {
      text: `Both devices modified "${this.filePath}". Choose how to resolve each conflict below.`,
      cls: 'conflict-subtitle',
    });

    // ── Global actions ────────────────────────────────────────────────────
    const globalBar = contentEl.createDiv('conflict-global-bar');
    new ButtonComponent(globalBar)
      .setButtonText('Accept All Local')
      .setClass('mod-cta')
      .onClick(() => { this.acceptAll('local'); this.renderConflicts(conflictsContainer); });

    new ButtonComponent(globalBar)
      .setButtonText('Accept All Remote')
      .onClick(() => { this.acceptAll('remote'); this.renderConflicts(conflictsContainer); });

    new ButtonComponent(globalBar)
      .setButtonText('Accept All Both')
      .onClick(() => { this.acceptAll('both'); this.renderConflicts(conflictsContainer); });

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
      .setButtonText('Skip This File')
      .onClick(() => {
        this.resolve(null);
        this.close();
      });

    // ── Styles ────────────────────────────────────────────────────────────
    this.injectStyles();
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
      const current = this.resolvedChunks.get(idx) ?? chunk;
      const conflictEl = container.createDiv('conflict-chunk');

      const chunkHeader = conflictEl.createDiv('chunk-header');
      chunkHeader.createEl('span', {
        text: `Conflict ${idx + 1} of ${this.mergeResult.conflicts.length}`,
        cls: 'chunk-index',
      });

      const resolved = current.resolution;
      const statusBadge = chunkHeader.createEl('span', {
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

      const makeBtn = (label: string, resolution: ConflictChunk['resolution'], cls = '') => {
        new ButtonComponent(actions)
          .setButtonText(label)
          .setClass(cls || 'mod-plain')
          .onClick(() => {
            this.resolvedChunks.set(idx, { ...current, resolution });
            this.renderConflicts(container);
          });
      };

      makeBtn('Accept Local', 'local', resolved === 'local' ? 'mod-cta' : '');
      makeBtn('Accept Remote', 'remote', resolved === 'remote' ? 'mod-cta' : '');
      makeBtn('Accept Both', 'both', resolved === 'both' ? 'mod-cta' : '');
    });
  }

  private acceptAll(resolution: ConflictChunk['resolution']): void {
    this.mergeResult.conflicts.forEach((chunk, idx) => {
      this.resolvedChunks.set(idx, { ...chunk, resolution });
    });
  }

  private buildResolvedContent(): string {
    const lines = [...this.mergedLines];
    // Apply in reverse so line indices stay valid
    const sortedConflicts = [...this.mergeResult.conflicts].map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.startLine - a.c.startLine);

    for (const { c, i } of sortedConflicts) {
      const resolved = this.resolvedChunks.get(i);
      const replacementLines = this.getResolutionLines(resolved ?? c);
      lines.splice(c.startLine, c.local.length, ...replacementLines);
    }
    return lines.join('\n');
  }

  private getResolutionLines(chunk: ConflictChunk): string[] {
    switch (chunk.resolution) {
      case 'local': return chunk.local;
      case 'remote': return chunk.remote;
      case 'both': return [...chunk.local, ...chunk.remote];
      case 'custom': return chunk.customText ?? chunk.local;
      default: return chunk.local;
    }
  }

  private resolutionLabel(resolution?: ConflictChunk['resolution']): string {
    switch (resolution) {
      case 'local': return '✓ Local';
      case 'remote': return '✓ Remote';
      case 'both': return '✓ Both';
      case 'custom': return '✓ Custom';
      default: return '? Unresolved';
    }
  }

  private injectStyles(): void {
    const existing = document.getElementById('vault-sync-conflict-styles');
    if (existing) return;

    const style = document.createElement('style');
    style.id = 'vault-sync-conflict-styles';
    style.textContent = `
      .vault-sync-conflict-modal { max-width: 900px; width: 90vw; }
      .vault-sync-conflict-modal .modal-content { padding: 1.5rem; }
      .conflict-header h2 { margin: 0 0 0.25rem; font-size: 1.2rem; }
      .conflict-subtitle { color: var(--text-muted); margin: 0 0 1rem; font-size: 0.9rem; }
      .conflict-global-bar { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
      .conflict-list { display: flex; flex-direction: column; gap: 1rem; max-height: 55vh; overflow-y: auto; padding-right: 0.25rem; }
      .conflict-chunk { border: 1px solid var(--background-modifier-border); border-radius: 6px; overflow: hidden; }
      .chunk-header { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0.75rem; background: var(--background-secondary); }
      .chunk-index { font-weight: 600; font-size: 0.85rem; }
      .resolution-badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 12px; font-weight: 500; }
      .resolution-local { background: var(--color-green); color: white; }
      .resolution-remote { background: var(--color-blue); color: white; }
      .resolution-both { background: var(--color-purple); color: white; }
      .resolution-unset { background: var(--color-orange); color: white; }
      .conflict-panes { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
      .conflict-pane { padding: 0.5rem 0.75rem; border-top: 1px solid var(--background-modifier-border); }
      .pane-local { border-right: 1px solid var(--background-modifier-border); background: color-mix(in srgb, var(--color-red) 5%, transparent); }
      .pane-remote { background: color-mix(in srgb, var(--color-blue) 5%, transparent); }
      .pane-label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.25rem; }
      .conflict-code { margin: 0; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto; }
      .chunk-actions { display: flex; gap: 0.5rem; padding: 0.5rem 0.75rem; background: var(--background-secondary); border-top: 1px solid var(--background-modifier-border); flex-wrap: wrap; }
      .conflict-footer { display: flex; gap: 0.75rem; margin-top: 1.25rem; justify-content: flex-end; }
    `;
    document.head.appendChild(style);
  }
}
