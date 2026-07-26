// ─────────────────────────────────────────────
//  ObsidianMetadataStore — live MetadataStore implementation
// ─────────────────────────────────────────────
//
//  Wraps `app.vault.adapter` (the `.opsblobs/*` persistence surface). The one
//  place `normalizePath` and the adapter APIs live for metadata reads/writes;
//  `read`/`list`/`stat` return null/empty on a missing path so callers never
//  need a try/catch.

import { App, normalizePath } from 'obsidian';
import { MetadataStore } from '../ports/metadata-store';
import { nowMs } from '../core/perf-clock';

/** Optional sub-phase accumulator for the atomic `write` ceremony, scoped to content
 *  blobs (A3 first-enable capture diagnostics, §3.2). When set, `write` splits a
 *  content-blob write into its native adapter sub-ops so `main.ts` can attribute the
 *  dominant `putMs` — deciding whether the temp-write + rename ceremony (all cost, no
 *  benefit for a disposable hash-addressed store) is worth replacing with a direct
 *  write. Null by default → zero overhead beyond one branch per write. */
export interface WritePerf {
  writeMs: number;    // Σ adapter.write(target) via the direct path (C4)
  writeTmpMs: number; // Σ adapter.write(tmp) via the atomic ceremony
  existsMs: number;   // Σ adapter.exists(target)
  removeMs: number;   // Σ adapter.remove(target) — rare on a fresh store
  renameMs: number;   // Σ adapter.rename(tmp, target)
}

/** Content-blob path prefix the {@link WritePerf} split is scoped to — so the split
 *  measures only the first-enable blob writes, not the oplog/registry/DAG checkpoints. */
const CONTENT_PREFIX = '.opsblobs/content/';

export class ObsidianMetadataStore implements MetadataStore {
  constructor(private app: App) {}

  /** When non-null, `write` accumulates its content-blob sub-phase timings here
   *  (A3 capture diagnostics). Set by `main.ts` around the first-enable capture. */
  captureWritePerf: WritePerf | null = null;

  async read(path: string): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    const p = normalizePath(path);
    if (await adapter.exists(p)) return adapter.read(p);
    // Crash recovery for the atomic write below: it stages the full contents in
    // a sibling temp, drops the old target, then renames the temp over it. If the
    // process is killed in the (microscopic) window after the remove and before
    // the rename, the target is gone but the temp holds the complete new
    // contents — read it so the last write survives rather than loading as
    // absent (which, for version-dag.json, would silently reset causal history).
    // A temp left by an interrupted write is itself a complete file (it is fully
    // written before the target is touched), so this fallback is always safe.
    const tmp = `${p}.tmp`;
    if (await adapter.exists(tmp)) return adapter.read(tmp);
    return null;
  }

  async write(path: string, data: string): Promise<void> {
    // Atomic write. `adapter.write` truncates then writes, so a crash/kill
    // mid-write (routine on mobile) can leave a torn, unparseable file — and for
    // e.g. version-dag.json the corrupt-load fallback is an empty DAG (lost
    // ancestry → future merges degrade to conflicts). Instead: stage the full
    // contents in a sibling temp, drop the old target, then rename the temp over
    // it. Because the target is removed first, the rename never overwrites — it is
    // a pure move, which is atomic and portable across desktop fs.rename and
    // mobile Capacitor alike (some platforms' rename throws on an existing
    // target). `read` covers the one kill-window where the target is already gone.
    const adapter = this.app.vault.adapter;
    const target = normalizePath(path);
    const tmp = `${target}.tmp`;
    // Fast path — no diagnostics, or a non-content write (oplog/registry/DAG): keep
    // the ceremony untimed. Only content-blob writes are split, and only when a
    // capture set the accumulator.
    const perf = this.captureWritePerf && target.startsWith(CONTENT_PREFIX) ? this.captureWritePerf : null;
    if (!perf) {
      await adapter.write(tmp, data);
      if (await adapter.exists(target)) await adapter.remove(target);
      await adapter.rename(tmp, target);
      return;
    }
    let t = nowMs();
    await adapter.write(tmp, data);
    perf.writeTmpMs += nowMs() - t;
    t = nowMs();
    const present = await adapter.exists(target);
    perf.existsMs += nowMs() - t;
    if (present) {
      t = nowMs();
      await adapter.remove(target);
      perf.removeMs += nowMs() - t;
    }
    t = nowMs();
    await adapter.rename(tmp, target);
    perf.renameMs += nowMs() - t;
  }

  async writeDirect(path: string, data: string): Promise<void> {
    // Non-atomic single write — no temp file, no rename. The content store's blobs are
    // content-addressed and disposable, and `ContentStore.get` hash-verifies on read, so
    // a torn write degrades to a missing base (F1), not a corrupt one. On this bridge the
    // rename the atomic path pays costs as much as this write itself (A3 split), so this
    // ~halves the per-blob write cost. NEVER use for the durable singletons — `write`.
    const adapter = this.app.vault.adapter;
    const target = normalizePath(path);
    const perf = this.captureWritePerf && target.startsWith(CONTENT_PREFIX) ? this.captureWritePerf : null;
    if (!perf) {
      await adapter.write(target, data);
      return;
    }
    const t = nowMs();
    await adapter.write(target, data);
    perf.writeMs += nowMs() - t;
  }

  async append(path: string, data: string): Promise<void> {
    // A plain (non-atomic) append — the journal reader tolerates a torn trailing
    // line, and the whole file is content it can also re-derive from the log, so
    // atomicity here would only cost the O(delta) win the journal exists for.
    await this.app.vault.adapter.append(normalizePath(path), data);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  async mkdir(path: string): Promise<void> {
    await this.app.vault.adapter.mkdir(normalizePath(path));
  }

  async remove(path: string): Promise<void> {
    await this.app.vault.adapter.remove(normalizePath(path));
  }

  async list(dir: string): Promise<string[]> {
    const p = normalizePath(dir);
    if (!(await this.app.vault.adapter.exists(p))) return [];
    const result = await this.app.vault.adapter.list(p);
    return result.files;
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
    const stat = await this.app.vault.adapter.stat(normalizePath(path));
    return stat ? { mtime: stat.mtime } : null;
  }
}
