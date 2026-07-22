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
import { parseConflictMarkers, resolveMarkedText, ConflictMarkerSegment } from '../merge/diff3';

export const CONFLICTS_VIEW_TYPE = 'vault-sync-conflicts';

/** The narrow surface the panel needs from the plugin — keeps the view decoupled
 *  from plugin internals (and from `obsidian` beyond rendering). */
export interface ConflictsViewHost {
  /** The two-headed files awaiting resolution (a derived query over the registry). */
  listConflicts(): ConflictListItem[];
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

    // Fetch every file's marked text first (async), then paint in one pass so a
    // slow read can't interleave a stale card into a newer render.
    const texts = await Promise.all(items.map(i => this.host.readFile(i.path)));
    if (token !== this.renderToken) return; // a newer render superseded us

    root.empty();
    root.addClass('vault-sync-conflicts-view');

    const header = root.createDiv('vault-sync-conflicts-header');
    header.createEl('h3', { text: 'Sync conflicts' });
    header.createEl('div', {
      cls: 'vault-sync-conflicts-count',
      text: items.length === 0
        ? 'No conflicts — everything is in sync.'
        : `${items.length} file${items.length !== 1 ? 's' : ''} need${items.length === 1 ? 's' : ''} resolution. ` +
          'Choose a side per change, then Apply — or edit the markers directly in the note.',
    });

    // Prune selection state for files that are no longer conflicted.
    const liveIds = new Set(items.map(i => i.fileId));
    for (const id of [...this.selections.keys()]) if (!liveIds.has(id)) this.selections.delete(id);

    if (items.length === 0) {
      setIcon(root.createDiv('vault-sync-conflicts-empty'), 'check-circle-2');
      return;
    }

    items.forEach((item, idx) => {
      this.renderFileCard(root, item, texts[idx] ?? null);
    });
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
    new ButtonComponent(globalBar).setButtonText('Keep both').onClick(() => setAll('both'));

    // ── Per-hunk 3-way compare ────────────────────────────────────────────────
    const list = card.createDiv('vault-sync-conflict-hunks');
    let ci = 0;
    for (const seg of segments) {
      if (seg.kind !== 'conflict') continue;
      this.renderHunk(list, seg, ci, sel);
      ci++;
    }

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
    const pane = (cls: string, label: string, lines: string[], kind: SelectionKind | null) => {
      const el = panes.createDiv(`vault-sync-pane ${cls}${kind && chosen === kind ? ' is-chosen' : ''}`);
      el.createDiv({ cls: 'vault-sync-pane-label', text: label });
      const pre = el.createEl('pre', { cls: 'vault-sync-pane-code' });
      pre.createEl('code', { text: lines.length ? lines.join('\n') : '(empty)' });
      if (kind) {
        el.addEventListener('click', () => { sel.set(ci, kind); void this.render(); });
      }
    };
    pane('pane-ours', 'Mine', seg.ours, 'local');
    pane('pane-base', 'Base', seg.base, null);
    pane('pane-theirs', 'Theirs', seg.theirs, 'remote');

    const actions = hunk.createDiv('vault-sync-hunk-actions');
    const btn = (label: string, kind: SelectionKind) => {
      const b = new ButtonComponent(actions).setButtonText(label)
        .onClick(() => { sel.set(ci, kind); void this.render(); });
      if (chosen === kind) b.setCta();
    };
    btn('Mine', 'local');
    btn('Theirs', 'remote');
    btn('Both', 'both');
  }

  private async applyResolution(
    item: ConflictListItem,
    text: string,
    sel: Map<number, SelectionKind>,
  ): Promise<void> {
    const resolutions = new Map<number, ConflictResolution>();
    for (const [ci, kind] of sel) resolutions.set(ci, { kind });
    const resolved = resolveMarkedText(text, resolutions);
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
