# Obsidian Vault Sync

A peer-to-peer vault sync plugin for [Obsidian](https://obsidian.md) that works across all platforms including iOS — no third-party server required.

## Architecture

| Layer | What it does |
|---|---|
| **HLC** (`src/core/hlc.ts`) | Hybrid Logical Clock — total causal ordering across devices without requiring synchronized clocks |
| **File Registry** (`src/core/file-registry.ts`) | Stable UUID → path mapping. Files retain identity through renames, moves, and deletes |
| **Content Store** (`src/core/content-store.ts`) | Content-addressed (SHA-256) storage for ancestor versions used in three-way merge |
| **Operation Logger** (`src/core/operation-logger.ts`) | Records vault changes with 1.5s debounce; persists to `.vault-sync/oplog.json` |
| **Diff3** (`src/merge/diff3.ts`) | Bundled patience diff + three-way merge (~300 lines, zero dependencies) |
| **State Merge** (`src/merge/state-merge.ts`) | Pure CRDT merge function — commutative, associative, idempotent |
| **Encryption** (`src/network/encryption.ts`) | AES-256-GCM via Web Crypto API; PBKDF2 key derivation from pairing codes |
| **Sync Client/Server** (`src/network/`) | HTTP-based P2P transport; QR code / manual IP pairing |
| **UI** (`src/ui/`) | Conflict resolution modal, pairing flow, settings tab |

## Sync Protocol

```
Device A (initiator)          Device B (responder)
─────────────────────          ─────────────────────
       ── HELLO ──────────────►
       ◄── HELLO ──────────────
       ── OPS_SINCE ──────────►
       ◄── OPS_SINCE ──────────
       ── STATE ──────────────►
       ◄── STATE ──────────────

  [Both compute merge independently]

       ── CONTENT_REQUEST ────►
       ◄── CONTENT ────────────
       ◄── CONTENT_REQUEST ────
       ── CONTENT ────────────►

  [Both apply merge results]

       ── SYNC_COMPLETE ──────►
       ◄── SYNC_COMPLETE ──────
```

All messages are encrypted with AES-256-GCM using the paired device's shared key.

## Conflict Resolution

**Automatic (no user action needed):**
- Files added on one device → accepted on the other
- Files with non-overlapping edits → merged automatically using patience diff + three-way merge
- Renames on both sides → higher HLC timestamp wins

**Manual (UI):**
- Overlapping edits to the same region → conflict resolution modal (Accept Local / Accept Remote / Accept Both)
- Delete vs. modify → configurable strategy (ask / always keep deletion / always keep modification)

## Development

```bash
npm install
npm run dev          # watch mode
npm test             # run unit tests
npm run build        # production build
```

Copy `main.js` and `manifest.json` into your vault's `.obsidian/plugins/obsidian-vault-sync/` folder.

## Milestones

- [x] **M1** — HLC, file registry, operation logger, content store
- [x] **M2** — Patience diff, three-way merge, state merge function
- [x] **M3** — Encryption, sync client/server, P2P protocol
- [x] **M4** — Conflict UI, pairing flow, settings tab
- [ ] **M5** — Binary files, performance, multi-device hardening
- [ ] **M6** — Release, documentation, community submission

## File Structure

```
src/
  core/
    hlc.ts              # Hybrid Logical Clock
    file-registry.ts    # UUID ↔ path mapping
    content-store.ts    # Content-addressed storage
    operation-logger.ts # Vault event hooks + debounce
  merge/
    diff3.ts            # Patience diff + three-way merge
    state-merge.ts      # CRDT merge function
  network/
    encryption.ts       # AES-256-GCM
    sync-client.ts      # Initiator (Device A)
    sync-server.ts      # Responder (Device B)
    sync-applicator.ts  # Applies merge actions to vault
  ui/
    conflict-modal.ts   # Conflict resolution UI
    pairing-modal.ts    # Pairing flow
    settings-tab.ts     # Plugin settings
  main.ts               # Plugin entry point
  types.ts              # All TypeScript interfaces
  __tests__/
    core.test.ts        # Unit tests (HLC, diff3, state merge)
  __mocks__/
    obsidian.ts         # Obsidian API mock for testing
```

# Obsidian Sample Plugin

This is a sample plugin for Obsidian (https://obsidian.md).

This project uses TypeScript to provide type checking and documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript Definition format, which contains TSDoc comments describing what it does.

This sample plugin demonstrates some of the basic functionality the plugin API can do.
- Adds a ribbon icon, which shows a Notice when clicked.
- Adds a command "Open modal (simple)" which opens a Modal.
- Adds a plugin setting tab to the settings page.
- Registers a global click event and output 'click' to the console.
- Registers a global interval which logs 'setInterval' to the console.

## First time developing plugins?

Quick starting guide for new plugin devs:

- Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
- Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
- Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
- Install NodeJS, then run `npm i` in the command line under your repo folder.
- Run `npm run dev` to compile your plugin from `main.ts` to `main.js`.
- Make changes to `main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
- Reload Obsidian to load the new version of your plugin.
- Enable plugin in settings window.
- For updates to the Obsidian API run `npm update` in the command line under your repo folder.

## Releasing new releases

- Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
- Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
- Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
- Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
- Publish the release.

> You can simplify the version bump process by running `npm version patch`, `npm version minor` or `npm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

- Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Publish an initial version.
- Make sure you have a `README.md` file in the root of your repo.
- Make a pull request at https://github.com/obsidianmd/obsidian-releases to add your plugin.

## How to use

- Clone this repo.
- Make sure your NodeJS is at least v16 (`node --version`).
- `npm i` or `yarn` to install dependencies.
- `npm run dev` to start compilation in watch mode.

## Manually installing the plugin

- Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Improve code quality with eslint
- [ESLint](https://eslint.org/) is a tool that analyzes your code to quickly find problems. You can run ESLint against your plugin to find common bugs and ways to improve your code. 
- This project already has eslint preconfigured, you can invoke a check by running`npm run lint`
- Together with a custom eslint [plugin](https://github.com/obsidianmd/eslint-plugin) for Obsidan specific code guidelines.
- A GitHub action is preconfigured to automatically lint every commit on all branches.

## Funding URL

You can include funding URLs where people who use your plugin can financially support it.

The simple way is to set the `fundingUrl` field to your link in your `manifest.json` file:

```json
{
    "fundingUrl": "https://buymeacoffee.com"
}
```

If you have multiple URLs, you can also do:

```json
{
    "fundingUrl": {
        "Buy Me a Coffee": "https://buymeacoffee.com",
        "GitHub Sponsor": "https://github.com/sponsors",
        "Patreon": "https://www.patreon.com/"
    }
}
```

## API Documentation

See https://docs.obsidian.md
