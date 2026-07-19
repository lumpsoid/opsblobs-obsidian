// Runs the shared sync-server contract suite against the *real* Go server, built
// and booted from the sibling repo (see server-harness.ts). This is the true
// client↔server integration test: the actual TypeScript sync client speaking the
// wire protocol to the actual server, over HTTP.
//
// Skipped automatically when no server/toolchain is available, so it is safe in
// `npm test`; it is exercised on purpose via `npm run test:integration`.

import { describe, beforeAll, afterAll } from 'vitest';
import { runContractSuite, ContractServer } from '../helpers/contract-suite';
import { FetchServerApi } from './fetch-server-api';
import { startServer, serverAvailable, type RunningServer } from './server-harness';

describe.skipIf(!serverAvailable())('client↔server integration', () => {
  let server: RunningServer | null = null;
  let vaultCounter = 0;

  beforeAll(async () => {
    server = await startServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  runContractSuite('real Go server', (): ContractServer => ({
    // All clients hit one shared server; a unique vault per test keeps the
    // scenarios isolated (the seeded account auto-claims each vault on first use).
    connect: (vaultId: string) => new FetchServerApi(server!.baseUrl, server!.token, vaultId),
    freshVault: () => `vault-${vaultCounter++}`,
  }));
});
