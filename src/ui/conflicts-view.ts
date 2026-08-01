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
//
//  Two list-level affordances sit above the cards:
//    • a **bulk bar** — the per-file "All mine / All theirs / Keep both" pickers widened
//      to *every* text conflict, plus one "Apply all" that writes them in a single
//      confirmed pass. Delete/binary cards are deliberately excluded: §3 of the UX audit
//      makes an explicit inline choice the only way those resolve.
//    • a **sticky list** — a card resolved while the tab is open stays in place, frozen
//      and dimmed, instead of vanishing and reflowing every card below it under the
//      pointer. Resolved cards clear when the user leaves the tab (or on "Clear
//      resolved") — the one moment a height change can't cost a misclick.

import { ButtonComponent, ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import { ConflictResolution } from '../types';
import { ConflictListItem } from '../core/conflict-inventory';
import { ConflictDescriptor, ConflictDecision } from '../network/sync-state-store';
import { parseConflictMarkers, resolveMarkedText, ConflictMarkerSegment } from '../merge/diff3';
import { ConfirmModal } from './confirm-modal';

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

/** What a card needs to paint, captured at the last render where it was still live.
 *  Once the conflict clears, the snapshot is what the frozen card keeps showing — same
 *  content, so the card keeps exactly the height it had. */
type CardSnapshot =
  | { kind: 'text'; item: ConflictListItem; text: string | null; segments: ConflictMarkerSegment[] | null }
  | { kind: 'db'; descriptor: ConflictDescriptor };

/** Card keys are namespaced because a text conflict and a delete/binary conflict for the
 *  same file would otherwise collide on `fileId`. */
const textKey = (fileId: string): string => `t:${fileId}`;
const dbKey = (fileId: string): string => `d:${fileId}`;

export class ConflictsView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  /** Per-file, per-hunk choice. Kept across re-renders so a spurious refresh (an op
   *  recorded elsewhere) doesn't discard an in-progress selection. */
  private selections = new Map<string, Map<number, SelectionKind>>();
  /** Files whose resolved-result preview is expanded. Tracked (like {@link selections})
   *  so the preview survives the re-render every side-pick triggers and updates live. */
  private previewOpen = new Set<string>();
  /** Render order of every card the tab has shown, live or resolved — append-only for as
   *  long as the tab is open. This is what makes the list stable: a resolved card keeps
   *  its slot instead of collapsing and dragging the rest up under the pointer. */
  private order: string[] = [];
  /** The last-live paint data per card key (see {@link CardSnapshot}). */
  private snapshots = new Map<string, CardSnapshot>();
  /** Guards against overlapping async renders clobbering each other. */
  private renderToken = 0;
  /** True while a bulk apply is in flight — keeps a second click from re-firing it. */
  private applyingAll = false;

  constructor(leaf: WorkspaceLeaf, private host: ConflictsViewHost) {
    super(leaf);
  }

  getViewType(): string { return CONFLICTS_VIEW_TYPE; }
  getDisplayText(): string { return 'Sync conflicts'; }
  getIcon(): string { return 'git-merge'; }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.host.onChange(() => { void this.render(); });
    // Leaving the tab is the moment the list may safely shrink — nothing is under the
    // pointer here anymore. Drop the resolved cards then, so coming back shows only
    // what still needs attention.
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf !== this.leaf) this.clearResolved();
    }));
    await this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.order = [];
    this.snapshots.clear();
    this.selections.clear();
    this.previewOpen.clear();
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

    // ── Sticky bookkeeping ────────────────────────────────────────────────────
    // Refresh the snapshot of every live card and give any newcomer a slot at the end.
    // Delete/binary first on a first paint (one decision each, cheapest to clear), then
    // the text cards; later arrivals just append, so nothing already on screen moves.
    const live = new Set<string>();
    for (const c of dbConflicts) {
      const key = dbKey(c.fileId);
      live.add(key);
      this.snapshots.set(key, { kind: 'db', descriptor: c });
      if (!this.order.includes(key)) this.order.push(key);
    }
    items.forEach((item, idx) => {
      const key = textKey(item.fileId);
      live.add(key);
      const text = texts[idx] ?? null;
      this.snapshots.set(key, {
        kind: 'text',
        item,
        text,
        segments: text === null ? null : parseConflictMarkers(text),
      });
      if (!this.order.includes(key)) this.order.push(key);
    });
    // Everything left in `order` but no longer live was resolved while the tab is open.
    const resolvedCount = this.order.reduce((n, key) => (live.has(key) ? n : n + 1), 0);

    // Prune per-file UI state only once a card leaves the list entirely — a resolved
    // card still renders, and its picks are what it shows.
    const kept = new Set(this.order);
    for (const id of [...this.selections.keys()]) if (!kept.has(textKey(id))) this.selections.delete(id);
    for (const id of [...this.previewOpen]) if (!kept.has(textKey(id))) this.previewOpen.delete(id);

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

    if (this.order.length === 0) {
      setIcon(root.createDiv('vault-sync-conflicts-empty'), 'check-circle-2');
      return;
    }

    // The bulk bar acts on the live text conflicts that actually still hold markers.
    const bulk = this.order
      .filter(key => live.has(key))
      .map(key => this.snapshots.get(key))
      .filter((s): s is Extract<CardSnapshot, { kind: 'text' }> =>
        s?.kind === 'text' && !!s.segments?.some(seg => seg.kind === 'conflict'));
    if (bulk.length >= 2) this.renderBulkBar(root, bulk);

    if (resolvedCount > 0) this.renderResolvedNote(root, resolvedCount);

    for (const key of this.order) {
      const snap = this.snapshots.get(key);
      if (!snap) continue;
      const frozen = !live.has(key);
      if (snap.kind === 'db') this.renderDecisionCard(root, snap.descriptor, frozen);
      else this.renderFileCard(root, snap.item, snap.text, snap.segments, frozen);
    }
  }

  /** List-scope side pickers + one "Apply all" — the per-file bar widened to every text
   *  conflict. The pickers only *set* picks (same as in-file, so a stray tap can't write
   *  anything); "Apply all" is the single confirmed write. */
  private renderBulkBar(root: HTMLElement, targets: Extract<CardSnapshot, { kind: 'text' }>[]): void {
    const bar = root.createDiv('vault-sync-conflicts-bulk');
    bar.createSpan({
      cls: 'vault-sync-conflicts-bulk-label',
      text: `All ${targets.length} files:`,
    });

    const setAll = (kind: SelectionKind) => {
      for (const t of targets) {
        const sel = this.selectionFor(t.item.fileId);
        let ci = 0;
        for (const seg of t.segments ?? []) if (seg.kind === 'conflict') sel.set(ci++, kind);
      }
      void this.render();
    };
    const picker = (label: string, kind: SelectionKind, tooltip: string) => {
      new ButtonComponent(bar).setButtonText(label).setTooltip(tooltip)
        .setDisabled(this.applyingAll)
        .onClick(() => setAll(kind));
    };
    picker('All mine', 'local', `Pick Mine for every change in all ${targets.length} files — nothing is written until you apply.`);
    picker('All theirs', 'remote', `Pick Theirs for every change in all ${targets.length} files — nothing is written until you apply.`);
    picker('Keep both', 'both', `Keep both on every change in all ${targets.length} files — Mine first, then Theirs.`);

    new ButtonComponent(bar)
      .setButtonText(this.applyingAll ? 'Applying…' : 'Apply all')
      .setCta()
      .setTooltip('Write the current picks for every file above, in one pass.')
      .setDisabled(this.applyingAll)
      .onClick(() => { void this.applyAll(targets); });
  }

  /** The "held in place" explainer for resolved-but-still-listed cards, so a frozen card
   *  reads as intentional rather than stuck. */
  private renderResolvedNote(root: HTMLElement, count: number): void {
    const note = root.createDiv('vault-sync-conflicts-resolved-note');
    note.createSpan({
      text: `${count} resolved — kept in place so the list doesn't jump. Cleared when you leave this tab.`,
    });
    new ButtonComponent(note).setButtonText('Clear now').onClick(() => this.clearResolved());
  }

  /** Drop the frozen cards and repaint. Called on "Clear now" and when the tab loses
   *  focus — never mid-list, which is the whole point. */
  private clearResolved(): void {
    if (this.order.length === 0) return;
    const live = new Set<string>([
      ...this.host.listDeleteBinaryConflicts().map(c => dbKey(c.fileId)),
      ...this.host.listConflicts().map(i => textKey(i.fileId)),
    ]);
    if (this.order.every(key => live.has(key))) return; // nothing frozen — don't repaint
    this.order = this.order.filter(key => live.has(key));
    for (const key of [...this.snapshots.keys()]) if (!live.has(key)) this.snapshots.delete(key);
    void this.render();
  }

  /** Apply every live text conflict's current picks in one pass. Confirmed first: this
   *  is N resolving saves, and unpicked changes silently take Mine (the
   *  `resolveMarkedText` default), which the prompt says out loud. */
  private async applyAll(targets: Extract<CardSnapshot, { kind: 'text' }>[]): Promise<void> {
    const confirmed = await new Promise<boolean>(resolve => {
      new ConfirmModal(this.app, {
        title: 'Apply all resolutions',
        message:
          `Write the current picks to ${targets.length} files? Any change you haven't picked a ` +
          'side for keeps Mine. The other versions stay in the sync history and can be recovered.',
        confirmText: `Apply to ${targets.length} files`,
      }, resolve).open();
    });
    if (!confirmed) return;

    this.applyingAll = true;
    void this.render();
    const failed: string[] = [];
    try {
      for (const t of targets) {
        if (t.text === null) continue;
        const resolved = resolveMarkedText(t.text, this.resolutionsFrom(this.selectionFor(t.item.fileId)));
        try {
          await this.host.resolveFile(t.item.path, resolved);
        } catch {
          // One bad write must not strand the rest — carry on and report at the end.
          failed.push(t.item.path);
        }
      }
    } finally {
      this.applyingAll = false;
      void this.render(); // drop the "Applying…" state even if a write threw
    }
    if (failed.length > 0) {
      new Notice(`Could not resolve ${failed.length} file${failed.length !== 1 ? 's' : ''}: ${failed.join(', ')}`);
    }
    // Same debounced-flush wait as the single-file apply.
    window.setTimeout(() => this.refresh(), 400);
  }

  /** A delete/binary conflict card: one decision, resolved inline (§3 "full inline").
   *  Recording a choice triggers a sync that applies it; once it lands the card stays,
   *  frozen, until the tab is left. */
  private renderDecisionCard(root: HTMLElement, c: ConflictDescriptor, frozen: boolean): void {
    const card = root.createDiv(`vault-sync-conflict-card${frozen ? ' is-resolved' : ''}`);
    const head = card.createDiv('vault-sync-conflict-card-header');
    const title = head.createDiv('vault-sync-conflict-path');
    setIcon(title.createSpan('vault-sync-conflict-path-icon'), c.kind === 'delete' ? 'trash-2' : 'image');
    title.createSpan({ text: c.path });
    if (frozen) this.renderResolvedBadge(head);

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
      disableButtons(actions);
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

    if (frozen) disableButtons(actions);
  }

  /** The one marker that says a card is history, not work. Colour + word (no glyph). */
  private renderResolvedBadge(head: HTMLElement): void {
    head.createDiv({ cls: 'vault-sync-conflict-resolved-badge', text: 'Resolved' });
  }

  private renderBinarySide(parent: HTMLElement, label: string, bytes: number, deviceId: string, at: number): void {
    const el = parent.createDiv('vault-sync-binary-side');
    el.createDiv({ cls: 'vault-sync-pane-label', text: label });
    const who = this.host.describeDevice(deviceId);
    const when = relativeTime(at);
    el.createDiv({ text: `${formatBytes(bytes)} · ${who}${when ? ` · ${when}` : ''}`, cls: 'vault-sync-binary-side-meta' });
  }

  private renderFileCard(
    root: HTMLElement,
    item: ConflictListItem,
    text: string | null,
    segments: ConflictMarkerSegment[] | null,
    frozen: boolean,
  ): void {
    const card = root.createDiv(`vault-sync-conflict-card${frozen ? ' is-resolved' : ''}`);

    // ── Header: path + per-head provenance ────────────────────────────────────
    const head = card.createDiv('vault-sync-conflict-card-header');
    const title = head.createDiv('vault-sync-conflict-path');
    setIcon(title.createSpan('vault-sync-conflict-path-icon'), 'file-text');
    title.createSpan({ text: item.path });
    if (frozen) this.renderResolvedBadge(head);

    const prov = head.createDiv('vault-sync-conflict-provenance');
    const sideLabels = ['Mine', 'Theirs'];
    item.heads.forEach((h, i) => {
      const chip = prov.createSpan({ cls: `vault-sync-prov-chip prov-${i === 0 ? 'ours' : 'theirs'}` });
      const who = h.hlc ? this.host.describeDevice(h.hlc.deviceId) : 'unknown device';
      const when = h.hlc ? relativeTime(h.hlc.wallTime) : '';
      chip.setText(`${sideLabels[i] ?? `Head ${i + 1}`}: ${who}${when ? ` · ${when}` : ''}`);
    });

    if (text === null || segments === null || segments.every(s => s.kind === 'clean')) {
      // The file no longer holds markers (resolved out-of-band, or mid-write) — offer
      // to open it; the next round/refresh will drop it from the list.
      const note = card.createDiv('vault-sync-conflict-note');
      note.setText('No conflict markers found on disk — it may already be resolved.');
      new ButtonComponent(card.createDiv('vault-sync-conflict-actions'))
        .setButtonText('Open note')
        .onClick(() => { void this.host.openFile(item.path); });
      return;
    }

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
    if (frozen) disableButtons(globalBar);

    // ── Per-hunk 3-way compare ────────────────────────────────────────────────
    const list = card.createDiv('vault-sync-conflict-hunks');
    let ci = 0;
    for (const seg of segments) {
      if (seg.kind !== 'conflict') continue;
      this.renderHunk(list, seg, ci, sel, frozen);
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
      // A frozen card's picks are already on disk; "Edit in note" stays live so the
      // user can still open what they just resolved.
      .setDisabled(frozen || this.applyingAll)
      .onClick(() => { void this.applyResolution(item, text, sel); });
    new ButtonComponent(footer)
      .setButtonText(frozen ? 'Open note' : 'Edit in note')
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
    frozen: boolean,
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
      if (kind && !frozen) {
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
      if (frozen) b.setDisabled(true);
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
    // The picks are kept (not dropped) so the frozen card keeps showing what was
    // applied. The resolving save clears the two-headed marker asynchronously
    // (debounced op flush); refresh shortly after so the card freezes once it lands.
    window.setTimeout(() => this.refresh(), 400);
  }

  private selectionFor(fileId: string): Map<number, SelectionKind> {
    let s = this.selections.get(fileId);
    if (!s) { s = new Map(); this.selections.set(fileId, s); }
    return s;
  }
}

/** Disable every button inside a container — used to freeze a resolved card's actions
 *  and to lock a decision card while its applying round runs. */
function disableButtons(container: HTMLElement): void {
  container.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
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
