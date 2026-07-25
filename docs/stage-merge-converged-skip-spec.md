# Vault Sync — Merge-Staging Converged-File Skip Spec

**Status:** Landed · **Owner:** client/perf · **Follows:** `docs/build-local-state-perf-spec.md` (A2)

> **Implementation note (landed).** The §3 F2 re-add loop needed an extra
> `!remote.fileEntries.has(id)` guard not in the original draft: a converged file's path
> collides with its own same-id remote entry, so without the guard the F2 loop re-adds
> every file the converged-skip just removed, silently defeating the optimization (staged
> hashes stay at N instead of 0). The guard restricts F2 to genuinely local-only ids — the
> real create/create case — matching the loop's own "local-only" comment. The §5 test 2
> assertion was likewise corrected: the converged file draws a bytes-free `send_remote`
> (it is local-only in that round's projection), which is not a local write, so the test
> asserts "no local-WRITING action + content unchanged" rather than "absent from all
> applied actions". Both §3 and §5 below reflect the landed code.

A follow-on to the A2 content-staging cut. A2 moved byte staging out of the pre-pull
identity build and made it *scoped* to the files a round reconciles (`stageMergeContent`).
This spec removes the residual O(vault) **local pack read** that A2's scoping still incurs
on a **whole-vault pull** (a fresh version-DAG build over an existing vault, or a
cursor-rewind DAG rebuild), by skipping the staging of files that are already **converged**
— the merge will `no_op` them without reading a byte.

It is the read-side twin of the pull-download Tier 0 landed in
`perf(pull): serve already-held blobs from packs — 3-tier fetchRemoteBlobs` (commit
`5607b11`): that stopped re-*downloading* already-held blobs; this stops re-*reading* the
local bytes of files the merge won't touch.

---

## 1. The path this optimizes

In `runSync` (`src/network/server-sync.ts`), **after** the pull + push, at the scoped
content-staging step:

```
runSync
  :470  await this.stageMergeContent(local, remote, dag)
          │
  :965  stageMergeContent(local, remote, dag)
          :966  const fileIds = new Set(remote.fileEntries.keys())   ← the remote projection
          :969-973  + any LOCAL file colliding by path with a live remote entry (F2)
          :974  await this.stageForFiles(local, fileIds, dag)
                  │
  :985  stageForFiles(state, fileIds, dag)
          :986-993  needed += le.contentHash + dag.reachableContentHashes(le.headVersionId)
          :994… await this.host.stageContent(local, needed)
                  │
        PluginVaultSyncHost.stageContent  (src/network/vault-sync-host.ts:143)
          :155  this.contentStore.get(hash)   ← THE PACK READS (base64 decode + hash-verify)
```

`ContentStore.get` (`src/core/content-store.ts:208`, pack extraction at `:221`) is
hash-verified per blob and amortizes a pack read across every blob in that pack
(`:215-232`). Still, the *number of files whose bytes are read* is what this spec attacks.

### Why it is O(vault) on a whole-vault pull

The scope is fixed at `stageMergeContent:966`: `fileIds = remote.fileEntries.keys()` — every
file the **remote projection** touches. `remote` is
`reconstructRemoteState(pulled.map(p => p.op))` (`server-sync.ts:417`), so the projection is
exactly the files referenced by the ops pulled *this round*.

- **Steady-state converged round** (what A2 optimized): `pulled` is a handful of new ops →
  projection is a handful of files → O(touched). This is the A2 win (whole-vault staging
  ~52s → 36ms on-device; see A2 §5).
- **Fresh DAG build / cursor-rewind re-pull** (the target of this spec): cursor is 0, so
  `pulled` = every op from seq 0 → projection = the **entire vault** → `stageForFiles` reads
  **every file's bytes from packs**. `O(touched)` is still literally true, but "touched this
  round" *is* the whole vault, so it degenerates to **O(vault) local reads** — the same
  Capacitor-FS cost class A2 measured at ~52s for a full vault.

Cursor-rewind re-pull is reached by `runSync`'s self-heal (`server-sync.ts` DAG-loss guard,
`dagNeedsRebuild` → `saveCursor(0)`), and by any manual reset that rewinds the pull cursor.

---

## 2. What the merge actually reads (the safety spine)

The pure merge (`src/merge/state-merge.ts`, `classifyAndResolve` at `:62`) reads
`contentStore.get(...)` only for files it must **write**. The relevant branch is
**"Same content"** (`:133`), entered when `!le.deleted && !re.deleted && le.contentHash ===
re.contentHash`:

- `le.path !== re.path` → `resolveRenameConflict` (`:136` → `:642`) — returns `no_op` or
  `move_local`, **reads no bytes**.
- Else, only if `le.headVersionId !== re.headVersionId` (`:147`) AND `localAtHead`:
  - remote is a strict descendant (`:158`) → `write_local`, **reads bytes** at `:161`
    (`local.contentStore.get(le.contentHash) ?? remote.contentStore.get(re.contentHash)`).
  - genuine divergence (`:165`) → `write_merge`, **reads bytes** at `:170` (same expression).
- Otherwise falls through to `no_op` at `:177`, **reads no bytes**.

**Conclusion.** Equal content hash does **not** by itself mean "no bytes needed" — the
descendant/divergence sub-cases at `:161`/`:170` read bytes even when hashes match. The
provably-safe "no read" condition is stronger: **equal content hash AND equal head version
AND equal path**. With identical heads the byte-reading branches are unreachable (they are
gated on `le.headVersionId !== re.headVersionId`), so the merge returns `no_op` at `:177`
without touching the content store.

This is exactly the dominant shape of the target scenario: a device re-pulling its own
already-applied history sees, for each file, `le.headVersionId === re.headVersionId` (same
op-ids), so nearly every file qualifies for the skip. Two devices that converged by
*concurrent identical* edits have **different** head op-ids for the same bytes and are
correctly **not** skipped (the merge may mint a `write_merge` and needs the bytes).

---

## 3. The change

Filter the projection in `stageMergeContent` (`server-sync.ts:965`) so a converged file's
bytes are never added to the stage set. Do it here (not in `stageForFiles`) because
`stageForFiles` is also driven by the multi-head reconcile sweep with a different id set and
has no `remote` to compare against.

```ts
private async stageMergeContent(local: VaultState, remote: VaultState, dag: VersionDag): Promise<void> {
  const fileIds = new Set<string>();
  for (const [id, re] of remote.fileEntries) {
    const le = local.fileEntries.get(id);
    // Stage-side Tier 0: a file both sides agree on — same content, same head, same
    // path — is reconciled by the merge as a bytes-free no_op (state-merge.ts :133 →
    // :177; the byte-reading :161/:170 branches are gated on differing heads). Staging
    // its local bytes + bases is wasted pack I/O. `headVersionId` must be present and
    // equal (two absent heads compare === but are not a proven no_op → do NOT skip).
    if (
      le && !le.deleted && !re.deleted &&
      le.headVersionId != null && le.headVersionId === re.headVersionId &&
      le.contentHash === re.contentHash &&
      le.path === re.path
    ) {
      continue;
    }
    fileIds.add(id);
  }

  // A LOCAL-ONLY file colliding by path with a live remote entry (F2) is a genuine
  // reconciliation whose bytes the merge reads — always stage it. The
  // `!remote.fileEntries.has(id)` guard is REQUIRED once the loop above skips converged
  // files: a converged file's path collides with its own (same-id) live remote entry, so
  // the bare `remoteLivePaths.has(le.path)` test would re-add every file we just skipped
  // and undo the optimization. Restricting to ids absent from the remote projection keeps
  // this to the genuine create/create case (a distinct local id at the same path); ids the
  // projection already names were decided by the loop above (staged unless converged).
  const remoteLivePaths = new Set<string>();
  for (const re of remote.fileEntries.values()) if (!re.deleted) remoteLivePaths.add(re.path);
  if (remoteLivePaths.size > 0) {
    for (const [id, le] of local.fileEntries) {
      if (!le.deleted && !remote.fileEntries.has(id) && remoteLivePaths.has(le.path)) fileIds.add(id);
    }
  }

  await this.stageForFiles(local, fileIds, dag);
}
```

No interface change, no host change, no new method. `stageForFiles`, `stageContent`, the
merge, and the multi-head sweep are untouched.

### Why skipping the bases is safe too

`stageForFiles` (`:991-993`) also stages each head's DAG-reachable bases. Bases are read by
the merge only for three-way conflict resolution. A converged (`no_op`) file has no conflict,
so its bases are never read. If a *non-converged* file needs some base whose bytes happen to
equal a skipped file's content, that base is still added to `needed` through the
non-converged file's own head walk and staged independently — the skip removes a file's
contribution, never a hash another file legitimately needs.

---

## 4. Invariants preserved (sync-engineering-guide §5, §9)

- **No silent write drop.** The skip is a strict subset of the merge's own `no_op` decision:
  every skipped file is one the merge would resolve to `no_op` without reading bytes. If any
  input differs (content, head, or path), the file is staged as before.
- **F1 (missing base → conflict, not corruption).** Unchanged: only converged files lose
  their staging; a divergent file still stages its bytes + bases, and a genuinely-absent base
  still degrades to a conflict.
- **Concurrent-identical convergence.** Files that reached identical bytes by concurrent
  edits keep distinct head op-ids → not skipped → the `write_merge` at `:172` still gets its
  bytes. (Regression covered by `__tests__/concurrent-identical-edit-convergence.test.ts`;
  must stay green.)
- **Multi-head reconcile sweep.** Untouched — it calls `stageForFiles` directly with its own
  id set; this change only narrows `stageMergeContent`'s set.
- **Push staging.** Untouched (`server-sync.ts:447` stages pending-op content for upload; a
  different call site and set).

---

## 5. Test

New file `__tests__/stage-merge-converged-skip.test.ts`. Reuse the `spyStageContent` helper
pattern from `__tests__/scoped-content-staging.test.ts:33` (wrap `d.host.stageContent`, sum
the hash-set sizes it is asked to stage). The existing A2 test only covers the *converged
self-sync* case (empty remote projection); this asserts the new win on a **non-empty**
projection where every file is converged.

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { ServerSyncClient } from '../src/network/server-sync';
import { VaultCrypto } from '../src/network/encryption';
import { FakeSyncServer } from '../src/network/fake-server';
import { VaultState } from '../src/types';
import { TestDevice } from './helpers/test-device';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
const dec = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);
const onDisk = async (d: TestDevice, p: string): Promise<string | null> => dec(await d.files.read(p));

/** Sum the hash-set sizes `host.stageContent` is asked to stage (per scoped-content-staging.test.ts). */
function spyStageContent(d: TestDevice): { total: () => number } {
  const calls: number[] = [];
  const orig = d.host.stageContent.bind(d.host);
  d.host.stageContent = async (state: VaultState, hashes: Iterable<string>): Promise<void> => {
    const arr = [...hashes];
    calls.push(arr.length);
    return orig(state, arr);
  };
  return { total: () => calls.reduce((a, b) => a + b, 0) };
}

describe('stage-side converged skip', () => {
  let vc: VaultCrypto;
  beforeAll(async () => {
    vc = new VaultCrypto();
    await vc.deriveFromPassphrase('stage-converged-skip', SALT);
  });
  const client = (api: FakeSyncServer, d: TestDevice) =>
    new ServerSyncClient({ api, crypto: vc, host: d.host, hlc: d.hlc });

  test('a whole-vault re-pull of converged files stages ZERO local bytes and keeps content', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    // A seeds N files and pushes; B pulls + applies them (B is now converged with A:
    // same content, same head op-ids, same paths).
    const N = 12;
    for (let i = 0; i < N; i++) await A.seedFile(`n${i}.md`, `body ${i}\n`, 1000 + i);
    await client(server, A).runSync();
    await client(server, B).runSync();
    expect(await onDisk(B, 'n0.md')).toBe('body 0\n');

    // Force B to re-pull the WHOLE server log (cursor rewind → the remote projection is
    // the entire vault, NOT the empty projection of a converged self-sync). Every file is
    // converged, so the merge no_ops each without reading bytes → the scoped stage must
    // fetch ZERO hashes.
    await B.cursorStore.save(0);
    const spy = spyStageContent(B);
    await new ServerSyncClient({ api: server, crypto: vc, host: B.host, hlc: B.hlc }).runSync();

    expect(spy.total()).toBe(0);                       // ← the win: no local pack reads
    // Data safety: nothing was lost by skipping the staging.
    for (let i = 0; i < N; i++) expect(await onDisk(B, `n${i}.md`)).toBe(`body ${i}\n`);
  });

  test('a divergent file in the same re-pull is still staged (skip is not over-eager)', async () => {
    const server = new FakeSyncServer();
    const A = await TestDevice.create('dev-a');
    const B = await TestDevice.create('dev-b');

    await A.seedFile('same.md', 'shared\n', 1000);
    await A.seedFile('changes.md', 'v1\n', 1001);
    await client(server, A).runSync();
    await client(server, B).runSync();

    // A edits changes.md and pushes; `same.md` stays converged on both sides.
    await A.editFile('changes.md', 'v2\n', 2000);
    await client(server, A).runSync();

    // B pulls: `same.md` is converged (skipped), `changes.md` diverged (must be staged so
    // the merge can write v2). Staged hash count is > 0 but bounded by the divergent set.
    const spy = spyStageContent(B);
    const mark = B.applied.length;
    await client(server, B).runSync();

    expect(spy.total()).toBeGreaterThan(0);            // changes.md WAS staged
    expect(await onDisk(B, 'changes.md')).toBe('v2\n'); // and correctly written
    // same.md was skipped safely: no local-WRITING action targeted it and its content is
    // unchanged. (It is local-only in THIS round's remote projection — its create op was
    // not re-pulled — so the merge draws a bytes-free `send_remote` for it; that reads no
    // bytes and is not a local write, so it must not count as "touched".)
    const localWrites = new Set(['write_local', 'write_merge', 'delete_local', 'move_local', 'conflict', 'delete_conflict', 'binary_conflict']);
    const wroteSame = B.applied.slice(mark).filter(a => localWrites.has(a.type) && (a as { path?: string }).path === 'same.md');
    expect(wroteSame).toHaveLength(0);
    expect(await onDisk(B, 'same.md')).toBe('shared\n');
  });
});
```

**What each test guards:**
- Test 1 is the optimization proper: a non-empty whole-vault projection of converged files
  stages **0** hashes (pre-change it would stage ≈ N + bases), and no data is lost.
- Test 2 is the anti-over-eager guard: a divergent file in the *same* round is still staged
  and written, so the skip can never silently drop a needed write.

---

## 6. Rollout & verification

1. Land the `stageMergeContent` filter (§3) + both tests (§5).
2. `npx vitest run` — full unit suite green, especially
   `scoped-content-staging`, `concurrent-identical-edit-convergence`,
   `two-device-happy-paths`, `dag-rebuild-on-loss`, `pull-blob-dedup`.
3. `npm run test:integration` — real-server wire green.
4. On-device (Capacitor, F ≈ 8k): measure a cursor-rewind re-pull before/after; the
   `stageContent` lap (see `__tests__/perf-timing.test.ts` lap labels) should drop from
   O(vault) to ≈ 0 on a fully-converged rebuild, mirroring the A2 converged-round result.

## 7. Scope boundary (explicitly not in this spec)

- The network download dedup (Tier 0/1/2 in `fetchRemoteBlobs`) is already landed (commit
  `5607b11`); this spec is only the local-read twin.
- The push-side content-less-op guard (a non-delete pending op that stages no content is
  appended blob-less — a silent data-loss shape, currently invariant-guarded) is a separate
  hardening, not covered here.
