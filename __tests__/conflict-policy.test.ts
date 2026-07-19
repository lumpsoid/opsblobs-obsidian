// ─────────────────────────────────────────────
//  Tests — Delete-conflict policy (pure, plain values)
// ─────────────────────────────────────────────

import { describe, test, expect } from 'vitest';
import { resolveDeleteStrategy } from '../src/core/conflict-policy';

describe('conflict-policy', () => {
  test('keep_deleted maps to keep_deleted', () => {
    expect(resolveDeleteStrategy('keep_deleted')).toBe('keep_deleted');
  });

  test('keep_modified maps to restore', () => {
    expect(resolveDeleteStrategy('keep_modified')).toBe('restore');
  });

  test('ask maps to ask', () => {
    expect(resolveDeleteStrategy('ask')).toBe('ask');
  });
});
