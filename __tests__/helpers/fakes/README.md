# Fakes — semantic contract

These in-memory fakes stand in for the Obsidian adapters (`ObsidianVaultFiles`,
`ObsidianMetadataStore`, `ObsidianVaultWatcher`) so the real device stack runs
without an Obsidian runtime. The tests are only as trustworthy as these fakes are
faithful. The **real adapters must honor these same semantics**, and any change to
one side should be mirrored here:

- **`create` does NOT fire for files that already exist** when listeners attach.
  This is the whole reason `OperationLogger.captureOfflineChanges()` exists — a
  cold start must diff the vault against the registry, not wait for events. Model a
  pre-existing file with `TestDevice.seedExistingFile(path, text)` (no event), then
  call `captureOfflineChanges()`.
- **`modify` is asynchronous and debounced.** The handler only arms a timer; the op
  is not recorded until the debounce elapses or `flush()` drains it. `emitModify`
  is deliberately fire-and-forget (`void`); tests await the work via `flush()`.
- **`rename` fires with `(newPath, oldPath)`** — the registry follows the file id
  from the old path to the new one. `emitRename(to, from)`.
- **`delete` fires for a tracked file** and tombstones it in the registry.
- **`list()` can under-report during a cold start.** `ObsidianVaultFiles.list()`
  wraps `app.vault.getFiles()`, which is **empty/partial until the workspace layout
  is ready** — it is not reliable inside `onload`. So a caller must never treat "not
  in `list()`" as "deleted" without confirming the index is ready (`main.ts` defers
  the first `captureOfflineChanges` to `onLayoutReady`, and the scan itself skips its
  delete pass when the listing is empty while active entries remain). Reproduce the
  race with `FakeVaultFiles.setListingReady(false)` — `list()` reports empty while
  `read`/`exists` still work.
- **Persistence survives a restart.** `FakeVaultFiles` (vault bytes) and
  `FakeMetadataStore` (`.opsblobs/*` JSON: registry, oplog, cursor, HLC,
  sync-state) hold the durable state; in-memory device state does not.
  `TestDevice.reload()` rebuilds the stack over the same two fakes to model a
  plugin restart / crash-recovery.
- **`MetadataStore.write` is atomic** — a reader never observes a torn/partial
  file, even if the process is killed mid-write. `FakeMetadataStore` satisfies
  this for free (a synchronous `Map.set`); `ObsidianMetadataStore` achieves it by
  staging to a `${path}.tmp` sibling and renaming over the target, with `read`
  falling back to the temp for the kill-window between remove and rename. Stores
  that load a corrupt file as a safe default (empty DAG, cursor 0) rely on this so
  the "corrupt" branch is reserved for genuine bugs, not routine interrupted writes.
- **`MetadataStore.list()` returns only files *directly* under the dir.**
  `ObsidianMetadataStore.list()` returns `adapter.list(p).files` and **discards
  `.folders`**, so it does not recurse. Code that stores under subdirectories (the
  sharded content store, `content/<hash[0:2]>/<hash>.bin`) must not call
  `list(parentDir)` expecting to find them — `ContentStore.listHashes` instead
  sweeps the 256 known shard prefixes and lists each. `FakeMetadataStore` defaults
  to a permissive recursive prefix match; flip `listMode = 'one-level'` to pin
  behavior against the real device semantics (see `content-store-gc.test.ts`).
- **`VaultFiles.move` must create the destination's parent folder** — the same
  guarantee `write` gives. **Folders are not synced entities:** the op log carries
  file moves only, so a peer that reorganized its vault into a *new* folder
  replicates `move`s into a directory this device has never created. Obsidian's
  `fileManager.renameFile` does **not** mkdir — it rejects with "The parent object of
  the destination does not exist" — so `ObsidianVaultFiles.move` `ensureDir`s the
  destination first, mirroring `write`. `FakeVaultFiles`' flat map has no folders, so
  **the fake cannot catch a regression here** (it is a manual-smoke/device concern,
  like the `mkdir` item below). What the fake *does* pin is the engine's tolerance of
  the failure: `failNextOn(path, message)` arms a one-shot throw on `move`/`write`/
  `trash` so `apply-action-failure-isolation.test.ts` can assert that one throwing
  action defers only its own file instead of aborting the round. This asymmetry —
  one method ensuring a precondition its siblings don't — is worth re-checking
  whenever the port grows a method.
- **`MetadataStore.write` does not auto-mkdir parents.** A caller writing into a
  not-yet-created subdirectory must `mkdir` it first (`ContentStore.put` ensures the
  shard dir once per shard per session). The fake's `mkdir` is a no-op (dirs are
  implicit in the flat map), so this is a device-only requirement not exercised by
  the fake — a manual-smoke/integration concern.

Full DOM/vault mocking of the real adapters is out of scope; the Go-server
integration contract (`__tests__/integration/`) guards the wire, and real-adapter
faithfulness is a manual smoke item.
