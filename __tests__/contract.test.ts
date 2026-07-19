// Runs the shared sync-server contract suite against the in-memory fake. This is
// the fast, hermetic half of the pair; the identical suite runs against the real
// Go server in __tests__/integration/. If a scenario passes here but fails there
// (or vice-versa), the fake has drifted from the server it stands in for.

import { runContractSuite, ContractServer } from './helpers/contract-suite';
import { FakeSyncServer } from '../src/network/fake-server';

runContractSuite('fake', (): ContractServer => {
  // One fresh fake per test → isolation. It has no vault concept, so connect()
  // returns the same instance regardless of id (two devices share one vault).
  const fake = new FakeSyncServer();
  return {
    connect: () => fake,
    freshVault: () => 'vault',
  };
});
