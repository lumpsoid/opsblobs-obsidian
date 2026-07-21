// ─────────────────────────────────────────────
//  EditorSaver port  (pure — must not import 'obsidian')
// ─────────────────────────────────────────────
//
//  The one Obsidian-only seam of the pre-sync capture (S1): flushing unsaved
//  editor buffers to disk so `captureOfflineChanges` sees the latest bytes. Behind
//  a port so the SyncCoordinator's capture sequence stays unit-testable; the live
//  implementation (`network/ObsidianEditorSaver`) is a thin, guarded adapter.

export interface EditorSaver {
  /** Best-effort flush of unsaved editor buffers to disk. Must never throw — the
   *  on-disk drift capture is the actual safety net; this only narrows the window. */
  saveOpenEditors(): Promise<void>;
}
