#!/usr/bin/env bash
#
# Link this plugin into an Obsidian vault for local testing.
#
# Symlinks the vault's `.obsidian/plugins/<id>` directory at this repo root, so
# a `npm run dev` watch rebuild is picked up live (reload the plugin in Obsidian,
# or use a hot-reload plugin, to see changes). The plugin id is read from
# manifest.json.
#
# Usage:
#   scripts/link-vault.sh /path/to/vault          # create/refresh the link
#   scripts/link-vault.sh -u /path/to/vault       # unlink (remove the symlink)
#
set -euo pipefail

# ── Resolve this repo's root (the plugin source) ────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }

# ── Parse args ──────────────────────────────────────────────────────────────
UNLINK=0
VAULT=""
for arg in "$@"; do
  case "$arg" in
    -u|--unlink) UNLINK=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $arg" ;;
    *)  VAULT="$arg" ;;
  esac
done
[ -n "$VAULT" ] || die "pass the path to the vault root. See --help."

# ── Validate the vault ──────────────────────────────────────────────────────
VAULT="$(cd "$VAULT" 2>/dev/null && pwd)" || die "vault path does not exist: $VAULT"
[ -d "$VAULT/.obsidian" ] || die "not an Obsidian vault (no .obsidian/): $VAULT
    open the folder in Obsidian once so it creates .obsidian/, then re-run."

# ── Read the plugin id from manifest.json ───────────────────────────────────
MANIFEST="$PLUGIN_ROOT/manifest.json"
[ -f "$MANIFEST" ] || die "manifest.json not found at $MANIFEST"
PLUGIN_ID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
[ -n "$PLUGIN_ID" ] || die "could not read \"id\" from $MANIFEST"

PLUGINS_DIR="$VAULT/.obsidian/plugins"
TARGET="$PLUGINS_DIR/$PLUGIN_ID"

# ── Unlink mode ─────────────────────────────────────────────────────────────
if [ "$UNLINK" -eq 1 ]; then
  if [ -L "$TARGET" ]; then
    rm "$TARGET"
    echo "unlinked $TARGET"
  elif [ -e "$TARGET" ]; then
    die "$TARGET exists but is not a symlink — refusing to remove it. Delete it by hand."
  else
    echo "nothing to unlink ($TARGET does not exist)"
  fi
  exit 0
fi

# ── Link mode ───────────────────────────────────────────────────────────────
# Warn (don't build) if there's no built output yet — Obsidian needs main.js.
[ -f "$PLUGIN_ROOT/main.js" ] || \
  echo "note: main.js not built yet — run 'npm run build' (or 'npm run dev' to watch)." >&2

mkdir -p "$PLUGINS_DIR"

if [ -L "$TARGET" ]; then
  rm "$TARGET"                       # refresh a stale/existing link in place
elif [ -e "$TARGET" ]; then
  die "$TARGET already exists and is a real directory (an installed copy?).
    remove it first if you want to link the dev build:  rm -rf '$TARGET'"
fi

ln -s "$PLUGIN_ROOT" "$TARGET"
echo "linked  $TARGET"
echo "     -> $PLUGIN_ROOT"
echo
echo "next: in Obsidian → Settings → Community plugins, enable \"OpsBlobs\""
echo "      (turn off Restricted/Safe mode first if it's on)."
