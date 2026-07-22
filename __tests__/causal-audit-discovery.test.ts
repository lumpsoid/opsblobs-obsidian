// ─────────────────────────────────────────────
//  Causal-decision audit — discovery tests (sync v2)
// ─────────────────────────────────────────────
//
//  Asserts the CORRECT behavior for an OPEN finding from the causal-decision audit
//  (docs/causal-decision-audit.md). `test.skip` because it is not yet fixed — un-skip
//  when the fix lands. Same class as the fixed "identical content ≠ causal convergence"
//  bug (concurrent-identical-edit-convergence.test.ts, guide §7): a causal decision made
//  from a proxy (here an HLC-max projection) that leaves a DAG head stranded and silently
//  drops an edit.
//
//  Finding A (delete-convergence) is NOT here: it was re-diagnosed as a benign stranding
//  plus a by-design delete/create conflict, and its one real (minor) bug is fixed and
//  pinned in `recreate-after-delete.test.ts`. See the audit doc.

import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([5, 5, 5, 5, 1, 1, 1, 1, 5, 5, 5, 5, 1, 1, 1, 1]);
const onDisk = async (d: TestDevice, p = 'my.md') => {
  const b = await d.files.read(p); return b ? new TextDecoder().decode(b) : '<deleted>';
};

describe('causal-decision audit — open findings (correct behavior asserted)', () => {
  let vc: VaultCrypto;
  beforeAll(async () => { vc = new VaultCrypto(); await vc.deriveFromPassphrase('pp', SALT); });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  // ── Finding B: server-sync.ts reconstructRemoteState HLC-max collapse (line ~437) ─
  // ROOT CAUSE: the remote projection keeps only the HLC-max op PER fileId. When a
  // device pulls TWO concurrent remote heads for one file (3 devices: B and C both edit
  // and push without merging), only the higher-HLC head drives the merge; the other is
  // recorded as a DAG leaf but never reconciled, and the cursor advances past it. The
  // losing edit is invisible on the puller until one of the original editors happens to
  // re-sync and merge — a silent, latent divergence. FIX (design decision): either the
  // projection surfaces all concurrent heads per fileId, or the merge scans the DAG for
  // additional open remote leaves and reconciles them (mint a merge node).
  test.skip('three devices: two concurrent edits to one file both converge on the puller', async () => {
    const api = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');
    const C = await TestDevice.create('dev-c');

    await A.seedFile('my.md', 'base\nx\n', 1000);
    await client(api, A).runSync();
    await client(api, B).runSync();
    await client(api, C).runSync();

    // B and C edit DIFFERENT lines (a clean 3-way) concurrently and push.
    await B.editFile('my.md', 'B-edit\nx\n', 2000);
    await client(api, B).runSync();
    await C.editFile('my.md', 'base\nC-edit\n', 3000);
    await client(api, C).runSync();

    // A pulls both. It must converge to a state that reflects BOTH edits — not silently
    // adopt only the HLC-max one and strand the other.
    await client(api, A).runSync();
    await client(api, A).runSync(); // allow a reconciling second round if needed

    expect(await onDisk(A)).toBe('B-edit\nC-edit\n');
  });
});
