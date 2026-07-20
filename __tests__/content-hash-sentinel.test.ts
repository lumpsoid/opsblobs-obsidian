// ─────────────────────────────────────────────
//  Regression: the '' contentHash sentinel must never escape into an op (audit G)
// ─────────────────────────────────────────────
//
//  `reconcileWithVault` (reached via the "Rebuild sync metadata" / resetSyncState
//  settings action) assigns an untracked file a placeholder entry whose
//  contentHash is '' ("will be filled in by the operation logger"). Until it is
//  filled, an op that copies that entry's hash — a delete or a move — would carry
//  the '' sentinel: content no peer has, and a value that could false-match a
//  `supersedes` lookup. A genuinely empty file, by contrast, has a real SHA-256,
//  so '' must never reach the wire.
//
//  Fix: a never-captured placeholder was never synced, so its *delete* is a
//  local-only tombstone (emit no op); its *rename* captures the file's real
//  content at the new path instead of a phantom '' move.

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

describe("contentHash '' sentinel never escapes into an op (audit G)", () => {
  test('deleting a never-captured (reconcile placeholder) file emits no op carrying ""', async () => {
    const d = await TestDevice.create('dev-a');

    // A file on disk the op logger never captured (no create event), then a
    // metadata rebuild assigns it a '' placeholder entry.
    await d.files.write('orphan.md', new TextEncoder().encode('hi'));
    await d.registry.reconcileWithVault(d.hlc.now());
    expect(d.entryByPath('orphan.md')!.contentHash).toBe(''); // placeholder

    await d.deleteFile('orphan.md', 1000);

    expect(d.pendingOps.some(op => op.contentHash === '')).toBe(false);
    expect(d.pendingOps.some(op => op.type === 'delete')).toBe(false); // nothing to propagate
  });

  test('renaming a never-captured placeholder captures real content, not an empty-hash move', async () => {
    const d = await TestDevice.create('dev-a');

    await d.files.write('a.md', new TextEncoder().encode('hello'));
    await d.registry.reconcileWithVault(d.hlc.now());
    expect(d.entryByPath('a.md')!.contentHash).toBe('');

    await d.renameFile('a.md', 'b.md', 2000);

    expect(d.pendingOps.some(op => op.contentHash === '')).toBe(false);
    const op = d.pendingOps.find(op => op.path === 'b.md');
    expect(op).toBeDefined();
    expect(op!.contentHash).not.toBe('');
  });
});
