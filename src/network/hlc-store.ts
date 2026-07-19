// ─────────────────────────────────────────────
//  HLC persistence  (F7 — logical time survives restart)
// ─────────────────────────────────────────────
//
//  Persists this device's current Hybrid Logical Clock at `.vault-sync/hlc.json`
//  so locally-issued HLCs stay monotonic across restarts and wall-clock
//  regressions (NTP corrections, manual changes). On startup the clock is seeded
//  from the persisted value; `HybridLogicalClock.now()` then takes
//  `max(wall, current.wallTime)`, so a regressed wall clock still advances the
//  counter above the last-issued timestamp instead of rewinding below it.
//
//  Mirrors `CursorStore`: a tiny load/save over a `MetadataStore` port, so it's
//  obsidian-free and directly testable. `load()` returns null when nothing has
//  been persisted yet (a fresh device — no seed).

import { HLC } from '../types';
import { MetadataStore } from '../ports/metadata-store';

const HLC_PATH = '.vault-sync/hlc.json';

export class HlcStore {
  constructor(private metadata: MetadataStore) {}

  async load(): Promise<HLC | null> {
    const raw = await this.metadata.read(HLC_PATH);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<HLC>;
      if (
        typeof parsed.wallTime === 'number' && Number.isFinite(parsed.wallTime) &&
        typeof parsed.counter === 'number' && Number.isFinite(parsed.counter) &&
        typeof parsed.deviceId === 'string'
      ) {
        return { wallTime: parsed.wallTime, counter: parsed.counter, deviceId: parsed.deviceId };
      }
      return null;
    } catch {
      return null;
    }
  }

  async save(hlc: HLC): Promise<void> {
    if (!(await this.metadata.exists('.vault-sync'))) {
      await this.metadata.mkdir('.vault-sync');
    }
    await this.metadata.write(HLC_PATH, JSON.stringify(hlc));
  }
}
