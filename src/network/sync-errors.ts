// ─────────────────────────────────────────────
//  Typed sync errors — user-actionable failure surface
// ─────────────────────────────────────────────
//
//  Every failure a sync round can hit is one of these typed errors, each carrying a
//  message written FOR THE USER (not a raw `POST /ops failed: 401` or a bare AES
//  `OperationError`). The coordinator toasts `error.message` verbatim, so the message
//  IS the user-facing text. First-run setup is exactly where people get stuck, so the
//  messages name the concrete knob to check (token, URL, vault ID, passphrase).
//
//  Obsidian-free so both the transport (server-http) and the orchestrator
//  (server-sync) can throw/catch them without pulling `obsidian` into the engine.

/** A too-stale `baseCursor` was rejected (spec §9.3 — a server MAY 409). Recovered
 *  by re-pulling and retrying (F4), so it's internal — never surfaced to the user. */
export class StaleCursorError extends Error {
  constructor() {
    super('Server rejected append: cursor too stale, re-pull first');
    this.name = 'StaleCursorError';
  }
}

/** The vault on the server was established under a different key than this device
 *  derived — a mistyped passphrase (or wrong salt). Thrown *before* any remote op is
 *  trusted or any local op is pushed, so a key mismatch is a clean, self-explaining
 *  failure at the moment onboarding is most fragile, not a silent two-key wedge (or a
 *  raw AES decrypt exception on the first pulled op). */
export class KeyMismatchError extends Error {
  constructor() {
    super(
      "This device's sync passphrase doesn't match the vault already on the server. " +
        'Check the passphrase in Vault Sync settings — it must be identical on every device.',
    );
    this.name = 'KeyMismatchError';
  }
}

/** The server rejected our token (401/403). The vaultId/URL may be fine — the token
 *  is wrong, expired, or not authorized for this vault. */
export class AuthError extends Error {
  constructor(public readonly status: number) {
    super(
      `The sync server rejected this device's access token (HTTP ${status}). ` +
        'Check the access token in Vault Sync settings — it may be wrong, expired, or not authorized for this vault.',
    );
    this.name = 'AuthError';
  }
}

/** The server returned 404 for the vault path — usually a wrong server URL or a
 *  vault ID that doesn't exist on this server. */
export class NotFoundError extends Error {
  constructor() {
    super(
      "The sync server couldn't find this vault (HTTP 404). " +
        'Check the server URL and vault ID in Vault Sync settings.',
    );
    this.name = 'NotFoundError';
  }
}

/** The server errored (5xx) or returned an otherwise-unexpected status. Transient
 *  as far as the client can tell — the next round retries. */
export class ServerError extends Error {
  constructor(public readonly status: number, operation: string) {
    super(
      `The sync server had a problem while ${operation} (HTTP ${status}). ` +
        'It may be temporarily unavailable — the next sync will retry.',
    );
    this.name = 'ServerError';
  }
}

/** The server was unreachable — no response at all (offline, bad host, DNS/TLS
 *  failure). Distinct from a server that answered with an error status. */
export class NetworkError extends Error {
  constructor(operation: string, public readonly cause?: unknown) {
    super(
      `Couldn't reach the sync server while ${operation}. ` +
        'Check the server URL and your network connection.',
    );
    this.name = 'NetworkError';
  }
}

/** A request exceeded its time budget (server-http bounds each `requestUrl`). The
 *  link may be slow or the server hung; the next round retries. */
export class TimeoutError extends Error {
  constructor(operation: string, public readonly timeoutMs: number) {
    super(
      `The sync server didn't respond within ${Math.round(timeoutMs / 1000)}s while ${operation}. ` +
        'It may be slow or unreachable — the next sync will retry.',
    );
    this.name = 'TimeoutError';
  }
}

/** Server data failed to decrypt — the passphrase almost certainly doesn't match
 *  the vault this data came from (the belt to the key-check guard's suspenders, and
 *  the catch-all for pre-guard vaults that have no key-check record yet). */
export class DecryptError extends Error {
  constructor() {
    super(
      "Couldn't decrypt data from the server — this device's passphrase likely doesn't match the vault. " +
        'Check the passphrase in Vault Sync settings.',
    );
    this.name = 'DecryptError';
  }
}

/** Is this a *setup-class* failure — one the user must fix in settings (wrong token,
 *  wrong server/vault, passphrase mismatch, undecryptable data) — as opposed to a
 *  transient transport error (network/timeout/5xx) that self-retries on the next
 *  round? Setup errors warrant a durable, actionable surface, not a fading toast
 *  (UX audit §5). */
export function isSetupError(err: unknown): boolean {
  return (
    err instanceof AuthError ||
    err instanceof NotFoundError ||
    err instanceof KeyMismatchError ||
    err instanceof DecryptError
  );
}
