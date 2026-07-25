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
    // same.md was skipped safely: its bytes were never locally rewritten (it may draw a
    // bytes-free `send_remote` — it is local-only in this round's remote projection —
    // but no local-WRITING action, and its content is unchanged).
    const localWrites = new Set(['write_local', 'write_merge', 'delete_local', 'move_local', 'conflict', 'delete_conflict', 'binary_conflict']);
    const wroteSame = B.applied.slice(mark).filter(a => localWrites.has(a.type) && (a as { path?: string }).path === 'same.md');
    expect(wroteSame).toHaveLength(0);
    expect(await onDisk(B, 'same.md')).toBe('shared\n');
  });
});
