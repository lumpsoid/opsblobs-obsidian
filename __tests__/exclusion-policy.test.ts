// ─────────────────────────────────────────────
//  Tests — Exclusion policy (pure, plain values)
// ─────────────────────────────────────────────

import { describe, test, expect } from 'vitest';
import { isExcluded } from '../src/core/exclusion-policy';
import { SyncSettings } from '../src/types';

type PolicySettings = Pick<SyncSettings, 'excludedPatterns' | 'syncObsidianConfig'>;

const settings = (over: Partial<PolicySettings> = {}): PolicySettings => ({
  excludedPatterns: [],
  syncObsidianConfig: false,
  ...over,
});

describe('exclusion-policy', () => {
  test('.vault-sync/ is always excluded', () => {
    expect(isExcluded('.vault-sync/file-registry.json', settings())).toBe(true);
    expect(isExcluded('.vault-sync/x', settings({ syncObsidianConfig: true }))).toBe(true);
  });

  test('.obsidian/ files excluded when syncObsidianConfig is false', () => {
    expect(isExcluded('.obsidian/foo.css', settings({ syncObsidianConfig: false }))).toBe(true);
  });

  test('.obsidian/ files included when syncObsidianConfig is true', () => {
    expect(isExcluded('.obsidian/foo.css', settings({ syncObsidianConfig: true }))).toBe(false);
  });

  test('.obsidian/workspace.json excluded regardless of syncObsidianConfig', () => {
    expect(isExcluded('.obsidian/workspace.json', settings({ syncObsidianConfig: false }))).toBe(true);
    expect(isExcluded('.obsidian/workspace.json', settings({ syncObsidianConfig: true }))).toBe(true);
    expect(isExcluded('.obsidian/workspace-mobile.json', settings({ syncObsidianConfig: true }))).toBe(true);
  });

  test('user glob attachments/** excludes nested paths', () => {
    const s = settings({ excludedPatterns: ['attachments/**'] });
    expect(isExcluded('attachments/img/photo.png', s)).toBe(true);
    expect(isExcluded('attachments/note.pdf', s)).toBe(true);
    expect(isExcluded('notes/attachments-are-cool.md', s)).toBe(false);
  });

  test('single * stays within a path segment; ? matches one non-slash char', () => {
    expect(isExcluded('a/b.tmp', settings({ excludedPatterns: ['*.tmp'] }))).toBe(false);
    expect(isExcluded('draft.tmp', settings({ excludedPatterns: ['*.tmp'] }))).toBe(true);
    expect(isExcluded('note1.md', settings({ excludedPatterns: ['note?.md'] }))).toBe(true);
    expect(isExcluded('note12.md', settings({ excludedPatterns: ['note?.md'] }))).toBe(false);
  });

  test('a normal note is not excluded', () => {
    expect(isExcluded('notes/a.md', settings())).toBe(false);
  });
});
