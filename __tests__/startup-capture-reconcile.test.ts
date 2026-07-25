// ─────────────────────────────────────────────
//  Startup-capture reconcile loop (docs/startup-capture-live-edits-spec.md)
// ─────────────────────────────────────────────
//
//  `captureOfflineChangesAndReconcile` covers the blind window between the
//  first-enable/startup `captureOfflineChanges` scan and `startListening()`
//  attaching the real listener: a live edit made during that window can't be
//  routed through the real handlers (they'd race the scan's own registry
//  mutations — spec §1.2), so a disposable path-only watcher tracks touched
//  paths instead, and the idempotent `captureOfflineChanges` reruns against
//  them until it goes quiet or `maxReconcilePasses` is hit.
//
//  Driven through the REAL device stack (TestDevice over in-memory fakes) so the
//  genuine OperationLogger / registry / watcher wiring is exercised, not a
//  look-alike (per [[vault-ports-and-testing]]).

import { describe, test, expect } from 'vitest';
import { TestDevice } from './helpers/test-device';

describe('captureOfflineChangesAndReconcile', () => {
  test('an edit landing during the main pass is captured by one reconcile pass — exactly one final op, latest content as head', async () => {
    const dev = await TestDevice.create('reconcile-a');
    // 150 pre-existing files (no create event ever fires for these) — enough to
    // cross the progress callback's 100-file tick, so we have a hook to fire a
    // live edit partway through the main pass, same as capture-cancellation.test.ts.
    const N = 150;
    for (let i = 0; i < N; i++) await dev.seedExistingFile(`n${i}.md`, `body ${i}\n`);

    let edited = false;
    const passes = await dev.opLogger.captureOfflineChangesAndReconcile((scanned) => {
      // n5.md was already scanned by the time we're 100 files in — this models
      // the "scan already visited this file" case (spec §1.1's second bullet):
      // the edit is invisible to the pass in flight and needs the reconcile pass.
      if (!edited && scanned >= 100) {
        edited = true;
        void dev.files.write('n5.md', new TextEncoder().encode('body 5 EDITED\n'));
        dev.watcher.emitModify('n5.md');
      }
    });

    // Exactly one reconcile pass ran (MAX_RECONCILE_PASSES = 1): the main pass,
    // plus one rescan that picked up n5.md.
    expect(passes.length).toBe(2);

    // n5.md was untracked when the main pass visited it (pre-existing file, no
    // registry entry yet), so that pass legitimately emits a `create` op against
    // its pre-edit bytes — that's not a duplicate, it's an accurate history entry.
    // The reconcile pass then sees an already-tracked file whose bytes changed and
    // emits exactly ONE `update` on top — no re-emitted create, no duplicate update.
    const n5Ops = dev.pendingOps.filter(op => op.path === 'n5.md');
    expect(n5Ops).toHaveLength(2);
    expect(n5Ops[0]!.type).toBe('create');
    expect(n5Ops[1]!.type).toBe('update');

    // The registry head reflects the LATEST content, not a stale scan snapshot.
    const entry = dev.entryByPath('n5.md')!;
    expect(entry.headVersionId).toBe(n5Ops[1]!.id);
    const bytes = await dev.content(entry.contentHash);
    expect(new TextDecoder().decode(bytes!)).toBe('body 5 EDITED\n');

    // Every other file got exactly one create op — the edit didn't disturb them.
    const others = dev.pendingOps.filter(op => op.path !== 'n5.md');
    expect(others).toHaveLength(N - 1);
    expect(others.every(op => op.type === 'create')).toBe(true);
  });

  test('no live edits during the pass ⇒ no reconcile pass runs at all', async () => {
    const dev = await TestDevice.create('reconcile-b');
    await dev.seedExistingFile('a.md', 'body\n');
    await dev.seedExistingFile('b.md', 'body\n');

    const passes = await dev.opLogger.captureOfflineChangesAndReconcile();

    expect(passes.length).toBe(1); // just the main pass — dirty set stayed empty
    expect(dev.pendingOps).toHaveLength(2);
  });

  test('a pathological always-dirty vault still terminates within maxReconcilePasses', async () => {
    const dev = await TestDevice.create('reconcile-c');
    await dev.seedExistingFile('hot.md', 'v0\n');

    // Re-dirty `hot.md` at the end of every single pass (main + every reconcile
    // pass) — an adversarial "another sync client is racing writes into this
    // vault" scenario (spec §2.1). The loop must still stop, bounded by the
    // explicit maxReconcilePasses argument, rather than spinning forever.
    let version = 0;
    let callCount = 0;
    const origCapture = dev.opLogger.captureOfflineChanges.bind(dev.opLogger);
    dev.opLogger.captureOfflineChanges = async (onProgress, signal) => {
      callCount++;
      const stats = await origCapture(onProgress, signal);
      version++;
      await dev.files.write('hot.md', new TextEncoder().encode(`v${version}\n`));
      // Re-dirty AFTER this pass finishes so the next iteration's `dirty.size`
      // check still sees something to chase — models continuous concurrent writes.
      dev.watcher.emitModify('hot.md');
      return stats;
    };

    const MAX = 3;
    const result = await dev.opLogger.captureOfflineChangesAndReconcile(undefined, undefined, MAX);

    expect(callCount).toBe(MAX + 1); // the main pass + exactly MAX reconcile passes, never more
    expect(result.length).toBe(MAX + 1);
  });

  test('the dirty-tracker detaches cleanly — the real listener attaches and works afterward', async () => {
    const dev = await TestDevice.create('reconcile-d');
    await dev.seedExistingFile('a.md', 'body\n');

    await dev.opLogger.captureOfflineChangesAndReconcile();
    // No real listener attached yet — an emitted event must be a no-op (the fake
    // watcher's handlers are null after `stop()`), not silently mis-routed.
    dev.watcher.emitModify('a.md');
    await dev.opLogger.flush();
    expect(dev.pendingOps.filter(op => op.path === 'a.md')).toHaveLength(1); // just the create

    // Now attach the real listener and confirm live edits are captured normally.
    dev.opLogger.startListening();
    await dev.files.write('a.md', new TextEncoder().encode('body v2\n'));
    dev.watcher.emitModify('a.md');
    await dev.opLogger.flush();

    const aOps = dev.pendingOps.filter(op => op.path === 'a.md');
    expect(aOps).toHaveLength(2); // the original create + a new live update
    expect(aOps[1]!.type).toBe('update');
  });

  test('does not interact with the abort/signal path — an abort mid-main-pass still stops the reconcile loop too', async () => {
    const dev = await TestDevice.create('reconcile-e');
    const N = 500;
    for (let i = 0; i < N; i++) await dev.seedExistingFile(`n${i}.md`, `body ${i}\n`);

    const ac = new AbortController();
    const passes = await dev.opLogger.captureOfflineChangesAndReconcile((scanned) => {
      if (scanned >= 100) ac.abort();
    }, ac.signal);

    // The main pass stopped early (same exact-count pin as capture-cancellation.test.ts)
    // and no reconcile pass ran on top of an aborted, partial main pass.
    expect(passes.length).toBe(1);
    expect(dev.pendingOps.length).toBe(100);
  });
});
