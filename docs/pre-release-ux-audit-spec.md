# Vault Sync — Pre-Release UX Audit & Remediation Spec

**Status:** audit-of-record · **Date:** 2026-07-23 · **Owner:** UX + client ·
**Progress: all P0 + all P1 landed, plus most P2 polish (de-emoji sweep, Device ID → Diagnostics,
delete-strategy vocabulary). Only two P2 items remain — a friendlier marker header line and a
binary-conflict thumbnail — plus the §8 manual-smoke pass.**

This is a **point-in-time audit** of every user-facing surface of the plugin, plus a
prioritized remediation plan to make setup and daily use *clear and comfortable* before
release. Findings are checked off as they ship; the **Decisions of record** (below) capture the
*why* behind the shipped code. The companion engineering doc for behavior is
`docs/sync-engineering-guide.md`; the pre-release *performance* work lives in
`docs/mobile-perf-baseline-spec.md`.

**Prime lens:** mobile is a declared target (`manifest.json` `isDesktopOnly: false`). The UI
started with **zero mobile adaptation**; the conflict panel now has a mobile breakpoint (stacked
panes, 44px touch targets) and moved to a main-area tab, but every finding is still weighed for
how it lands on a phone, not just desktop.

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

## Decisions of record

Choices made while remediating (so the *why* behind the shipped code isn't lost). Each links
to the finding it resolves.

**2026-07-23 — P0 remediation pass** (all seven P0 items landed; see §7 checklist):

1. **Onboarding layout (§1.1).** Reorganize into a **Setup** section (4 required fields under a
   live readiness checklist), everyday **Sync** controls, then two `<details>` disclosures:
   **Advanced** (debounce, sync .obsidian, ancestor retention, exclusions) and **Maintenance &
   danger zone** (clear cache, re-check, reset, re-baseline). No setting was removed.
   **Rejected:** auto-opening the settings tab on first install — kept install non-intrusive.
2. **Access token is a required field (§1.2).** `missingConfigFields()` is the single source of
   truth for "what's left to configure" and **includes the token**, so a missing token is named
   up front instead of surfacing as a mid-sync `AuthError`. The finish-setup notice names the
   actual missing fields and links to settings.
3. **Conflicts view is a main-area tab, not a sidebar (§3, §6).** `activateConflictsView` uses
   `workspace.getLeaf('tab')` — a first-class view that reads far better on mobile than a
   slide-over drawer. **Reveal behavior:** a *manual* sync that newly introduces text conflicts
   opens the tab; an *auto* (unattended) sync raises a persistent, actionable notice instead of
   stealing focus. "Newly introduced" is measured off the two-headed (text) conflict count, so a
   periodic auto-sync doesn't nag every round while the same conflicts sit unresolved.
4. **No emojis in user-facing UI — use color (§5, cross-cutting).** Notices convey status by
   **color** (theme vars, e.g. `--text-error`), not glyphs. Applied to the new setup-error
   notice and the sync-complete / sync-failed toasts (the `✅`/`❌` were dropped). *Sweep now
   complete (P2 pass, below):* the status-bar `⚠ ⟳ ✓`, the `⟳` sync-progress prefix, the
   `✓`/`✗` on the Test-connection result, and the `⚠️` on the marker notice are gone — state is
   carried by a color class plus a word label. The one glyph kept is the Setup readiness
   `✓`/`✗` (§1.1): there it is *paired* with green/red color (not color-only), which is the
   accessible pattern, so it stays.
5. **Setup-class errors get a durable, actionable surface (§5).** `isSetupError()` classifies
   auth / 404 / key-mismatch / decrypt as *setup* failures → a persistent (non-fading),
   color-flagged notice with an **Open settings** action, via a new `Notifier.setupError`.
   Transient transport errors (network / timeout / 5xx) keep the fading toast since they
   self-retry. Both still record to the status modal. `openSettings` is injected into the
   coordinator so it stays obsidian-free.

**2026-07-23 — P1 remediation pass** (most P1 items landed; see §7 checklist):

1. **Dismiss = defer, then "full inline" (§3).** First pass made both blocking modals treat a
   dismiss as *defer* (never a silent destructive pick). The follow-up **removed the modals
   entirely** ("full inline", see the dedicated decision below): delete/binary conflicts now defer
   on every round into the Conflicts panel and resolve inline — so a silent-dismiss pick is gone by
   construction.
2. **Conflict legibility (§3).** The ancestor pane is **Original** with a read-only gloss; a live
   **Preview result** shows exactly what Apply writes (same `resolveMarkedText` rule, so it can't
   diverge from what lands); "Both" states its ordering (Mine, then Theirs).
3. **Danger hierarchy (§4).** Re-baseline gets a solid-red danger button + a **type-to-confirm**
   gate (`ConfirmModal.requireTyped`); the safe Clear-cache lost its warning styling.
4. **Feedback (§5).** Transport phrases plain ("downloading changes" / "uploading your changes");
   the error-state ribbon click opens the status modal (matching its tooltip); the status modal shows
   the device *name*, drops the stranded hex, and color-flags attention rows.
5. **Onboarding (§1.4/§1.5).** Fingerprint copy button + a "why it must match" gloss; the dead-end
   unlock-failure copy now names the next step.

**Still open (P2):** an optional friendlier marker *header line* (§2); a binary-conflict
*thumbnail* preview (the binary card now shows size + device + time inline, no raw UUID).

**2026-07-23 — P2 polish pass** (de-emoji sweep + Device ID moved):

1. **De-emoji sweep (§5, no-emoji UI).** The last user-facing glyphs are gone — status bar
   (`⚠ ⟳ ✓` → color class `.vault-sync-sb-{conflict,pending,syncing,synced}` + the existing word
   label), the `⟳` sync-progress prefix, the Test-connection result (`✓`/`✗` → `.vault-sync-test-ok`
   / `.vault-sync-test-err` colour on the description), and the `⚠️` on the "still has conflict
   markers" notice. `setStatusBarText` now takes a `state` and owns the single color class. The
   Setup readiness `✓`/`✗` is deliberately **retained** (glyph + color together = accessible, not
   color-only).
2. **Device ID → Diagnostics (§4).** The read-only raw-UUID Device ID row moved out of the
   top-level "This device" block into a collapsed **Diagnostics** `<details>` disclosure, so the
   basics aren't cluttered by a value with no everyday use. Device *name* stays in "This device".
3. **Delete-strategy value unified (§2, code-hygiene).** The same outcome had two names —
   the config value `keep_modified` and the applicator action `restore` — bridged by an identity-ish
   `resolveDeleteStrategy` map. Unified on `keep_modified` everywhere; the now-vacuous map (and its
   test) were deleted and `main.ts` passes the setting through directly. No user-visible change; no
   migration needed (pre-release, no persisted configs in the wild).

**2026-07-23 — Unified conflicts, "full inline" (§3) — DECIDED & SHIPPED.** The two conflict
experiences are unified into **one surface, the Conflicts panel**. Delete/binary conflicts no longer
open a blocking modal on any round; they **always defer** and are recorded as durable
`ConflictDescriptor`s (`SyncState.conflicts`) that render as inline cards in the panel. Resolving a
card writes a `SyncState.pendingDecisions[fileId]` and triggers a sync; the next round's
`decideDeleteConflict`/`decideBinaryConflict` **consume** the decision (return it) so the applicator
applies it and mints the two-parent merge node — identical convergence to the old modal path, just
non-blocking and discoverable in one place. `pendingDecisions` self-heals to the live conflict set
each round. A standing non-`ask` delete policy still applies unattended. `DeleteConflictModal` /
`BinaryConflictModal` were deleted; the status modal keeps only a pointer to the panel.
**Rejected:** "list in panel but resolve via the existing modal" and "cross-link the two surfaces"
— both keep the split interaction model the finding calls out.

**2026-07-23 — P1 vocabulary decision (§2) — DECIDED & SHIPPED.** The two conflicting sides are
**"Mine" / "Theirs"** everywhere users see them (panel panes, inline note markers, status copy);
the common ancestor is **"Original"** (panel pane label + the `||||||| Original` inline marker).
Marker *parsing* is by sigil prefix, so relabeling `ours`/`base`/`theirs` → `Mine`/`Original`/
`Theirs` is back-compatible — notes written by an older build still parse. The delete/modify and
binary modals stay **outcome-based** ("Keep modified" / "Keep deleted" / "Keep this device's
version"), where "Mine/Theirs" is ambiguous. Key-derivation jargon ("derive"/"derived") becomes
**"unlock"** (verb) / **"ready"/"unlocked"** (state) in user-facing strings; code comments keep the
precise term. Product-name casing normalized to **"Vault Sync"**.

---

## 0. The full UX surface (so nothing is audited that users never see)

| File | Component | Live? |
|---|---|---|
| `src/ui/settings-tab.ts` | `SyncSettingTab` — the only config surface | yes |
| `src/ui/sync-status-modal.ts` | `SyncStatusModal` — inspectable status | yes |
| `src/ui/conflicts-view.ts` | `ConflictsView` — the single non-blocking conflicts panel: text (per-hunk) **and** delete/binary (inline decision) | yes |
| `src/ui/confirm-modal.ts` | `ConfirmModal` — generic yes/no (+ type-to-confirm gate) | yes |

> **Removed (§3 "full inline"):** `src/ui/delete-conflict-modal.ts` and
> `src/ui/binary-conflict-modal.ts` — the blocking delete/binary modals are gone; those
> decisions are now cards in the Conflicts panel, resolved inline.

Other UX-bearing code: `src/main.ts` (ribbon, status bar, commands, Notices),
`src/network/sync-coordinator.ts` (toasts), `src/network/obsidian-notifier.ts` (Notice
adapter), `src/network/sync-errors.ts` (error copy), `src/core/operation-logger.ts:349`
(marker notice), `src/merge/diff3.ts:425-437` (inline marker labels written into notes),
`styles.css`.

**P1 — dead code with a divergent design. ✅ RESOLVED.** `src/ui/conflict-modal.ts`
(`ConflictResolutionModal`, ~176 lines: modal 3-way merge, "Accept All Local/Remote/Both",
red/blue panes, "Skip for now") was imported nowhere — superseded by `conflicts-view.ts` but
left in the tree with a *different* terminology ("Local/Remote") and color system (red/blue vs
the live panel's green/blue). **Removed:** the file was deleted along with its dead CSS block
(`.vault-sync-conflict-modal` and the `.conflict-*`/`.resolution-*`/`.pane-local`/`.pane-remote`
rules in `styles.css`). The live panel's `vault-sync-`-prefixed classes are untouched.

---

## 1. Onboarding & first-run  — **P0**

**The problem:** there is no guided setup. The entire flow is a flat settings page the user
must discover under Settings → Vault Sync (`main.ts:onload` adds only a ribbon, status bar,
three commands, and the tab — nothing prompts or opens settings on first install).

Findings:

1. **P0 — required order is implicit and undiscoverable. ✅ SHIPPED (decision 1).** Success
   requires, in order: Server URL, Vault ID, Access token, Vault passphrase, then Test
   connection, then Sync. Nothing stated this order or separated the required fields from the
   ~10 optional ones.
   **Shipped:** a **Setup** section groups the 4 required fields under a live readiness
   checklist (✓/✗ per field, updating as you type); dev knobs and maintenance actions moved
   under Advanced / Danger-zone disclosures. Auto-open-on-install was considered and **not**
   done (kept install non-intrusive).

2. **P0 — the "configure first" toast names the wrong fields. ✅ SHIPPED (decision 2).** The old
   toast said *"configure a server and passphrase"* regardless of what was actually missing,
   and dead-ended.
   **Shipped:** `missingConfigFields()` computes the concrete missing fields (incl. the access
   token) and the notice names them + carries an "Open Vault Sync settings" link. `testConnection`
   uses the same list.

3. **P0 — the second-device / join flow is explained nowhere in the UI. ✅ SHIPPED.** Nothing told
   a user that device 2 needs the same Vault ID + passphrase + a token, or that the fingerprint
   is the cross-device check.
   **Shipped:** a collapsible **"Add another device"** block in the Setup section names the three
   values to copy and explains that the Key fingerprint must match (and that a mismatch means the
   passphrases differ and sync will refuse to mix them).

4. **P1 — fingerprint verification assumes the user already knows to compare it. ✅ SHIPPED.**
   `Key fingerprint` showed a raw string + "must match on every device" but offered no copy
   button and no *why*.
   **Shipped:** a copy button on the fingerprint row and a one-line gloss — "Compare it across
   devices: it must be identical. If it differs, the passphrases don't match and sync will refuse
   to mix them."

5. **P1 — dead-end failure copy. ✅ SHIPPED.** The old `main.ts` notice said *"could not derive the
   vault key from the passphrase"* — jargon, no next step.
   **Shipped:** *"couldn't unlock the vault with this passphrase — check it in settings."* (and the
   "derive" verb → "unlock" across the fingerprint button/desc and status modal).

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

> **Decided & shipped:** the two sides are **Mine / Theirs** and the ancestor is **Original**
> (not the table's tentative "This device / Other device" / "Common version" — see Decisions of
> record). Applied to the panel, the inline markers, and settings; derive-jargon → unlock/ready.

Additional copy findings:

- **P1 — raw VCS markers land in users' notes. ◑ PARTIAL.** `diff3.ts` now writes
  `<<<<<<< Mine`, `||||||| Original`, `=======`, `>>>>>>> Theirs` — labelled in the chosen
  vocabulary (recognition is by sigil, so older `ours`/`base`/`theirs` notes still parse). The panel
  teaches what each side is. **Still open:** the sigils themselves are still git-flavored; a
  friendlier *header line* above the block was considered and deferred.
- **P2 — product casing:** "Vault Sync" (product) vs "Vault sync status"
  (`sync-status-modal.ts:37`) vs "Vault sync complete" (`sync-coordinator.ts:137`). Normalize
  to "Vault Sync".
- **P2 — delete-strategy triple naming. ✅ DONE.** Was: UI "Always keep the modified version" →
  setting value `keep_modified` (`types.ts`) → policy result `restore` (`conflict-policy.ts`). The
  divergence came from two vocabularies meeting at a translation seam: the **config** enum
  (`keep_modified`/`keep_deleted`, named for the user's standing choice) and the **applicator
  action** enum (`restore`/`keep_deleted`, named for what the applicator does — re-write/undelete
  the file). `keep_deleted` read the same from both ends so it never drifted; only `keep_modified`↔
  `restore` did, and the `restore` word had leaked out of the applicator into the panel button, the
  persisted decision type, and the coordinator handler. **Fixed:** unified on `keep_modified`
  everywhere; the seam collapsed to identity so `resolveDeleteStrategy` (`conflict-policy.ts`) and
  its test were deleted and `main.ts` passes `settings.deleteConflictStrategy` straight through.
- **P2 — "Bearer token" jargon** (`settings-tab.ts:96`). Call it "Access token" (the label
  already does) and drop "Bearer" from the description. **✅ DONE** (dropped in the §1.1 reorg;
  description now "Token authorizing this device for the vault.").

---

## 3. Conflict resolution UX — **P0/P1**

*Audit-time state (retained for context): there were three distinct conflict experiences with no
unifying model, and blocking-vs-nonblocking was inconsistent.* **This is now unified — see the
"full inline" decision of record:** all conflicts live in the one `ConflictsView` panel.

1. **Text conflicts** — non-blocking: markers written into the note + the `ConflictsView`
   panel (per-hunk 3-way, "Mine/Original/Theirs" panes, side buttons + a resolved-result preview).
2. **Delete/modify** — *was* a blocking `DeleteConflictModal` (manual only); **now** an inline card
   in the panel ("Keep modified" / "Keep deleted"), deferred on every round until resolved.
3. **Binary** — *was* a blocking `BinaryConflictModal` (manual only); **now** an inline card in the
   panel (size + device + time per side, "Keep this device" / "Keep other device").

Findings:

- **P0 — conflicts are hard to discover. ✅ SHIPPED (decision 3).** The text-conflict view only
  opened via a status-bar click, the command, or the ribbon (which syncs). Nothing revealed it
  after a round that produced conflicts.
  **Shipped:** a round that *newly* introduces text conflicts now surfaces them — a manual sync
  opens the conflicts view; an unattended auto sync raises a persistent, actionable "Open
  conflicts" notice (no surprise focus change). The rise is keyed off the two-headed count so a
  periodic auto-sync doesn't nag. The view also moved from the right sidebar to a **main-area
  tab** (better on mobile). The command-palette route ("Open conflicts") is retained.
- **P1 — blocking vs waiting is inconsistent and unexplained. ✅ SHIPPED ("full inline").** Text
  waited (panel) while delete/binary blocked (modal, manual only) or silently deferred (auto).
  **Shipped:** delete/binary conflicts **no longer block** — every round defers them to the
  **Conflicts panel** as inline cards (persisted `ConflictDescriptor`s), so text and
  delete/binary now share one surface and one mental model. Resolving a card records a
  `pendingDecision` the next round consumes (the applicator mints the merge node); a standing
  non-`ask` delete policy still applies unattended. The status modal's "Needs your attention"
  section now just lists them with an **Open Conflicts panel** button. The blocking modals were
  deleted.
- **P1 — the ancestor pane is unexplained. ✅ SHIPPED.** Renamed **Original**, glossed per-pane
  ("The shared starting point, before either edit. Read-only reference."), and already visually
  de-emphasized (greyed, non-clickable).
- **P1 — no preview of the resolved result before Apply, and "Both" ordering unstated. ✅ SHIPPED.**
  A live, collapsible **Preview result** renders exactly what Apply will write (computed from the
  current picks via the same `resolveMarkedText` rule); "Both" now carries "Mine first, then Theirs".
- **P1 — silent default on modal dismiss. ✅ SHIPPED, then SUPERSEDED.** First pass made dismissing
  the delete/binary modals *defer* (never a silent `'restore'`/`'keep_local'` pick), with a "Decide
  later" button. The "full inline" follow-up then **deleted the modals** — delete/binary conflicts
  defer on every round into the Conflicts panel and are only ever resolved by an explicit inline
  choice, so a silent-dismiss default no longer exists to guard against.
- **P1 — resolving many conflicts was one file at a time, and the list moved under you. ✅ SHIPPED
  (post-audit).** The "All mine / All theirs / Keep both" pickers only existed in *file* scope, so a
  round that conflicted twenty notes meant twenty identical passes; and every resolution dropped its
  card immediately, reflowing everything below it mid-click.
  **Shipped:** (a) a list-scope **bulk bar** above the cards — the same three pickers applied to
  every live text conflict, plus one **Apply all** behind a `ConfirmModal` (it states that unpicked
  changes keep Mine, the `resolveMarkedText` default). It appears only at ≥2 text conflicts, and
  like the per-file bar the pickers *only set picks* — the single confirmed write is Apply all.
  Delete/binary cards are deliberately **excluded** from the bulk sweep: the "full inline" decision
  above makes an explicit per-card choice the only way those resolve. (b) a **sticky list** — a
  resolved card keeps its slot, frozen (dimmed, actions disabled, "Resolved" badge, "Open note" still
  live) rather than vanishing. Frozen cards clear when the user leaves the tab (`active-leaf-change`
  away from the leaf, or `onClose`) or on an explicit **Clear now** — the only moments a height
  change can't cost a misclick.
- **P2 — binary conflict shows only text metadata ◑ PARTIAL.** The binary decision is now an inline
  panel card showing size + device + time per side; the raw UUID is gone (it uses the same
  `describeDevice` short label as the text-conflict provenance chips). **Still open:** an image
  *thumbnail* for image types.

---

## 4. Settings information architecture — **P1**

Every setting sits in one flat list, mixing four mandatory basics, several everyday options,
and four expert/maintenance actions. Findings:

- **P1 — expert controls interleaved with basics. ✅ DONE (with decision 1).** Debounce delay and
  Ancestor retention (plus sync-.obsidian and exclusions) were developer-facing but in the main
  list. **Shipped:** all moved under the **Advanced** `<details>` disclosure.
- **P1 — the most dangerous action is visually equal to the safest. ✅ DONE.**
  Re-baseline could overwrite other devices' edits yet was styled like the "Safe" Clear cache.
  **Shipped:** the danger zone now has a severity gradient — re-baseline gets a solid-red
  danger button (`.vault-sync-danger-btn`) *and* a **type-to-confirm** gate
  (`ConfirmModal.requireTyped`: the confirm stays disabled until the user types "re-baseline"),
  with copy that spells out the overwrite is not undoable here; the safe Clear-cache dropped its
  warning styling so it no longer shouts like the destructive actions.
- **P2 — "Clear sync cache" is styled as a warning but fires unguarded** (`:273`, no
  `ConfirmModal`). Its desc says "Safe", so acceptable; either drop the warning styling or add
  a confirm for consistency.
- **P2 — Device ID read-only raw UUID near the top** (`:61`) adds clutter. **✅ DONE.** Moved
  into a collapsed **Diagnostics** `<details>` disclosure; the Device *name* stays in "This
  device".
- **P1 — the critical passphrase field has no confirm/typo guard** (`:135`). A mistype now
  fails *safely* (the key-check guard → `KeyMismatchError`), but the user still hits it only
  at sync time. **Fix:** the fingerprint + Test connection already form the guard; make them
  part of the setup checklist (§1) so a typo is caught at entry, not first sync.

---

## 5. Status, feedback & errors — **P1**

The typed error family (`sync-errors.ts`) is **good** — messages name the knob to check
(`AuthError`→token, `NotFoundError`→URL/vault, `KeyMismatchError`/`DecryptError`→passphrase,
`Network`/`Timeout`→connection). Remaining rough edges are about *how/where* state is shown:

- **P0/P1 — setup-time errors surface as a transient toast. ✅ SHIPPED (decisions 4 & 5).** Every
  failure toasted then faded; the durable copy lived only in the status modal's "Last error".
  **Shipped:** `isSetupError()` classifies auth / 404 / key-mismatch / decrypt as setup failures
  → a persistent, **color-flagged (no emoji)** notice with an "Open settings" action (new
  `Notifier.setupError`). Transient transport errors keep the fading toast (they self-retry). The
  `✅`/`❌` were dropped from the complete/failed toasts per the no-emoji decision.
- **P1 — `{operation}` fragments read technical. ✅ SHIPPED.** The transport labels that read into
  `ServerError`/`NetworkError`/`TimeoutError` are now "downloading changes" / "uploading your
  changes" (blob calls already said "downloading/uploading a file").
- **P1 — raw internals in the status modal. ✅ MOSTLY SHIPPED.** Stranded content is now described by
  count + meaning (no hex fragment); the device row shows the *name*, not a UUID; "Vault key:
  unlocked (fingerprint) / locked". **Left as-is:** "Last error" still prints `message` verbatim —
  correct for the typed-error family, and the only remaining case (an unexpected raw error) is rare.
- **P1 — ribbon tooltip over-promises. ✅ SHIPPED.** The error-state ribbon click now opens the status
  modal (details), matching its "click for details" tooltip, instead of firing another sync.
- **P2 — status-bar click is overloaded and unlabeled** (`main.ts:219`: conflicts→panel, else
  →sync). Nothing signals it's clickable or that behavior changes. **Fix:** consistent action
  + a tooltip.
- **P2 — "Vault sync complete" toast only on manual sync** (`sync-coordinator.ts:137`) — fine, but
  ensure auto-sync still updates the status bar to the "Synced" (green) state so silent success is
  visible. *(The status bar now conveys "Synced" by color + label after every round, auto included.)*

---

## 6. Mobile adaptation — **P0** (mobile is a declared target)

`manifest.json` `isDesktopOnly: false`, but there is **no mobile adaptation** — `styles.css`
has **zero `@media` queries** (grep confirms). Findings:

- **P0 — 3-column diff on a narrow screen. ✅ RESOLVED.** `.vault-sync-hunk-panes` forced
  Mine/Common/Theirs side-by-side at `font-size: 0.78rem`, unreadable on a phone. **Fixed:** a
  `@media (max-width: 700px)` block in `styles.css` stacks the panes to a single full-width
  column (bottom dividers instead of right ones, height cap lifted, slightly larger type).
  Additionally the conflicts view moved from the right sidebar to a **main-area tab**
  (`activateConflictsView` now uses `workspace.getLeaf('tab')`), so it is no longer a cramped
  slide-over drawer on mobile at all.
- **P1 — touch targets below ~44px. ✅ SHIPPED.** Under the `max-width:700px` breakpoint the per-hunk
  / global / footer conflict buttons and the delete/binary/confirm modal buttons now get a 44px min
  height, roomier padding, wider gaps, and `flex-grow` so a thumb can't miss.
- **P1 — status-bar-as-primary-entry-point may not exist on mobile.** The conflicts panel's
  main route is the status bar click (`main.ts:218`); mobile status bars are less prominent/
  absent. **Fix:** ensure a Command-palette route always exists (it does — "Open conflicts
  panel") *and* the post-conflict Notice action from §3.
- **P2 — desktop-flavored default** placeholder "My MacBook" (`settings-tab.ts:54`) on a phone
  install. **Fix:** neutral placeholder ("My phone / laptop").

**Mobile must be part of the manual-smoke matrix (§8), not an afterthought.**

---

## 7. Prioritized remediation checklist

**P0 — release-blocking** — ✅ all clear

- [x] Onboarding: group the 4 required fields + readiness checklist; separate Advanced (§1.1).
- [x] Fix "configure first" toasts to name the actual missing field(s) + open settings (§1.2).
- [x] First-class "Add another device" explanation (Vault ID + passphrase + token) (§1.3).
- [x] Conflicts discoverable after a round (persistent actionable entry point) (§3).
- [x] Setup-class errors shown durably, not just a fading toast (§5).
- [x] Mobile: stack conflict panes vertically below a breakpoint (§6).
- [x] Delete `conflict-modal.ts` (or reconcile) (§0).

**P1 — strongly recommended**
- [x] One vocabulary per concept across panel + inline markers + settings (§2). *(Mine/Theirs/Original
      everywhere; markers relabelled back-compatibly; "unlock"/"ready" for the derive jargon;
      "Vault Sync" casing. **Still open:** the optional friendlier marker *header line*, and the
      P2 delete-strategy setting-value rename.)*
- [x] Unify the conflict mental model; dismiss = defer, never a silent pick (§3). *("Full inline":
      delete/binary conflicts no longer block — they're inline cards in the Conflicts panel
      alongside text conflicts (one surface, one model), resolved by recording a decision the next
      round consumes. The blocking modals were deleted, so "silent dismiss pick" is gone by
      construction.)*
- [x] "Original" pane label + gloss; resolved-result preview (§3). *(pane renamed Base→Original with
      per-pane tooltips; live collapsible "Preview result"; "Both" states its ordering.)*
- [x] Settings IA: Advanced disclosure + a Danger zone for re-baseline (§4). *(disclosures landed with
      §1.1; re-baseline now has the loud solid-danger style + a type-to-confirm gate; the safe
      Clear-cache lost its warning styling.)*
- [x] Plain-language `{operation}` phrases; ribbon error-click → details (§5). *("downloading changes"/
      "uploading your changes"; error-state ribbon click opens the status modal.)*
- [x] Mobile touch targets + command-palette route guaranteed (§6). *(conflict + modal buttons get a
      ~44px min height / roomier spacing under the breakpoint; command-palette route already existed.)*
- [x] Onboarding P1s: fingerprint copy button + "why" gloss (§1.4); dead-end unlock copy (§1.5);
      status-modal internals — device *name*, no stranded hex, color-flagged attention rows (§5).

**P2 — polish**
- [x] De-emoji sweep: status bar / sync-progress / Test-connection / marker notice glyphs → color +
      word label (§5). *(readiness `✓`/`✗` kept — glyph+color is accessible, not color-only.)*
- [x] Casing/naming normalization; device *name* instead of UUID everywhere (§2, §3, §5). *(raw UUID
      gone from the binary card + Device ID behind Diagnostics; casing is "Vault Sync" throughout;
      the delete-strategy `restore`/`keep_modified` split is unified on `keep_modified`.)*
- [ ] Binary conflict thumbnail; neutral device-name placeholder (§3, §6). *(neutral "My phone /
      laptop" placeholder done in §1.1; the raw UUID is gone from the binary card (now a device
      label); image thumbnail still open.)*
- [x] Clear-cache confirm consistency; move Device ID to diagnostics (§4). *(clear-cache warning
      styling already dropped in the §4 P1 pass; Device ID now lives in a Diagnostics disclosure.)*

> **Status (2026-07-23):** all seven P0 items **and** the P1 set have landed (vocabulary,
> full-inline conflict unification, danger hierarchy, plain phrasing, touch targets, onboarding
> copy), plus most of **P2** (de-emoji sweep, Device ID → Diagnostics, delete-strategy vocabulary).
> Remaining: **two P2 items** — a friendlier marker *header line* and a binary-conflict *thumbnail* —
> plus the **manual-smoke matrix (§8)** on desktop + a real mobile device. The code is verified by
> unit tests in the obsidian-free layer, but every UI surface still needs a hands-on pass (see the
> Known manual-smoke surface in the engineering guide).

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
   → resolve via panel (check the live **Preview result** matches, and "Both" ordering) and via
   hand-editing markers → converge. On mobile: panes readable and tappable.
5. **Delete/modify and binary conflict ("full inline"):** on both manual and auto sync the conflict
   appears as an **inline card in the Conflicts panel** (no blocking modal); an auto round raises the
   persistent "open conflicts" notice. Pick a side on device A → the applying round mints the merge
   node → **device B fast-forwards without re-prompting**. Confirm the binary card shows size/device/
   time per side, and that leaving a conflict unresolved keeps the current version (no silent pick).
6. **Maintenance actions:** reset, re-baseline (type-to-confirm gate + solid-danger button), clear
   cache — copy matches effect; no accidental data-loss path.

## 9. Out of scope
Server-side/token issuance UX (spec §9.2), theming beyond light/dark, localization/i18n, and
any behavioral change to the merge/sync engine (this spec is presentation only — behavior is
governed by `sync-engineering-guide.md`).
