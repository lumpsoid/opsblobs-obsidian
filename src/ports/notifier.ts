// ─────────────────────────────────────────────
//  Notifier port  (pure — must not import 'obsidian')
// ─────────────────────────────────────────────
//
//  A thin surface over Obsidian's `Notice` so the SyncCoordinator can surface
//  user-facing messages without importing `obsidian` (and so tests can spy on
//  them). The live implementation (`network/ObsidianNotifier`) just constructs
//  a `Notice`.

export interface Notifier {
  /** A transient informational toast (e.g. "sync complete"). */
  info(msg: string): void;
  /** A transient error toast (e.g. "sync failed: …"). */
  error(msg: string): void;
}
