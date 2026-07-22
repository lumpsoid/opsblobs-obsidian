# Vault Sync — Pre-Release UX Audit & Remediation Spec

**Status:** Draft / audit-of-record · **Date:** 2026-07-23 · **Owner:** UX + client

This is a **point-in-time audit** of every user-facing surface of the plugin, plus a
prioritized remediation plan to make setup and daily use *clear and comfortable* before
release. It is a plan, not a landed change; check items off as they ship. The companion
engineering doc for behavior is `docs/sync-engineering-guide.md`; the pre-release
*performance* work lives in `docs/mobile-perf-baseline-spec.md`.

**Prime lens:** mobile is a declared target (`manifest.json` `isDesktopOnly: false`), yet
the UI today has **zero mobile adaptation**. Every finding is weighed for how it lands on a
phone, not just desktop.

## How to read this

Findings are tiered by release impact:

- **P0 — release-blocking.** A first-run user can get wedged, confused, or shown something
  wrong/misleading. Must ship before a public release.
- **P1 — strongly recommended.** Real friction or leaked internals; not wedging but
  materially uncomfortable.
- **P2 — polish.** Consistency and refinement; can trail the first release.

Every finding cites `file:line` so the fix is unambiguous. Severity is about *user impact*,
not effort.

---

## 0. The full UX surface (so nothing is audited that users never see)

| File | Component | Live? |
|---|---|---|
| `src/ui/settings-tab.ts` | `SyncSettingTab` — the only config surface | yes |
| `src/ui/sync-status-modal.ts` | `SyncStatusModal` — inspectable status | yes |
| `src/ui/conflicts-view.ts` | `ConflictsView` — non-blocking text-conflict side panel | yes |
| `src/ui/delete-conflict-modal.ts` | `DeleteConflictModal` — delete/modify decision (manual sync only) | yes |
| `src/ui/binary-conflict-modal.ts` | `BinaryConflictModal` — binary decision (manual sync only) | yes |
| `src/ui/confirm-modal.ts` | `ConfirmModal` — generic yes/no | yes |
| `src/ui/conflict-modal.ts` | `ConflictResolutionModal` | **DEAD — imported nowhere** |

Other UX-bearing code: `src/main.ts` (ribbon, status bar, commands, Notices),
`src/network/sync-coordinator.ts` (toasts), `src/network/obsidian-notifier.ts` (Notice
adapter), `src/network/sync-errors.ts` (error copy), `src/core/operation-logger.ts:349`
(marker notice), `src/merge/diff3.ts:425-437` (inline marker labels written into notes),
`styles.css`.

**P1 — dead code with a divergent design.** `src/ui/conflict-modal.ts`
(`ConflictResolutionModal`, ~176 lines: modal 3-way merge, "Accept All Local/Remote/Both",
red/blue panes, "Skip for now") is imported nowhere (`grep` confirms) — superseded by
`conflicts-view.ts` but left in the tree with a *different* terminology ("Local/Remote") and
color system (red/blue vs the live panel's green/blue). **Remediation:** delete it, or if any
part is intended for reuse, reconcile its vocabulary/colors with the live panel first.
Leaving it invites a future contributor to "fix" a UI users never see.

---

## 1. Onboarding & first-run  — **P0**

**The problem:** there is no guided setup. The entire flow is a flat settings page the user
must discover under Settings → Vault Sync (`main.ts:onload` adds only a ribbon, status bar,
three commands, and the tab — nothing prompts or opens settings on first install).

Findings:

1. **P0 — required order is implicit and undiscoverable.** Success requires, in order:
   Server URL (`settings-tab.ts:71`), Vault ID (`:83`), Access token (`:95`), Vault
   passphrase (`:135`), then Test connection (`:108`), then Sync. Nothing states this order,
   states that all four are mandatory, or visually separates the 4 required fields from the
   ~10 optional/advanced ones below them.
   **Fix:** a first-run **Setup** section at the top that (a) groups the 4 required fields,
   (b) shows a live readiness checklist ("Server URL ✓ · Vault ID ✓ · Token ✗ · Passphrase
   ✗"), and (c) gates/hides advanced settings behind an "Advanced" disclosure until the
   basics are set. Optionally open the settings tab automatically on first install when
   unconfigured.

2. **P0 — the "configure first" toast names the wrong fields.** Ribbon/sync-before-config →
   `main.ts:390` (and duplicate at `:499`): *"configure a server and passphrase in Settings →
   Vault Sync first."* But `isServerConfigured()` (`main.ts:294`) also requires `vaultId` and
   the code path also needs a token. A user with URL+passphrase but no Vault ID gets a
   message that doesn't name the missing field.
   **Fix:** compute which fields are missing and name them; route the toast to open the
   settings tab (a Notice with an action, or open-settings on click).

3. **P0 — the second-device / join flow is explained nowhere in the UI.** The only hints are
   buried helper text (`:85`, `:129-131`, `fingerprintDesc()` `:334`). Nothing tells a user
   that device 2 needs the *same* Vault ID + passphrase + a token, where the token comes
   from, or that the fingerprint is the cross-device check. This is the single most common
   real-world task (sync a second device) and it has no first-class explanation.
   **Fix:** a short "Add another device" help block (collapsible) in the Server section
   stating exactly the three values to copy and how the fingerprint confirms a match.

4. **P1 — fingerprint verification assumes the user already knows to compare it.**
   `Key fingerprint` (`settings-tab.ts:148`) shows a raw string + "must match on every
   device" but offers no copy button, no side-by-side compare affordance, and no one-line
   explanation of *why* (it catches a mistyped passphrase before data is trusted — see
   `KeyMismatchError`).
   **Fix:** add a copy button and a one-line "why" ("If this differs across devices, the
   passphrases don't match and sync will refuse to mix them.").

5. **P1 — dead-end failure copy.** `main.ts:397` *"could not derive the vault key from the
   passphrase."* — jargon ("derive the vault key") and no next step.
   **Fix:** *"Couldn't unlock the vault with this passphrase — check it in settings."*

6. **P2 — "Test connection" is the right tool but undiscovered on first run.** The success
   strings (`main.ts:376-377`) are genuinely good (including the empty-vault case), but a
   first-run user has no reason to press it before syncing.
   **Fix:** surface it as part of the readiness checklist (finding 1) — e.g. once all four
   fields are set, the checklist shows a single "Test connection" CTA before "Sync now".

---

## 2. Terminology & copy — one vocabulary for one concept — **P1**

The engine's internal vocabulary leaks to users, and the *same* concept has multiple names
across surfaces. Pick one term per concept and use it everywhere (code comments may keep the
precise term; **user-facing strings** must not).

| Concept | Names in the wild today | Recommended single user term |
|---|---|---|
| the two conflicting sides | "Mine"/"Theirs" (`conflicts-view.ts:120,197`), "ours"/"theirs" (inline markers, `diff3.ts:430,436`), "Local"/"Remote" (dead modal) | **"This device"** / **"Other device"** (or "Mine"/"Theirs" — but ONE, incl. the inline markers) |
| the common ancestor | "Base" (`conflicts-view.ts:199`), "ancestor" (`settings-tab.ts:261` "Ancestor retention", `diff3.ts` `chunk.ancestor`) | **"Common version"** everywhere users see it |
| deriving the key | "derive"/"derived" (`main.ts:397`, `sync-status-modal.ts:120`, `settings-tab.ts:152,335`) | **"unlock"** / "ready" |
| a sync cycle | "pull → merge → push round" (`settings-tab.ts:174`), "round" | **"sync"** (don't expose the pipeline) |
| an op | "recording an operation" (`settings-tab.ts:202`), "pending operations" (`:302`) | **"change"** / "pending changes" |
| held/blocked items | "deferred", "stranded", "drift" bleeding into status framing | plain outcome language ("waiting", "held", "couldn't download yet") |

Additional copy findings:

- **P1 — raw VCS markers land in users' notes.** `diff3.ts:430-436` writes
  `<<<<<<< ours`, `||||||| base`, `======= `, `>>>>>>> theirs` into the file on disk. A
  non-technical user opening the note sees raw git markers. Keep the mechanism (it's how
  in-context resolution works) but (a) label them in the chosen vocabulary and (b) make sure
  the toast + panel teach what they are. Consider a friendlier marker header line.
- **P2 — product casing:** "Vault Sync" (product) vs "Vault sync status"
  (`sync-status-modal.ts:37`) vs "Vault sync complete" (`sync-coordinator.ts:137`). Normalize
  to "Vault Sync".
- **P2 — delete-strategy triple naming:** UI "Always keep the modified version" → setting
  value `keep_modified` (`types.ts`) → policy result `restore` (`conflict-policy.ts:21`).
  Internal names are fine; ensure the *UI label* is the only thing users see (it is) — but
  align the setting value name to reduce contributor confusion (P2, code-hygiene).
- **P2 — "Bearer token" jargon** (`settings-tab.ts:96`). Call it "Access token" (the label
  already does) and drop "Bearer" from the description.

---

## 3. Conflict resolution UX — **P0/P1**

There are **three distinct conflict experiences with no unifying model** presented to the
user, and blocking-vs-nonblocking is inconsistent.

1. **Text conflicts** — non-blocking: markers written into the note + the `ConflictsView`
   side panel (per-hunk 3-way, "Mine/Base/Theirs" panes `:197-199`, buttons `:207-209`).
2. **Delete/modify** — blocking `DeleteConflictModal`, **manual sync only**; an auto sync
   defers it silently to the status modal.
3. **Binary** — blocking `BinaryConflictModal`, **manual sync only**; same silent-defer.

Findings:

- **P0 — conflicts are hard to discover.** The text-conflict panel only opens if the user
  clicks the status bar *while conflicts exist*, runs the "Open conflicts panel" command, or
  clicks the ribbon (which **syncs**, not opens). Nothing auto-reveals it after a sync that
  produced conflicts. On mobile the status bar may be absent, leaving only the command
  palette.
  **Fix:** after a round that leaves conflicts, surface a persistent, actionable entry point
  (a Notice with an "Open conflicts" action and/or auto-open the panel on the first
  conflicting round).
- **P1 — blocking vs waiting is inconsistent and unexplained.** Text waits (panel); delete/
  binary block (modal) but only on manual sync, and are silently deferred on auto sync.
  A user who only auto-syncs may never see a delete/binary decision unless they open the
  status modal. **Fix:** unify the mental model — all conflicts appear in one "Needs your
  attention" list (the status modal already has this heading) with a consistent CTA; the
  blocking modals become one *entry* in that list rather than the only way to resolve.
- **P1 — the "Base"/"Common version" pane is unexplained** (`conflicts-view.ts:199`, non-
  clickable). A novice won't know it's read-only context. **Fix:** label + one-line gloss;
  visually de-emphasize it as reference.
- **P1 — no preview of the resolved result** before "Apply resolution", and "Keep both"/
  "Both" doesn't say which side lands first. **Fix:** show a merged preview; state ordering.
- **P1 — silent default on modal dismiss.** Closing `DeleteConflictModal` (Esc/click-away)
  resolves to `'restore'` (`:54-56`); `BinaryConflictModal` to `'keep_local'` (`:66-67`) —
  a destructive-ish default the user may not realize was chosen. **Fix:** treat dismiss as
  "decide later" (defer), not a silent pick; only an explicit button commits.
- **P2 — binary modal shows only text metadata** (size, `device 3f9a2b` raw UUID `:53`,
  timestamp) — no image thumbnail. **Fix:** thumbnail for image types; replace the raw UUID
  with the device *name*.

---

## 4. Settings information architecture — **P1**

Every setting sits in one flat list, mixing four mandatory basics, several everyday options,
and four expert/maintenance actions. Findings:

- **P1 — expert controls interleaved with basics:** **Debounce delay** (`:200`, milliseconds,
  "recording an operation") and **Ancestor retention** (`:260`, "ancestor content", "garbage
  collection") are developer-facing and sit in the main list. **Fix:** move under an
  "Advanced" disclosure; restate consequences in plain terms.
- **P1 — the most dangerous action is visually equal to the safest.** **Re-baseline this
  device to the server** (`:314`) can overwrite other devices' concurrent edits, yet is
  styled identically to **Clear sync cache** (`:273`, explicitly "Safe"). Both are `setWarning`
  at the bottom. **Fix:** a distinct "Danger zone" grouping; strongest wording + double-confirm
  for re-baseline (it *does* confirm today via `ConfirmModal`, `main.ts:503-514` — keep, but
  escalate copy).
- **P2 — "Clear sync cache" is styled as a warning but fires unguarded** (`:273`, no
  `ConfirmModal`). Its desc says "Safe", so acceptable; either drop the warning styling or add
  a confirm for consistency.
- **P2 — Device ID read-only raw UUID near the top** (`:61`) adds clutter. **Fix:** move to
  an "About/diagnostics" area or show only on demand.
- **P1 — the critical passphrase field has no confirm/typo guard** (`:135`). A mistype now
  fails *safely* (the key-check guard → `KeyMismatchError`), but the user still hits it only
  at sync time. **Fix:** the fingerprint + Test connection already form the guard; make them
  part of the setup checklist (§1) so a typo is caught at entry, not first sync.

---

## 5. Status, feedback & errors — **P1**

The typed error family (`sync-errors.ts`) is **good** — messages name the knob to check
(`AuthError`→token, `NotFoundError`→URL/vault, `KeyMismatchError`/`DecryptError`→passphrase,
`Network`/`Timeout`→connection). Remaining rough edges are about *how/where* state is shown:

- **P0/P1 — setup-time errors surface as a transient toast.** Every failure toasts
  `❌ Sync failed: {message}` (`sync-coordinator.ts:142`) and then fades; the persistent copy
  lives only in the status modal's "Last error" (`sync-status-modal.ts:108`), which the user
  must know to open. Auth/404/key-mismatch are *setup* problems that need durable, actionable
  presentation. **Fix:** for the setup-class typed errors, show a persistent banner (or route
  the user to the Test-connection result), not just a fading toast.
- **P1 — `{operation}` fragments read technical** ("pushing ops", "pulling") inside otherwise-
  friendly sentences (`ServerError`/`NetworkError`/`TimeoutError`). **Fix:** map to plain
  phrases ("uploading your changes", "downloading changes").
- **P1 — raw internals in the status modal:** stranded content shown as truncated hex
  (`sync-status-modal.ts:104` `contentHash.slice(0,12)+'…'`), device UUID fragment (`:124`),
  "Vault key: ready (fingerprint) / not derived" (`:120`, "derived" jargon), "Last error"
  prints `message` verbatim (`:110`, fine for typed errors, leaks for unexpected ones).
  **Fix:** describe stranded items by *file* not hash; show the device *name*; use "unlocked".
- **P1 — ribbon tooltip over-promises.** error state tooltip = *"error — click for details"*
  (`main.ts:548`) but clicking the ribbon triggers a **sync** (`:209`), not details. **Fix:**
  make the error-state click open the status modal (details), or change the copy.
- **P2 — status-bar click is overloaded and unlabeled** (`main.ts:219`: conflicts→panel, else
  →sync). Nothing signals it's clickable or that behavior changes. **Fix:** consistent action
  + a tooltip.
- **P2 — "✅ Vault sync complete" only on manual sync** (`sync-coordinator.ts:137`) — fine, but
  ensure auto-sync still updates the status bar to "✓ Synced" so silent success is visible.

---

## 6. Mobile adaptation — **P0** (mobile is a declared target)

`manifest.json` `isDesktopOnly: false`, but there is **no mobile adaptation** — `styles.css`
has **zero `@media` queries** (grep confirms). Findings:

- **P0 — 3-column diff in a phone sidebar.** `styles.css:65`
  `.vault-sync-hunk-panes { grid-template-columns: 1fr 1fr 1fr; }` forces Mine/Common/Theirs
  side-by-side at `font-size: 0.78rem` (`:73`) inside the right sidebar (a slide-over drawer on
  mobile, `main.ts:611` `getRightLeaf`). Real diffs are effectively unreadable on a phone.
  **Fix:** stack panes vertically below a width breakpoint; single-column, full-width hunks on
  mobile.
- **P1 — touch targets below ~44px.** Per-hunk "Mine/Theirs/Both" + global "All …" + footer
  buttons at default sizing with `gap: 0.4rem` (`:75`). **Fix:** larger tap targets and
  spacing under the mobile breakpoint.
- **P1 — status-bar-as-primary-entry-point may not exist on mobile.** The conflicts panel's
  main route is the status bar click (`main.ts:218`); mobile status bars are less prominent/
  absent. **Fix:** ensure a Command-palette route always exists (it does — "Open conflicts
  panel") *and* the post-conflict Notice action from §3.
- **P2 — desktop-flavored default** placeholder "My MacBook" (`settings-tab.ts:54`) on a phone
  install. **Fix:** neutral placeholder ("My phone / laptop").

**Mobile must be part of the manual-smoke matrix (§8), not an afterthought.**

---

## 7. Prioritized remediation checklist

**P0 — release-blocking**
- [ ] Onboarding: group the 4 required fields + readiness checklist; separate Advanced (§1.1).
- [ ] Fix "configure first" toasts to name the actual missing field(s) + open settings (§1.2).
- [ ] First-class "Add another device" explanation (Vault ID + passphrase + token) (§1.3).
- [ ] Conflicts discoverable after a round (persistent actionable entry point) (§3).
- [ ] Setup-class errors shown durably, not just a fading toast (§5).
- [ ] Mobile: stack conflict panes vertically below a breakpoint (§6).
- [ ] Delete `conflict-modal.ts` (or reconcile) (§0).

**P1 — strongly recommended**
- [ ] One vocabulary per concept across panel + inline markers + settings (§2).
- [ ] Unify the conflict mental model; dismiss = defer, never a silent pick (§3).
- [ ] "Common version" pane label + gloss; resolved-result preview (§3).
- [ ] Settings IA: Advanced disclosure + a Danger zone for re-baseline (§4).
- [ ] Plain-language `{operation}` phrases; ribbon error-click → details (§5).
- [ ] Mobile touch targets + command-palette route guaranteed (§6).

**P2 — polish**
- [ ] Casing/naming normalization; device *name* instead of UUID everywhere (§2, §3, §5).
- [ ] Binary conflict thumbnail; neutral device-name placeholder (§3, §6).
- [ ] Clear-cache confirm consistency; move Device ID to diagnostics (§4).

---

## 8. Verifying UX (manual-smoke matrix)

UX is not unit-testable; it is verified by a scripted manual pass on **both desktop and a real
mobile device** (Obsidian mobile). Run before release and after any UX change:

1. **Cold onboarding (device 1):** fresh install → does the user know what to fill and in what
   order → Test connection → first sync → success visible.
2. **Join (device 2):** with only Vault ID + passphrase + token → fingerprint matches → pull
   converges. Repeat with a **wrong passphrase** → expect the clean `KeyMismatchError`
   presentation, not a wedge.
3. **Each error class:** wrong token (`AuthError`), wrong URL/vault (`NotFoundError`), offline
   (`NetworkError`), server down (`ServerError`) — confirm each message is durable + actionable.
4. **Text conflict:** two devices edit the same file → markers land → panel opens/discoverable
   → resolve via panel and via hand-editing markers → converge. On mobile: panes readable and
   tappable.
5. **Delete/modify and binary conflict:** manual and auto sync; confirm dismiss defers (no
   silent pick) and both appear in "Needs your attention".
6. **Maintenance actions:** reset, re-baseline (double-confirm), clear cache — copy matches
   effect; no accidental data loss path.

## 9. Out of scope
Server-side/token issuance UX (spec §9.2), theming beyond light/dark, localization/i18n, and
any behavioral change to the merge/sync engine (this spec is presentation only — behavior is
governed by `sync-engineering-guide.md`).
