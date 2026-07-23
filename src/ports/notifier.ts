// ─────────────────────────────────────────────
//  Notifier port  (pure — must not import 'obsidian')
// ─────────────────────────────────────────────
//
//  A thin surface over Obsidian's `Notice` so the SyncCoordinator can surface
//  user-facing messages without importing `obsidian` (and so tests can spy on
//  them). The live implementation (`network/ObsidianNotifier`) just constructs
//  a `Notice`.

/** An optional labelled action attached to a durable notice — pure data plus a
 *  callback, so the port stays free of `obsidian`. The live adapter renders it as a
 *  clickable link; the callback is the plugin's (e.g. open settings). */
export interface NotifierAction {
  label: string;
  run: () => void;
}

export interface Notifier {
  /** A transient informational toast (e.g. "sync complete"). */
  info(msg: string): void;
  /** A transient error toast (e.g. "sync failed: …"). */
  error(msg: string): void;
  /** A durable (non-fading), error-styled notice for setup-class failures the user
   *  must act on (wrong token, wrong vault, passphrase mismatch) — see UX audit §5.
   *  Optionally carries one labelled action (e.g. "Open settings"). */
  setupError(msg: string, action?: NotifierAction): void;
}
