#!/usr/bin/env bash
#
# Copy this plugin's built files into an Obsidian vault for local testing.
#
# Unlike link-vault.sh (which symlinks the repo), this copies the actual build
# artifacts — use it when Obsidian won't follow a symlink (e.g. a synced/mobile
# vault, or a copy you want to keep after the repo moves). Because it's a copy,
# you must re-run it after every `npm run build` to pick up changes.
#
# Copies only:  main.js  manifest.json  styles.css  (into .obsidian/plugins/<id>)
#
# Usage:
#   scripts/copy-to-vault.sh /path/to/vault          # build first, then copy
#   scripts/copy-to-vault.sh -u /path/to/vault       # remove the copied plugin
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
    -u|--unlink|--remove) UNLINK=1 ;;
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
    die "$TARGET is a symlink (made by link-vault.sh) — use 'link-vault.sh -u' instead."
  elif [ -d "$TARGET" ]; then
    rm -rf "$TARGET"
    echo "removed $TARGET"
  else
    echo "nothing to remove ($TARGET does not exist)"
  fi
  exit 0
fi

# ── Copy mode ───────────────────────────────────────────────────────────────
# The build artifacts Obsidian actually loads. main.js is required; styles.css
# is optional (only if the plugin ships CSS).
[ -f "$PLUGIN_ROOT/main.js" ] || \
  die "main.js not built — run 'npm run build' first, then re-run this script."

if [ -L "$TARGET" ]; then
  die "$TARGET is a symlink (made by link-vault.sh). Remove it first:
    scripts/link-vault.sh -u '$VAULT'"
fi

mkdir -p "$TARGET"
cp -f "$PLUGIN_ROOT/main.js" "$TARGET/main.js"
cp -f "$MANIFEST" "$TARGET/manifest.json"
[ -f "$PLUGIN_ROOT/styles.css" ] && cp -f "$PLUGIN_ROOT/styles.css" "$TARGET/styles.css"

echo "copied plugin '$PLUGIN_ID' → $TARGET"
echo "  files: main.js manifest.json$([ -f "$PLUGIN_ROOT/styles.css" ] && echo ' styles.css')"
echo
echo "re-run this after every 'npm run build' to update the copy."
echo "next: in Obsidian → Settings → Community plugins, enable \"OpsBlobs\""
echo "      (turn off Restricted/Safe mode first if it's on)."
