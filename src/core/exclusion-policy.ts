// ─────────────────────────────────────────────
//  Exclusion policy — the single "what to sync" rule
// ─────────────────────────────────────────────
//
//  Pure, framework-free domain logic (no `App`, no `obsidian` import). Decides
//  whether a vault-relative path is excluded from sync. This is the one home for
//  the exclusion decision: FileRegistry and OperationLogger both consult it.

import { SyncSettings } from '../types';

// The plugin's own metadata dir. Always excluded — not user-configurable.
const VAULT_SYNC_DIR = '.vault-sync/';

// This plugin's own install dir under `.obsidian/plugins/`. ALWAYS excluded, even
// when `syncObsidianConfig` opts the rest of `.obsidian/` in — its `data.json` holds
// the vault passphrase and access token in cleartext, and syncing it would content-
// address those secrets into the append-only (undeletable) server oplog. The id must
// match `manifest.json`'s `id`. (The plugin binary here — main.js/manifest.json — is
// also per-install and managed by Obsidian, so excluding the whole dir is correct.)
const OWN_PLUGIN_DIR = '.obsidian/plugins/obsidian-vault-sync/';

// Obsidian workspace-layout files are per-device and must never sync, even when
// the rest of `.obsidian/` is opted in via `syncObsidianConfig`.
const WORKSPACE_FILES = new Set([
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
]);

const OBSIDIAN_DIR = '.obsidian/';

/**
 * Whether `path` is excluded from sync under the given settings.
 *
 * Order of decisions:
 *  1. `.vault-sync/` — always excluded (invariant).
 *  2. This plugin's own `.obsidian/plugins/<id>/` dir — always excluded (holds the
 *     cleartext passphrase + token; must never reach the server), even with config on.
 *  3. `.obsidian/workspace.json` / `workspace-mobile.json` — always excluded.
 *  4. Other `.obsidian/` files — excluded unless `syncObsidianConfig` is true.
 *  5. `excludedPatterns` globs (`*`, `**`, `?`) — excluded on match.
 */
export function isExcluded(
  path: string,
  settings: Pick<SyncSettings, 'excludedPatterns' | 'syncObsidianConfig'>,
): boolean {
  // (1) Plugin metadata — invariant.
  if (path.startsWith(VAULT_SYNC_DIR)) return true;

  // (2) This plugin's own install dir (secrets in data.json) — invariant, even when
  // syncObsidianConfig opts the rest of `.obsidian/` in.
  if (path.startsWith(OWN_PLUGIN_DIR)) return true;

  // (3) Workspace-layout files — invariant, even when syncing config.
  if (WORKSPACE_FILES.has(path)) return true;

  // (4) The rest of `.obsidian/` — only when the user hasn't opted in.
  if (path.startsWith(OBSIDIAN_DIR) && !settings.syncObsidianConfig) return true;

  // (5) User-configured glob patterns.
  for (const pattern of settings.excludedPatterns ?? []) {
    if (globToRegExp(pattern).test(path)) return true;
  }

  return false;
}

/**
 * Whether `sizeBytes` is over the user's configured per-file cap. Mirrors the
 * server's `MaxBlobSize` (docs/server-api-spec.md §9.6), but enforced client-side
 * and pre-emptively — an oversize file is never hashed, stored, or queued for
 * upload, rather than round-tripping to the server only to get a 413.
 *
 * Kept separate from {@link isExcluded} rather than folded into it: that check is
 * decided purely from `path`, while this one needs a byte count that isn't always
 * on hand at the same call site (the offline capture pass has it up front from the
 * vault listing's stat; a live create/modify event only learns it after the file
 * is read). `maxFileSizeMb <= 0` means no cap.
 */
export function isTooLarge(
  sizeBytes: number,
  settings: Pick<SyncSettings, 'maxFileSizeMb'>,
): boolean {
  const maxMb = settings.maxFileSizeMb;
  if (!maxMb || maxMb <= 0) return false;
  return sizeBytes > maxMb * 1024 * 1024;
}

// Cache compiled patterns — the same handful are matched against every path.
const regExpCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = regExpCache.get(pattern);
  if (cached) return cached;

  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` matches across path separators (any characters).
        re += '.*';
        i++;
      } else {
        // `*` matches within a path segment (no `/`).
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escapeRegExpChar(ch);
    }
  }
  const compiled = new RegExp(`^${re}$`);
  regExpCache.set(pattern, compiled);
  return compiled;
}

function escapeRegExpChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
