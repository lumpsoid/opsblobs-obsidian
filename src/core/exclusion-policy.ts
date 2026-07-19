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
 *  2. `.obsidian/workspace.json` / `workspace-mobile.json` — always excluded.
 *  3. Other `.obsidian/` files — excluded unless `syncObsidianConfig` is true.
 *  4. `excludedPatterns` globs (`*`, `**`, `?`) — excluded on match.
 */
export function isExcluded(
  path: string,
  settings: Pick<SyncSettings, 'excludedPatterns' | 'syncObsidianConfig'>,
): boolean {
  // (1) Plugin metadata — invariant.
  if (path.startsWith(VAULT_SYNC_DIR)) return true;

  // (2) Workspace-layout files — invariant, even when syncing config.
  if (WORKSPACE_FILES.has(path)) return true;

  // (3) The rest of `.obsidian/` — only when the user hasn't opted in.
  if (path.startsWith(OBSIDIAN_DIR) && !settings.syncObsidianConfig) return true;

  // (4) User-configured glob patterns.
  for (const pattern of settings.excludedPatterns ?? []) {
    if (globToRegExp(pattern).test(path)) return true;
  }

  return false;
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
