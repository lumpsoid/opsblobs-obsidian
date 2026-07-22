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
  `FakeMetadataStore` (`.vault-sync/*` JSON: registry, oplog, cursor, HLC,
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

Full DOM/vault mocking of the real adapters is out of scope; the Go-server
integration contract (`__tests__/integration/`) guards the wire, and real-adapter
faithfulness is a manual smoke item.
