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
- **Persistence survives a restart.** `FakeVaultFiles` (vault bytes) and
  `FakeMetadataStore` (`.vault-sync/*` JSON: registry, oplog, cursor, HLC,
  sync-state) hold the durable state; in-memory device state does not.
  `TestDevice.reload()` rebuilds the stack over the same two fakes to model a
  plugin restart / crash-recovery.

Full DOM/vault mocking of the real adapters is out of scope; the Go-server
integration contract (`__tests__/integration/`) guards the wire, and real-adapter
faithfulness is a manual smoke item.
