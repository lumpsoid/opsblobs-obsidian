# Vault ports refactor — spec

> **Goal.** Stop `__tests__/helpers/memory-host.ts` from re-implementing
> production merge-application logic. Today `MemoryHost.applyMerge` /
> `buildLocalState` copy the decisions in `SyncApplicator` and
> `PluginVaultSyncHost` (the file even says *"Mirror SyncApplicator"* five
> times), so a bug can live in one and not the other, and the client↔server
> contract suite tests a *look-alike* client, not the real one.
>
> **Approach (the architecture contract, §5).** Invert the dependency on
> Obsidian. The sync stack currently reaches for the concrete `obsidian` surface
> directly; instead, define **narrow ports** for what it needs from the vault,
> with an **Obsidian implementation** and a **fake implementation** each —
> exactly as the transport side already does (`ServerApi` interface /
> `HttpServerApi` real / `FakeSyncServer` fake). Then the **real** device stack
> runs in tests wired to fakes, and `MemoryHost`'s replicated logic is deleted.
>
> **Why the obsidian utils are not a problem.** `normalizePath`, `TFile`, and
> `getAbstractFileByPath` are only ever used *inside the effect* (e.g.
> `SyncApplicator.moveLocalFile`). They belong on the *inside* of the concrete
> adapter. Draw the port boundary at the right seam and the orchestrator imports
> nothing from `obsidian` — no util reimplementation, no vitest stub.

## Ground rules (every phase)

- One phase = one commit. `npm run build` + `npm test` green before commit.
  Phase 5 additionally runs `npm run test:integration` **if** the Go server repo
  is present (`../obsidian-sync-golang`, or `$SYNC_SERVER_DIR`); if not, say so.
- Commits carry **no** `Co-Authored-By` trailer.
- **Interfaces live in obsidian-free modules.** An interface a core class depends
  on MUST NOT sit in the same file as an `Obsidian*` impl (that would re-pull
  `obsidian` into the core class through the type import). Mirror `ServerApi`
  (interface in `server-sync.ts`, impl in `server-http.ts`).
- Keep behaviour identical unless a phase explicitly says otherwise. The
  convergence/data-loss/rename tests are the safety net — they must keep passing.

## Module layout introduced by this refactor

```
src/ports/vault-files.ts       # VaultFiles interface + VaultFileRef (pure)
src/ports/metadata-store.ts    # MetadataStore interface (pure)
src/ports/vault-watcher.ts     # VaultWatcher interface + event types (pure)
src/network/obsidian-vault-files.ts     # ObsidianVaultFiles  (imports obsidian)
src/network/obsidian-metadata-store.ts  # ObsidianMetadataStore (imports obsidian)
src/network/obsidian-vault-watcher.ts   # ObsidianVaultWatcher  (imports obsidian)
src/network/cursor-store.ts    # CursorStore, moved out of server-http.ts (uses MetadataStore)
__tests__/helpers/fakes/       # FakeVaultFiles, FakeMetadataStore, FakeVaultWatcher
__tests__/helpers/test-device.ts  # real device stack wired to fakes (replaces MemoryHost)
```

Only `main.ts` (composition root) and the `Obsidian*` impls import `obsidian`,
plus `HttpServerApi` (`requestUrl`) and the UI modules. Every core/domain unit
becomes obsidian-free and therefore directly testable.

---

## Port definitions

### `VaultFiles` — the note files (create/modify/move/trash/read/list)
```ts
export interface VaultFileRef { path: string }
export interface VaultFiles {
  list(): VaultFileRef[];                                  // was vault.getFiles()
  read(path: string): Promise<Uint8Array | null>;         // was readBinary; null if absent
  write(path: string, content: Uint8Array): Promise<void>;// create-or-modify + ensure parent dir
  move(fromPath: string, toPath: string): Promise<void>;  // was fileManager.renameFile
  trash(path: string): Promise<void>;                      // was vault.trash(file, true)
  exists(path: string): Promise<boolean>;
}
```
`ObsidianVaultFiles` holds `App`; its `write` contains the current
`writeLocalFile`+`ensureDir` body (`getAbstractFileByPath` → `modifyBinary` /
`createBinary`, `normalizePath`, parent-dir mkdir); `move`/`trash`/`read` contain
`moveLocalFile`/`deleteLocalFile`/`readBinary`. `list` maps `getFiles()` →
`{path}`. `FakeVaultFiles` is a `Map<string, Uint8Array>`.

### `MetadataStore` — the `.vault-sync/*` persistence (this is `vault.adapter`)
```ts
export interface MetadataStore {
  read(path: string): Promise<string | null>;   // null if absent (replaces try/catch)
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(dir: string): Promise<string[]>;          // file paths under dir
  stat(path: string): Promise<{ mtime: number } | null>;  // for retention GC
}
```
`ObsidianMetadataStore` wraps `app.vault.adapter` (+ `normalizePath` inside).
`FakeMetadataStore` is a `Map<string, string>` with a companion mtime map;
`stat` returns a controllable mtime.

### `VaultWatcher` — vault change events (for the OperationLogger)
```ts
export interface VaultChangeHandlers {
  onCreate(path: string): void;
  onModify(path: string): void;
  onDelete(path: string): void;
  onRename(path: string, oldPath: string): void;
}
export interface VaultWatcher {
  start(h: VaultChangeHandlers): void;  // subscribe
  stop(): void;                          // unsubscribe all
}
```
`ObsidianVaultWatcher` holds `App`, wires `vault.on('create'|'modify'|'delete'|'rename')`
with the `instanceof TFile` filter, and `offref`s on `stop`. `FakeVaultWatcher`
records the handlers and exposes `emitCreate/Modify/Delete/Rename` for tests.

---

## Phase 1 — `VaultFiles` port; relocate applicator effects

**Scope:** `SyncApplicator` becomes obsidian-free.

1. Add `src/ports/vault-files.ts` (interface + `VaultFileRef`).
2. Add `src/network/obsidian-vault-files.ts` — `ObsidianVaultFiles` holding
   `App`, with `write`/`move`/`trash`/`read`/`list`/`exists` bodies lifted from
   `SyncApplicator.writeLocalFile`/`moveLocalFile`/`deleteLocalFile`/`ensureDir`
   and `PluginVaultSyncHost`/`OperationLogger` file reads (keep the reads there
   for now; just implement them). Keep `normalizePath`/`TFile` here.
3. `SyncApplicator`: constructor takes `VaultFiles` instead of `App`. Replace the
   four private helpers with `this.files.write(path, content)` /
   `this.files.move(from, to)` / `this.files.trash(path)`. Remove
   `import … from 'obsidian'`. (Behaviour identical: `write` still create-or-
   modify + parent dir; `trash` still `vault.trash(file, true)`.)
4. `main.ts`: construct `new ObsidianVaultFiles(this.app)` once and pass it to the
   applicator. (Other classes still take `App` for now.)

**Verify:** build + `npm test` (still 100; MemoryHost unchanged). Optionally add a
tiny `FakeVaultFiles` + a direct `SyncApplicator` write/move/trash unit test to
prove the applicator now runs without Obsidian — nice but not required until P4.

**Commit:** `refactor(sync): depend on a VaultFiles port; move file effects into ObsidianVaultFiles`

---

## Phase 2 — `MetadataStore` port; migrate ContentStore / FileRegistry / CursorStore

**Scope:** `ContentStore`, `FileRegistry`, `CursorStore` become obsidian-free.

1. Add `src/ports/metadata-store.ts` (interface) and
   `src/network/obsidian-metadata-store.ts` (`ObsidianMetadataStore` over
   `app.vault.adapter`, `normalizePath` inside). Add `FakeMetadataStore` under
   `__tests__/helpers/fakes/`.
2. `ContentStore`: constructor takes `MetadataStore`. Replace every
   `this.app.vault.adapter.*` with the port; `init` uses `mkdir`/`exists`; `gc`
   uses `list`/`stat`/`remove` (keep the Fix 06 retention signature). Drop the
   `obsidian` import. `hashContent`/base64 helpers unchanged.
3. `FileRegistry`: constructor takes `MetadataStore` (persistence) **and**
   `VaultFiles` (for `reconcileWithVault`'s `getFiles()` → `files.list()`).
   Replace `registerFile(file: TFile, …)` with `registerFile(ref: VaultFileRef, …)`
   (it only reads `.path`). Update all its `adapter` calls to the port; the
   `load` try/catch becomes `read` returning null. Drop `obsidian`. Keep the
   settings getter from the earlier exclusion-policy fix.
4. Move `CursorStore` out of `server-http.ts` into `src/network/cursor-store.ts`,
   taking `MetadataStore`. (This unstitches it from `requestUrl`/`obsidian` so a
   test can load it.) `server-http.ts` keeps only `HttpServerApi` +
   `StaleCursorError`. Update imports in `main.ts` and `vault-sync-host.ts`.
5. `main.ts`: construct `ObsidianMetadataStore` and thread it into
   ContentStore/FileRegistry/CursorStore; pass the `ObsidianVaultFiles` to
   FileRegistry too.
6. **Tests:** update `__tests__/content-store-gc.test.ts` and
   `__tests__/file-registry-referenced-hashes.test.ts` to construct the real
   classes over `FakeMetadataStore`/`FakeVaultFiles` instead of `vi.mock('obsidian')`
   — simpler and closer to production. Preserve the assertions.

**Verify:** build + `npm test` (>= 100).

**Commit:** `refactor(core): persist via a MetadataStore port; drop Obsidian from ContentStore/FileRegistry/CursorStore`

---

## Phase 3 — `VaultWatcher` port; migrate OperationLogger

**Scope:** `OperationLogger` becomes obsidian-free.

1. Add `src/ports/vault-watcher.ts` (interface + handler types) and
   `src/network/obsidian-vault-watcher.ts` (`ObsidianVaultWatcher`, the
   `vault.on/offref` + `TFile` filter). Add `FakeVaultWatcher` under
   `__tests__/helpers/fakes/`.
2. `OperationLogger`: constructor takes `VaultFiles` (reads:
   `readFile`/`getByPath`-style file lookups, `getFiles` in
   `captureOfflineChanges`), `VaultWatcher` (events), and `MetadataStore` (oplog
   persistence). `startListening`/`stopListening` delegate to the watcher;
   `flush` still drives debounced modifies. Replace `readBinary` →
   `files.read`, `getAbstractFileByPath` → a `files.read`/`exists` check, the
   adapter oplog writes → `MetadataStore`. Drop `obsidian`. Keep debounce logic
   and the exclusion-policy getter.
3. `main.ts`: construct `ObsidianVaultWatcher` and thread the ports into the
   `OperationLogger`.

**Verify:** build + `npm test` (>= 100).

**Commit:** `refactor(core): drive OperationLogger through VaultFiles/VaultWatcher/MetadataStore ports`

---

## Phase 4 — Deterministic clock; obsidian-free host; TestDevice; migrate one test

**Scope:** make the real device runnable + deterministic in tests, prove the
shape on the smallest test, keep MemoryHost for the rest (still green).

1. `PluginVaultSyncHost`: constructor takes `VaultFiles` instead of `App`
   (`buildLocalState` uses `files.list`/`files.read`). Drop `obsidian`.
2. **Determinism seam.** `HybridLogicalClock` constructor gains an optional
   `now?: () => number` (default `Date.now`). Production is unchanged; tests pass
   a settable clock so a user action "at wall = 2000" reproduces the exact HLC
   scenarios the suite relies on (notably the equal-wall/counter cases decided by
   the `deviceId` tie-break). No other file calls `Date.now` for HLC.
3. Build `__tests__/helpers/test-device.ts` — a `TestDevice` that wires the
   **real** stack over fakes:
   - `FakeVaultFiles`, `FakeMetadataStore`, `FakeVaultWatcher`, a settable clock
     (`setWall(n)`), a real `HybridLogicalClock`, real `FileRegistry`,
     `ContentStore`, `OperationLogger` (**debounceMs 0**), `SyncApplicator`,
     `PluginVaultSyncHost`, `CursorStore`.
   - Applicator conflict handlers wired to overridable fields
     `resolveConflict?` / `resolveDeleteConflict?` (defaults: skip conflict →
     `null`; delete conflict → `keep_deleted`), mirroring the current
     `MemoryHost` hooks.
   - Read accessors the suite needs: `entry(id)` → `registry.getById`,
     `content(hash)` → `contentStore.get`, `pendingOps` →
     `opLogger.getPendingOps()`, `cursor()` → `cursorStore.load()`, and
     `host` (the `VaultSyncHost` passed to `ServerSyncClient`).
   - **User-action helpers** driving the *real* path (return the file id so tests
     reference it without hard-coded `'f1'`):
     - `seedFile(path, text, wall)`: `setWall(wall)`, `files.write(path, bytes)`,
       `watcher.emitCreate(path)`, `await opLogger.flush()`; return
       `registry.getByPath(path)!.id`.
     - `editFile(path, text, wall)`: `setWall`, `files.write`, `emitModify`,
       `flush`.
     - `deleteFile(path, wall)`: `setWall`, `files.trash`, `emitDelete`.
     - `renameFile(from, to, wall)`: `setWall`, `files.move`, `emitRename(to, from)`.
   These exercise the real `OperationLogger` (id assignment, hashing, op
   emission) instead of hand-built ops.
4. Migrate the smallest consumer first — `__tests__/server-sync.test.ts` — from
   `MemoryHost` to `TestDevice`, adjusting lookups to the returned ids. Leave the
   other three test files + `contract-suite.ts` on `MemoryHost` for now.

**Verify:** build + `npm test` (>= 100; server-sync via real stack now).

**Commit:** `test(sync): run the real device stack over fakes via TestDevice (clock seam); migrate server-sync test`

---

## Phase 5 — Migrate the rest; delete MemoryHost

**Scope:** move every remaining consumer to `TestDevice`; delete the replicated
logic. This is the payoff: the contract suite now drives the **real** client
against both `FakeSyncServer` and the real Go server.

1. Migrate `__tests__/helpers/contract-suite.ts`,
   `resolution-convergence.test.ts`, `concurrent-conflict-dataloss.test.ts`, and
   `delete-rename-conflict.test.ts` from `MemoryHost` to `TestDevice`.
2. **Remove now-obsolete scaffolding.** Several tests manually poke
   `host.fileEntries.get('f1')!.ancestorContentHash = …` with a comment that
   `MemoryHost` doesn't mirror the applicator's `send_remote` ancestor update.
   The **real** applicator *does* that update (Fix 03's `nextAncestorHash`), so
   delete those manual pokes and let the real stack establish the ancestor.
   Where a test asserted a value that only differed because of the fake's
   approximations (e.g. `dominatingHlc`), assert the real observable outcome
   without weakening intent.
3. Delete `MemoryHost` and its replicated `applyMerge`/`buildLocalState`/
   `dominatingHlc`. Keep the genuinely-shared pure helpers (`sha256Hex`) —
   relocate to `test-device.ts` or a small util. `memory-host.ts` is removed.
4. Run `npm test`. Then, **if the Go server repo is available**
   (`../obsidian-sync-golang` or `$SYNC_SERVER_DIR`), run
   `npm run test:integration` and confirm the contract suite passes against the
   real server driving the real client. If unavailable, note it in the commit
   body and report it.

**Verify:** build + `npm test` (all green) + integration (if available).

**Commit:** `test(sync): drive the contract suite through the real device; delete the MemoryHost reimplementation`

---

## Sequencing summary

| Phase | Obsidian-free after | Net |
|---|---|---|
| 1 | `SyncApplicator` | VaultFiles port |
| 2 | `ContentStore`, `FileRegistry`, `CursorStore` | MetadataStore port |
| 3 | `OperationLogger` | VaultWatcher port |
| 4 | `PluginVaultSyncHost` | clock seam + TestDevice + 1 test migrated |
| 5 | — | all tests on real stack; MemoryHost deleted |

After Phase 5 the only `obsidian` importers are `main.ts`, the `Obsidian*` port
impls, `HttpServerApi`, and the UI modules — exactly the composition root and the
edges, as the contract prescribes.
