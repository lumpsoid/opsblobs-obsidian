// ─────────────────────────────────────────────
//  Conflicts panel — non-blocking 3-way compare (sync v2 Step 6)
// ─────────────────────────────────────────────
//
//  A persistent side-panel (ItemView, not a modal) listing the files a text
//  conflict left *two-headed* (inline zdiff3 markers on disk, Step 5) and offering a
//  legible per-hunk compare to settle them. Obsidian glue only — every decision (what
//  the markers mean, how a side is selected, what the resolved bytes are) lives in the
//  obsidian-free helpers `parseConflictMarkers` / `resolveMarkedText` /
//  `listTwoHeadedConflicts`, which are unit-tested. Applying a resolution writes the
//  marker-free text back through the vault, which is exactly the ordinary Step-5
//  resolving save (a modify event → the op-logger's two-headed branch → the two-parent
//  merge node). Manual-smoke surface per the engineering guide.

import { ButtonComponent, ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { ConflictResolution } from '../types';
import { ConflictListItem } from '../core/conflict-inventory';
import { ConflictDescriptor, ConflictDecision } from '../network/sync-state-store';
import { parseConflictMarkers, resolveMarkedText, ConflictMarkerSegment } from '../merge/diff3';

export const CONFLICTS_VIEW_TYPE = 'vault-sync-conflicts';

/** The narrow surface the panel needs from the plugin — keeps the view decoupled
 *  from plugin internals (and from `obsidian` beyond rendering). */
export interface ConflictsViewHost {
  /** The two-headed files awaiting resolution (a derived query over the registry). */
  listConflicts(): ConflictListItem[];
  /** Delete/binary conflicts awaiting a decision (persisted descriptors, §3). */
  listDeleteBinaryConflicts(): ConflictDescriptor[];
  /** Record the user's inline decision for a delete/binary conflict and apply it (the
   *  next sync round consumes it and mints the merge node). */
  resolveDeleteBinary(fileId: string, decision: ConflictDecision): Promise<void>;
  /** Current on-disk text of a tracked file (its marked working copy), or null. */
  readFile(path: string): Promise<string | null>;
  /** Write the resolved (marker-free) text — the Step-5 resolving save. */
  resolveFile(path: string, text: string): Promise<void>;
  /** Open the file in the workspace so the user can edit the markers by hand instead. */
  openFile(path: string): Promise<void>;
  /** A short label for a head's authoring device ("this device" / a short id). */
  describeDevice(deviceId: string): string;
  /** Subscribe to "conflicts may have changed" (an op recorded, a round finished);
   *  returns an unsubscribe. */
  onChange(cb: () => void): () => void;
}

type SelectionKind = 'local' | 'remote' | 'both';

export class ConflictsView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  /** Per-file, per-hunk choice. Kept across re-renders so a spurious refresh (an op
   *  recorded elsewhere) doesn't discard an in-progress selection. */
  private selections = new Map<string, Map<number, SelectionKind>>();
  /** Files whose resolved-result preview is expanded. Tracked (like {@link selections})
   *  so the preview survives the re-render every side-pick triggers and updates live. */
  private previewOpen = new Set<string>();
  /** Guards against overlapping async renders clobbering each other. */
  private renderToken = 0;

  constructor(leaf: WorkspaceLeaf, private host: ConflictsViewHost) {
    super(leaf);
  }

  getViewType(): string { return CONFLICTS_VIEW_TYPE; }
  getDisplayText(): string { return 'Sync conflicts'; }
  getIcon(): string { return 'git-merge'; }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.host.onChange(() => { void this.render(); });
    await this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Public so the plugin can force a refresh right after a sync round. */
  refresh(): void { void this.render(); }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const root = this.containerEl.children[1] as HTMLElement;
    const items = this.host.listConflicts();
    const dbConflicts = this.host.listDeleteBinaryConflicts();
    const total = items.length + dbConflicts.length;

    // Fetch every text file's marked content first (async), then paint in one pass so a
    // slow read can't interleave a stale card into a newer render.
    const texts = await Promise.all(items.map(i => this.host.readFile(i.path)));
    if (token !== this.renderToken) return; // a newer render superseded us

    root.empty();
    root.addClass('vault-sync-conflicts-view');

    const header = root.createDiv('vault-sync-conflicts-header');
    header.createEl('h3', { text: 'Sync conflicts' });
    header.createEl('div', {
      cls: 'vault-sync-conflicts-count',
      text: total === 0
        ? 'No conflicts — everything is in sync.'
        : `${total} item${total !== 1 ? 's' : ''} need${total === 1 ? 's' : ''} your attention.`,
    });

    // Prune per-file UI state for text files that are no longer conflicted.
    const liveIds = new Set(items.map(i => i.fileId));
    for (const id of [...this.selections.keys()]) if (!liveIds.has(id)) this.selections.delete(id);
    for (const id of [...this.previewOpen]) if (!liveIds.has(id)) this.previewOpen.delete(id);

    if (total === 0) {
      setIcon(root.createDiv('vault-sync-conflicts-empty'), 'check-circle-2');
      return;
    }

    // Delete/binary conflicts first (a single decision each), then the text-merge cards.
    if (dbConflicts.length > 0) {
      for (const c of dbConflicts) this.renderDecisionCard(root, c);
    }
    items.forEach((item, idx) => {
      this.renderFileCard(root, item, texts[idx] ?? null);
    });
  }

  /** A delete/binary conflict card: one decision, resolved inline (§3 "full inline").
   *  Recording a choice triggers a sync that applies it; the card drops on refresh. */
  private renderDecisionCard(root: HTMLElement, c: ConflictDescriptor): void {
    const card = root.createDiv('vault-sync-conflict-card');
    const head = card.createDiv('vault-sync-conflict-card-header');
    const title = head.createDiv('vault-sync-conflict-path');
    setIcon(title.createSpan('vault-sync-conflict-path-icon'), c.kind === 'delete' ? 'trash-2' : 'image');
    title.createSpan({ text: c.path });

    // Explanation, then any per-side detail, then the decision buttons last — so the
    // buttons always sit at the bottom of the card, below the context they act on.
    const body = card.createDiv('vault-sync-conflict-note');
    if (c.kind === 'binary' && c.binary) {
      const b = c.binary;
      const sides = card.createDiv('vault-sync-binary-sides');
      this.renderBinarySide(sides, 'This device', b.localBytes, b.localDevice, b.localAt);
      this.renderBinarySide(sides, 'Other device', b.remoteBytes, b.remoteDevice, b.remoteAt);
    }
    const actions = card.createDiv('vault-sync-conflict-actions');

    const resolve = (decision: ConflictDecision) => {
      // Optimistically disable the whole card while the applying round runs.
      actions.querySelectorAll('button').forEach(btn => (btn as HTMLButtonElement).disabled = true);
      void this.host.resolveDeleteBinary(c.fileId, decision);
    };

    if (c.kind === 'delete') {
      const deletedHere = c.side === 'local_deleted';
      body.setText(
        `Deleted on ${deletedHere ? 'this device' : 'another device'} but modified on ` +
        `${deletedHere ? 'another device' : 'this device'}. Keep the deletion, or restore the ` +
        'modified version?',
      );
      new ButtonComponent(actions).setButtonText('Keep modified version').setCta()
        .onClick(() => resolve({ kind: 'delete', decision: 'keep_modified' }));
      new ButtonComponent(actions).setButtonText('Keep deleted')
        .onClick(() => resolve({ kind: 'delete', decision: 'keep_deleted' }));
    } else {
      body.setText('Changed on two devices at once. Binary files can\'t be merged — keep one whole ' +
        'version (the other stays in the sync history and can be recovered later).');
      new ButtonComponent(actions).setButtonText("Keep this device's version").setCta()
        .onClick(() => resolve({ kind: 'binary', decision: 'keep_local' }));
      new ButtonComponent(actions).setButtonText("Keep other device's version")
        .onClick(() => resolve({ kind: 'binary', decision: 'keep_remote' }));
    }
  }

  private renderBinarySide(parent: HTMLElement, label: string, bytes: number, deviceId: string, at: number): void {
    const el = parent.createDiv('vault-sync-binary-side');
    el.createDiv({ cls: 'vault-sync-pane-label', text: label });
    const who = this.host.describeDevice(deviceId);
    const when = relativeTime(at);
    el.createDiv({ text: `${formatBytes(bytes)} · ${who}${when ? ` · ${when}` : ''}`, cls: 'vault-sync-binary-side-meta' });
  }

  private renderFileCard(root: HTMLElement, item: ConflictListItem, text: string | null): void {
    const card = root.createDiv('vault-sync-conflict-card');

    // ── Header: path + per-head provenance ────────────────────────────────────
    const head = card.createDiv('vault-sync-conflict-card-header');
    const title = head.createDiv('vault-sync-conflict-path');
    setIcon(title.createSpan('vault-sync-conflict-path-icon'), 'file-text');
    title.createSpan({ text: item.path });

    const prov = head.createDiv('vault-sync-conflict-provenance');
    const sideLabels = ['Mine', 'Theirs'];
    item.heads.forEach((h, i) => {
      const chip = prov.createSpan({ cls: `vault-sync-prov-chip prov-${i === 0 ? 'ours' : 'theirs'}` });
      const who = h.hlc ? this.host.describeDevice(h.hlc.deviceId) : 'unknown device';
      const when = h.hlc ? relativeTime(h.hlc.wallTime) : '';
      chip.setText(`${sideLabels[i] ?? `Head ${i + 1}`}: ${who}${when ? ` · ${when}` : ''}`);
    });

    if (text === null || parseConflictMarkers(text).every(s => s.kind === 'clean')) {
      // The file no longer holds markers (resolved out-of-band, or mid-write) — offer
      // to open it; the next round/refresh will drop it from the list.
      const note = card.createDiv('vault-sync-conflict-note');
      note.setText('No conflict markers found on disk — it may already be resolved.');
      new ButtonComponent(card.createDiv('vault-sync-conflict-actions'))
        .setButtonText('Open note')
        .onClick(() => { void this.host.openFile(item.path); });
      return;
    }

    const segments = parseConflictMarkers(text);
    const conflictIdxs: number[] = [];
    segments.forEach((s, i) => { if (s.kind === 'conflict') conflictIdxs.push(i); });

    const sel = this.selectionFor(item.fileId);

    // ── Global side pickers ───────────────────────────────────────────────────
    const globalBar = card.createDiv('vault-sync-conflict-global');
    const setAll = (kind: SelectionKind) => {
      conflictIdxs.forEach((_seg, ci) => sel.set(ci, kind));
      void this.render();
    };
    new ButtonComponent(globalBar).setButtonText('All mine').onClick(() => setAll('local'));
    new ButtonComponent(globalBar).setButtonText('All theirs').onClick(() => setAll('remote'));
    new ButtonComponent(globalBar).setButtonText('Keep both')
      .setTooltip('Keep both on every change — Mine first, then Theirs')
      .onClick(() => setAll('both'));

    // ── Per-hunk 3-way compare ────────────────────────────────────────────────
    const list = card.createDiv('vault-sync-conflict-hunks');
    let ci = 0;
    for (const seg of segments) {
      if (seg.kind !== 'conflict') continue;
      this.renderHunk(list, seg, ci, sel);
      ci++;
    }

    // ── Preview of the resolved result ────────────────────────────────────────
    // Show exactly what "Apply resolution" will write, computed live from the
    // current per-hunk picks (§3). Its open/closed state is tracked so re-rendering
    // on each pick keeps it open and refreshes the text underneath.
    const preview = card.createEl('details', { cls: 'vault-sync-conflict-preview' });
    preview.open = this.previewOpen.has(item.fileId);
    preview.createEl('summary', { text: 'Preview result' });
    preview.addEventListener('toggle', () => {
      if (preview.open) this.previewOpen.add(item.fileId);
      else this.previewOpen.delete(item.fileId);
    });
    const resolved = resolveMarkedText(text, this.resolutionsFrom(sel));
    preview.createEl('pre', { cls: 'vault-sync-pane-code vault-sync-conflict-preview-code' })
      .createEl('code', { text: resolved.length ? resolved : '(empty file)' });

    // ── Footer: apply / open ──────────────────────────────────────────────────
    const footer = card.createDiv('vault-sync-conflict-actions');
    new ButtonComponent(footer)
      .setButtonText('Apply resolution')
      .setCta()
      .onClick(() => { void this.applyResolution(item, text, sel); });
    new ButtonComponent(footer)
      .setButtonText('Edit in note')
      .onClick(() => { void this.host.openFile(item.path); });
  }

  /** The per-hunk picks as the `resolveMarkedText` decision map — the single rule the
   *  preview and Apply both use, so the preview can never disagree with what lands. */
  private resolutionsFrom(sel: Map<number, SelectionKind>): Map<number, ConflictResolution> {
    const resolutions = new Map<number, ConflictResolution>();
    for (const [ci, kind] of sel) resolutions.set(ci, { kind });
    return resolutions;
  }

  private renderHunk(
    list: HTMLElement,
    seg: Extract<ConflictMarkerSegment, { kind: 'conflict' }>,
    ci: number,
    sel: Map<number, SelectionKind>,
  ): void {
    const chosen = sel.get(ci) ?? 'local';
    const hunk = list.createDiv('vault-sync-hunk');

    const bar = hunk.createDiv('vault-sync-hunk-bar');
    bar.createSpan({ cls: 'vault-sync-hunk-index', text: `Change ${ci + 1}` });

    const panes = hunk.createDiv('vault-sync-hunk-panes');
    const pane = (cls: string, label: string, lines: string[], kind: SelectionKind | null, tooltip: string) => {
      const el = panes.createDiv(`vault-sync-pane ${cls}${kind && chosen === kind ? ' is-chosen' : ''}`);
      el.setAttribute('title', tooltip);
      el.createDiv({ cls: 'vault-sync-pane-label', text: label });
      const pre = el.createEl('pre', { cls: 'vault-sync-pane-code' });
      pre.createEl('code', { text: lines.length ? lines.join('\n') : '(empty)' });
      if (kind) {
        el.addEventListener('click', () => { sel.set(ci, kind); void this.render(); });
      }
    };
    pane('pane-ours', 'Mine', seg.ours, 'local', 'Your version on this device.');
    // The Original (common ancestor) pane is read-only context, not a choice — it's
    // greyed and non-clickable; the gloss says what it is (§3).
    pane('pane-base', 'Original', seg.base, null, 'The shared starting point, before either edit. Read-only reference.');
    pane('pane-theirs', 'Theirs', seg.theirs, 'remote', "The other device's version.");

    const actions = hunk.createDiv('vault-sync-hunk-actions');
    const btn = (label: string, kind: SelectionKind, tooltip?: string) => {
      const b = new ButtonComponent(actions).setButtonText(label)
        .onClick(() => { sel.set(ci, kind); void this.render(); });
      if (tooltip) b.setTooltip(tooltip);
      if (chosen === kind) b.setCta();
    };
    btn('Mine', 'local');
    btn('Theirs', 'remote');
    btn('Both', 'both', 'Keep both changes — Mine first, then Theirs');
  }

  private async applyResolution(
    item: ConflictListItem,
    text: string,
    sel: Map<number, SelectionKind>,
  ): Promise<void> {
    const resolved = resolveMarkedText(text, this.resolutionsFrom(sel));
    await this.host.resolveFile(item.path, resolved);
    this.selections.delete(item.fileId);
    // The resolving save clears the two-headed marker asynchronously (debounced op
    // flush); refresh shortly after so the card drops once it's really resolved.
    window.setTimeout(() => this.refresh(), 400);
  }

  private selectionFor(fileId: string): Map<number, SelectionKind> {
    let s = this.selections.get(fileId);
    if (!s) { s = new Map(); this.selections.set(fileId, s); }
    return s;
  }
}

/** A compact relative-time label ("just now" / "5m ago" / "3h ago" / "2d ago") from
 *  an HLC wall time. Provenance only — glanceable, not precise. */
function relativeTime(wallTime: number): string {
  const delta = Date.now() - wallTime;
  if (!Number.isFinite(delta) || delta < 0) return '';
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Human-readable byte size for the binary-conflict side metadata. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
