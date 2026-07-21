// ─────────────────────────────────────────────
//  Version-DAG persistence  (sync v2)
// ─────────────────────────────────────────────
//
//  Persists the content {@link VersionDag} at `.vault-sync/version-dag.json` via a
//  `MetadataStore` port (so it stays obsidian-free and directly testable). Modeled
//  on cursor-store.ts. A missing or corrupt file loads as an empty DAG — never
//  throws — so a fresh device or a partial write can't wedge a sync round.

import { MetadataStore } from '../ports/metadata-store';
import { VersionDag } from '../core/version-dag';

const DAG_PATH = '.vault-sync/version-dag.json';

export class VersionDagStore {
  constructor(private metadata: MetadataStore) {}

  async load(): Promise<VersionDag> {
    const raw = await this.metadata.read(DAG_PATH);
    if (raw === null) return new VersionDag();
    try {
      return VersionDag.fromJSON(JSON.parse(raw));
    } catch {
      return new VersionDag();
    }
  }

  async save(dag: VersionDag): Promise<void> {
    if (!(await this.metadata.exists('.vault-sync'))) {
      await this.metadata.mkdir('.vault-sync');
    }
    await this.metadata.write(DAG_PATH, JSON.stringify(dag.toJSON()));
  }
}
