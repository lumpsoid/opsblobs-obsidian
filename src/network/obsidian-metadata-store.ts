// ─────────────────────────────────────────────
//  ObsidianMetadataStore — live MetadataStore implementation
// ─────────────────────────────────────────────
//
//  Wraps `app.vault.adapter` (the `.vault-sync/*` persistence surface). The one
//  place `normalizePath` and the adapter APIs live for metadata reads/writes;
//  `read`/`list`/`stat` return null/empty on a missing path so callers never
//  need a try/catch.

import { App, normalizePath } from 'obsidian';
import { MetadataStore } from '../ports/metadata-store';

export class ObsidianMetadataStore implements MetadataStore {
  constructor(private app: App) {}

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
    await adapter.write(tmp, data);
    if (await adapter.exists(target)) await adapter.remove(target);
    await adapter.rename(tmp, target);
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
