// ─────────────────────────────────────────────
//  Delete-conflict strategy policy (pure domain)
// ─────────────────────────────────────────────

import { SyncSettings } from '../types';

/**
 * Map the configured delete-conflict strategy to a concrete resolution.
 *
 * A delete conflict is a file deleted on one device and modified on another.
 * `keep_deleted` honours the deletion; `keep_modified` restores the surviving
 * edit; `ask` defers to the user (the shell opens a modal). Keeping this map in
 * the domain lets the product change the policy without touching the shell.
 */
export function resolveDeleteStrategy(
  strategy: SyncSettings['deleteConflictStrategy'],
): 'keep_deleted' | 'restore' | 'ask' {
  switch (strategy) {
    case 'keep_deleted':
      return 'keep_deleted';
    case 'keep_modified':
      return 'restore';
    case 'ask':
      return 'ask';
  }
}
