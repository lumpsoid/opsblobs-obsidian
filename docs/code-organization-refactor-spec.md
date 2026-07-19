# Code-organization refactor — spec

> Derived from an audit against the **Business Logic Placement** architectural
> contract (domain → application/use-cases → infrastructure → bridge/UI;
> functional-core / imperative-shell). The audit found decision logic that
> leaked into shells, named configuration orphaned from the rule it names, dead
> code, and a few representability gaps.
>
> This document is the work order. Each fix is self-contained, committed
> separately, and must leave `npm run build` (tsc typecheck) and `npm test`
> green before commit. Commits must **not** carry a `Co-Authored-By` trailer
> (standing user preference).

## Ground rules for every fix

- Read this spec section for the fix, then the referenced files, before editing.
- Keep changes scoped to the fix. Do not opportunistically refactor unrelated code.
- A business **decision** (anything the product could change its mind about:
  what to exclude, when to advance an ancestor, how to resolve a strategy) lives
  in the **domain** and is testable with plain values — no `App`, no mocks.
  **Plumbing** (I/O, sequencing, DTO mapping) stays in shells.
- Run `npm run build && npm test`. Only commit if both pass.
- Commit message format: `refactor(<area>): <summary>` (or `fix(...)` where a real
  behavioural bug is corrected). One commit per fix. No co-author trailer.

---

## Fix 01 — One home for conflict-resolution; delete dead code

**Finding (audit #4).** The rule "given a resolved `ConflictChunk`, produce the
replacement lines" exists in two places:

- `src/merge/diff3.ts` — `getResolutionLines` (private) + `applyConflictResolutions`
  (exported). **Confirmed dead**: `applyConflictResolutions` has zero callers
  anywhere in `src/` or `__tests__/`.
- `src/ui/conflict-modal.ts` — `getResolutionLines` (private, lines 166-174) +
  `buildResolvedContent` (152-164), a hand-rolled reimplementation of the same
  splice-in-reverse logic.

Same rule, two homes, and the "canonical" one is unused. Violates §3 ("a rule
has exactly one home").

**Why it matters.** A future change to how `'both'`/`'custom'` resolve would have
to be made in two places or silently diverge.

**What to do.**
1. In `diff3.ts`: delete the dead `applyConflictResolutions`. Keep a single
   exported pure helper for the per-chunk mapping, e.g.
   `export function resolveConflictChunkLines(chunk: ConflictChunk): string[]`
   (the current `getResolutionLines` body).
2. In `conflict-modal.ts`: delete the private `getResolutionLines`; have
   `buildResolvedContent` call the imported `resolveConflictChunkLines`.

**Acceptance.** No behaviour change. `applyConflictResolutions` gone. Exactly one
copy of the resolution mapping. Build + tests green.

---

## Fix 02 — Exclusion policy (wire the settings that are currently dead)

**Finding (audit #1).** The "what to sync" rule is hardcoded and duplicated, and
the settings that name it do nothing.

- `isExcluded(path) => path.startsWith('.vault-sync/')` is duplicated verbatim in
  `src/core/file-registry.ts:240` and `src/core/operation-logger.ts:364`
  (called 7×).
- `SyncSettings.excludedPatterns` (glob list; default excludes
  `.obsidian/workspace.json`, `.obsidian/cache`, `.vault-sync/**`) and
  `SyncSettings.syncObsidianConfig` are edited in the settings UI and persisted,
  but **never read by any sync/exclusion code** (confirmed by grep — only
  `types.ts` and `settings-tab.ts` reference them).

**Why it matters.** This is both a §3/§4.6 placement failure (the rule has no
single home and a one-line change can't be localized) *and a real bug*: a user
who adds an exclusion pattern sees no effect. The setting is a false promise.

**What to do.**
1. New domain module `src/core/exclusion-policy.ts` — a pure, framework-free
   function (no `App`, no `obsidian` import):
   ```ts
   export function isExcluded(path: string, settings: Pick<SyncSettings,
     'excludedPatterns' | 'syncObsidianConfig'>): boolean
   ```
   - Always exclude the plugin's own metadata dir `.vault-sync/` (invariant, not
     user-configurable).
   - Exclude `.obsidian/` unless `syncObsidianConfig` is true — **but** always
     exclude the workspace-layout files (`.obsidian/workspace.json`,
     `.obsidian/workspace-mobile.json`) as the settings copy promises.
   - Honor `excludedPatterns` as glob patterns. Implement a small,
     dependency-free glob matcher supporting `*`, `**`, and `?` (translate to a
     `RegExp`; anchor full-path). Keep it minimal and unit-tested.
2. Inject the policy into `FileRegistry` and `OperationLogger`. They currently
   don't hold `SyncSettings`; pass the relevant slice (or a
   `() => SyncSettings` getter, so live edits take effect) via the constructor.
   Update the wiring in `main.ts` (`new FileRegistry(...)`, `new OperationLogger(...)`).
   Replace both private `isExcluded` methods with calls to the policy.
3. Add `__tests__` unit coverage for `exclusion-policy.ts` (plain values):
   `.vault-sync/` always excluded; `.obsidian/foo.css` excluded when
   `syncObsidianConfig` false, included when true; `.obsidian/workspace.json`
   excluded either way; a user glob like `attachments/**` excludes nested paths;
   an unrelated note is not excluded.

**Note on `getFiles()`.** Obsidian's `vault.getFiles()` may or may not surface
`.obsidian/` files depending on the vault; the policy must be correct regardless,
since it's the single authority consulted by every code path.

**Acceptance.** No duplicated `isExcluded`. `excludedPatterns` and
`syncObsidianConfig` demonstrably affect what is captured. Policy unit-tested.
Build + full suite green.

---

## Fix 03 — Move the ancestor-advance decision into the domain

**Finding (audit #2).** `src/network/sync-applicator.ts:209 updateAncestorHashes`
contains the most correctness-critical CRDT invariant in the codebase (the
subject of the recent data-loss fixes) as a business `if` inside an effect
runner:

```ts
const isFirstSync = entry.ancestorContentHash === null;
if (action.type === 'no_op' || isFirstSync) { await this.registry.setAncestorHash(...) }
```

The rule: `write_local` always advances to the written hash; `no_op` always
advances (both sides already hold it); `send_remote` advances **only** on first
sync (null ancestor) and never otherwise (pushing our own edit is not a peer
acknowledgement — advancing there is the data-loss bug). Everything else: no
advance.

**Why it matters.** §1 forbids a business decision in a shell/effect-runner. §4.5
requires the rule be testable with plain values, no mocks — right now testing it
needs an `App` and a real registry.

**What to do.**
1. Add a pure domain function (in `src/merge/` or a new
   `src/merge/ancestor-policy.ts`) that, given a `MergeAction` and the local
   `FileEntry` (or the fields it needs), returns the ancestor hash to set, or
   `null` for "leave unchanged":
   ```ts
   export function nextAncestorHash(action: MergeAction, localEntry: FileEntry | undefined): string | null
   ```
   Encode all four cases (write_local → its content hash; no_op → entry hash if
   live; send_remote → entry hash only when `ancestorContentHash === null`;
   otherwise null). Preserve the current `!entry.deleted` guard.
2. `updateAncestorHashes` becomes plumbing: iterate actions, call
   `nextAncestorHash`, and `setAncestorHash` when non-null. No business `if`
   left in the applicator. Note `write_local` currently re-hashes
   `action.content`; `nextAncestorHash` can return that hash (the action already
   carries the content — hash it in the shell and pass in, or return a marker;
   keep the hashing in the shell since it's async I/O-adjacent). Simplest:
   the domain fn handles no_op/send_remote (hash already known from the entry);
   the shell keeps the `write_local` branch that must hash bytes. Prefer whichever
   keeps the *decision* (the `isFirstSync` / action-type branching) in the domain.
3. Port the existing behavioural expectations into a plain-values unit test for
   `nextAncestorHash` covering the send_remote-first-sync-only rule (the
   regression that caused data loss).

**Acceptance.** The `isFirstSync` decision no longer lives in the applicator.
New pure test locks the send_remote rule. Existing convergence/data-loss tests
(`__tests__/concurrent-conflict-dataloss.test.ts`,
`resolution-convergence.test.ts`) still pass.

---

## Fix 04 — Delete-conflict strategy policy

**Finding (audit #5).** `src/main.ts:79-87` maps the configured strategy to an
action inline in a closure:

```ts
if (strategy === 'keep_deleted') return 'keep_deleted';
if (strategy === 'keep_modified') return 'restore';
// 'ask' → open modal
```

A settings-enum → action decision (§2.3 policy) living in the composition shell.

**What to do.**
- Add a domain fn, e.g. in `src/merge/` or a small `src/core/conflict-policy.ts`:
  `resolveDeleteStrategy(strategy: SyncSettings['deleteConflictStrategy']): 'keep_deleted' | 'restore' | 'ask'`.
- The `main.ts` handler calls it; only the `'ask'` → modal plumbing stays in the
  closure.
- Unit-test the three mappings with plain values.

**Acceptance.** No strategy `if`-ladder in `main.ts`. Policy unit-tested. Green.

---

## Fix 05 — Move the GC keep-set computation into the registry

**Finding (audit #6).** `src/main.ts:297-307 clearContentCache` reaches into every
registry entry and decides what content is "still referenced":

```ts
if (!entry.deleted && entry.contentHash) keep.add(entry.contentHash);
if (entry.ancestorContentHash) keep.add(entry.ancestorContentHash);
```

That is a domain query about the registry, computed in the plugin shell
(§1 tell-don't-ask).

**What to do.**
- Add `FileRegistry.referencedHashes(): Set<string>` returning the live +
  ancestor hashes still referenced.
- `clearContentCache` calls it and passes the set to `contentStore.gc(...)`; the
  before/after counting stays in the shell (that's plumbing).
- Unit-test `referencedHashes` against an in-memory registry state.

**Acceptance.** No keep-set business logic in `main.ts`. Green.

---

## Fix 06 — Wire `ancestorRetentionDays` into GC (currently a dead setting)

**Finding (audit #3).** `SyncSettings.ancestorRetentionDays` (default 30) is
configured and persisted but never consulted. `ContentStore.gc` and
`clearContentCache` keep purely by registry reference. A named retention window
with no implementation.

**Decision for this fix: implement it** (the setting promises a feature; removing
a user-facing control is worse than honoring it).

**What to do.**
1. `ContentStore.gc` currently deletes every hash not in `keepHashes`. Change the
   contract so unreferenced blobs are retained until they exceed the retention
   window, using the content file's modified time via
   `app.vault.adapter.stat(path)` (`.mtime`, ms):
   ```ts
   async gc(keepHashes: Set<string>, retentionMs: number, now: number): Promise<void>
   ```
   Keep a hash if it's in `keepHashes` **or** `now - mtime < retentionMs`.
   Pass `now` in (do not call `Date.now()` inside the store — keep it injectable
   for tests). Referenced content is always kept regardless of age.
2. Update the two call sites (`clearContentCache`, and the `ContentStore.gc`
   usage in any sync GC path if present) to pass
   `settings.ancestorRetentionDays * 86_400_000` and `Date.now()`.
3. Unit-test: a referenced hash is always kept; an unreferenced hash newer than
   the window is kept; an unreferenced hash older than the window is deleted.
   (Use the memory-host fake under `__tests__/helpers/` — extend it with `stat`
   if needed.)

**Acceptance.** `ancestorRetentionDays` observably changes GC behaviour.
Referenced content never deleted. Green.

---

## Fix 07 — Relocate misplaced code out of `main.ts`

**Finding (audit #7).** `main.ts` (441 lines) mixes lifecycle with components
that belong elsewhere. AGENTS.md itself asks to keep `main.ts` lifecycle-only and
split files at ~200-300 lines.

**What to do (pure moves, no logic change).**
1. Move `DeleteConflictModal` (main.ts:392-441) to a new
   `src/ui/delete-conflict-modal.ts`; export it; import into `main.ts`.
2. Move `saltForVault` (main.ts:383-386) to `src/network/encryption.ts` as an
   exported helper (it's crypto, and colocated with the KDF it feeds); import
   into `main.ts`. (Alternatively make it a `VaultCrypto` static/method — but a
   free exported fn matches its current shape; keep it simple.)

**Acceptance.** `main.ts` no longer defines a modal or a crypto helper. No
behaviour change. Build + tests green.

---

## Fix 08 — Make `ConflictChunk` resolution unrepresentable-when-invalid

**Finding (audit #8).** `ConflictChunk.resolution?: 'local'|'remote'|'both'|'custom'`
plus `customText?: string[]` is a sync-by-discipline cluster: `'custom'` is only
valid *with* `customText`, but the type permits `'custom'` alone, forcing the
`chunk.customText ?? chunk.local` fallback — a §3 "design error" tell.

**What to do.**
- Separate the *raw* conflict from its *resolution*. Keep `ConflictChunk` as the
  raw hunk (`startLine, endLine, ancestor, local, remote`) with no `resolution`/
  `customText`. Represent a resolution as a discriminated union, e.g.:
  ```ts
  export type ConflictResolution =
    | { kind: 'local' } | { kind: 'remote' } | { kind: 'both' }
    | { kind: 'custom'; text: string[] };
  ```
- Update `resolveConflictChunkLines` (from Fix 01) to take `(chunk, resolution)`
  and switch on `resolution.kind` — `'custom'` now *carries* its text, so no
  fallback needed.
- Update `conflict-modal.ts` to track `Map<number, ConflictResolution>` and the
  badge/label rendering accordingly. Default remains "local".
- Update `state-merge.ts` where it builds `conflicts` (it sets no resolution
  today — just drop the fields it never populated) and `types.ts`.

**Why last-ish.** It touches `types.ts`, `diff3.ts`, `state-merge.ts`, and the
modal; doing it after Fix 01 means only one live consumer (the modal) remains.

**Acceptance.** No optional `resolution`/`customText` pair; `'custom'` cannot
exist without its text. Modal behaviour unchanged. Green.

---

## Fix 09 — Primitive hygiene (dedupe + validate)

**Findings (audit #9, #10).** Small, safe cleanups:

1. **base64 helpers duplicated**: `content-store.ts:116` (`uint8ToBase64`/
   `base64ToUint8`) vs `encryption.ts:167` (`bytesToBase64`/`base64ToBytes`) —
   identical byte↔base64 logic. Extract to one util (e.g.
   `src/core/encoding.ts`) and re-export/import from both. Keep public names
   stable where they're imported by tests.
2. **UUID-with-fallback duplicated**: `file-registry.ts:244 generateUUID` vs
   `main.ts:159 generateDeviceId` — same `crypto.randomUUID()`-with-fallback.
   Extract `randomUuid()` to the shared util; both call it.
3. **`isBinary` magic number**: `state-merge.ts:253` inlines `8192`. Extract a
   named `const BINARY_SNIFF_BYTES = 8192`.
4. **`hlcFromString` doesn't validate numerics** (`hlc.ts:96`): it checks
   `parts.length >= 3` but `parseInt` on a non-numeric part yields `NaN`
   silently. Throw `Invalid HLC string` if `wallTime`/`counter` are not finite
   integers.

**Acceptance.** One home for base64 and uuid; named sniff constant; malformed HLC
strings throw instead of producing `NaN` fields. Green.

---

## Sequencing

Fixes are ordered to minimize churn/conflicts and to land the safe, high-value
ones first:

1. Fix 01 — dead code + one home (pure, low risk)
2. Fix 02 — exclusion policy (real bug)
3. Fix 03 — ancestor-advance domain fn (correctness-critical)
4. Fix 04 — delete-strategy policy
5. Fix 05 — GC keep-set to registry
6. Fix 06 — retention days wired
7. Fix 07 — relocate misplaced code
8. Fix 08 — ConflictChunk union (depends on 01)
9. Fix 09 — primitive hygiene

Each fix ends with `npm run build && npm test` green and a single commit
(no `Co-Authored-By` trailer).
