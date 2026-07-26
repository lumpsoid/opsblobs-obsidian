// ─────────────────────────────────────────────
//  Tests — Exclusion policy (pure, plain values)
// ─────────────────────────────────────────────

import { describe, test, expect } from 'vitest';
import { isExcluded, isTooLarge } from '../src/core/exclusion-policy';
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

  test("the plugin's own data dir is always excluded, even with config sync on (holds the cleartext passphrase + token)", () => {
    const dataJson = '.obsidian/plugins/obsidian-vault-sync/data.json';
    expect(isExcluded(dataJson, settings({ syncObsidianConfig: false }))).toBe(true);
    expect(isExcluded(dataJson, settings({ syncObsidianConfig: true }))).toBe(true);
    // The whole install dir (binary too), not just data.json.
    expect(isExcluded('.obsidian/plugins/obsidian-vault-sync/main.js', settings({ syncObsidianConfig: true }))).toBe(true);
    // A *different* plugin's dir is still governed by the ordinary config toggle.
    expect(isExcluded('.obsidian/plugins/other-plugin/data.json', settings({ syncObsidianConfig: true }))).toBe(false);
    expect(isExcluded('.obsidian/plugins/other-plugin/data.json', settings({ syncObsidianConfig: false }))).toBe(true);
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

describe('isTooLarge', () => {
  const MB = 1024 * 1024;

  test('0 (or unset) means no limit', () => {
    expect(isTooLarge(500 * MB, { maxFileSizeMb: 0 })).toBe(false);
  });

  test('file at or under the cap is not too large', () => {
    expect(isTooLarge(10 * MB, { maxFileSizeMb: 10 })).toBe(false);
  });

  test('file over the cap is too large', () => {
    expect(isTooLarge(10 * MB + 1, { maxFileSizeMb: 10 })).toBe(true);
  });
});
