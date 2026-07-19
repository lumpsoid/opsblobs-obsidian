// ─────────────────────────────────────────────
//  Real Go sync-server harness  (integration tests only)
// ─────────────────────────────────────────────
//
//  Builds, seeds, and boots the actual server from the sibling Go repo, then
//  hands back a base URL + Bearer token the contract suite drives over HTTP.
//  Everything lives in a throwaway temp data dir and is torn down after.
//
//  Server location: env SYNC_SERVER_DIR, else ../obsidian-sync-golang relative
//  to this repo. If the directory or the `go` toolchain is absent, startServer()
//  returns null and the integration suite skips itself (so `npm test` on a box
//  without Go still passes).

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RunningServer {
  baseUrl: string;
  token: string;
  stop(): Promise<void>;
}

const SEED_USER = 'alice';
const SEED_PASSWORD = 'password123';

function serverDir(): string {
  return process.env.SYNC_SERVER_DIR
    ? resolve(process.env.SYNC_SERVER_DIR)
    : resolve(process.cwd(), '..', 'obsidian-sync-golang');
}

function haveGo(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when a real server can be built here — used to gate the suite. */
export function serverAvailable(): boolean {
  return existsSync(join(serverDir(), 'go.mod')) && haveGo();
}

/**
 * Build the server binary, seed a user + token, boot it on a random port, and
 * wait until /healthz answers. Returns null when no server is available.
 */
export async function startServer(): Promise<RunningServer | null> {
  if (!serverAvailable()) return null;

  const dir = serverDir();
  const dataDir = mkdtempSync(join(tmpdir(), 'vault-sync-it-'));
  const bin = join(dataDir, 'server');

  // Build once into the temp dir.
  execFileSync('go', ['build', '-o', bin, './cmd/server'], { cwd: dir, stdio: 'inherit' });

  const env = { ...process.env, SYNC_DATA_DIR: dataDir, SYNC_ADDR: '127.0.0.1:0' };

  // Seed a user + token against the same data dir the server will use.
  const token = execFileSync(bin, ['seed', '-user', SEED_USER, '-password', SEED_PASSWORD], { env })
    .toString()
    .trim();

  // Boot; the chosen port is reported on the "listening" log line (stderr).
  const proc = spawn(bin, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const baseUrl = await waitForAddr(proc);
  await waitForHealthz(baseUrl);

  return {
    baseUrl,
    token,
    async stop() {
      await stopProc(proc);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Resolve the base URL from the server's "listening … addr=host:port" log. */
function waitForAddr(proc: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for server addr')), 15_000);
    proc.stderr?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/addr=(\S+)/);
      if (m) {
        clearTimeout(timer);
        resolvePromise(`http://${m[1]}`);
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited before listening (code ${code})`));
    });
  });
}

async function waitForHealthz(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('server did not become healthy');
    await new Promise(r => setTimeout(r, 100));
  }
}

function stopProc(proc: ChildProcess): Promise<void> {
  return new Promise(resolvePromise => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolvePromise();
    proc.on('exit', () => resolvePromise());
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 3_000);
  });
}
