// ─────────────────────────────────────────────
//  Vault-binding persistence  (vault-switch guard)
// ─────────────────────────────────────────────
//
//  Records which server `vaultId` this device's local sync state (cursor,
//  registry, version DAG) was last built against, at `.opsblobs/vault-binding.json`.
//  Modeled on cursor-store.ts. Settings carry the *desired* vaultId; this file is
//  the backstop that lets `triggerSync` notice when the two have drifted apart
//  (e.g. `data.json` edited or restored outside the "Switch vault" UI flow) and
//  block-and-warn before reusing local state that may belong to a different vault.
//  `null` means "no marker yet" — either a fresh install or an upgrade from a
//  version that predates this guard; the caller decides how to treat that.

import { MetadataStore } from '../ports/metadata-store';

const BINDING_PATH = '.opsblobs/vault-binding.json';

export class VaultBindingStore {
  constructor(private metadata: MetadataStore) {}

  async load(): Promise<string | null> {
    const raw = await this.metadata.read(BINDING_PATH);
    if (raw === null) return null;
    try {
      const parsed = (JSON.parse(raw) as { vaultId?: string }).vaultId;
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(vaultId: string): Promise<void> {
    if (!(await this.metadata.exists('.opsblobs'))) {
      await this.metadata.mkdir('.opsblobs');
    }
    await this.metadata.write(BINDING_PATH, JSON.stringify({ vaultId }));
  }
}
