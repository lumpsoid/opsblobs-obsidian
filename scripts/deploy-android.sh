#!/usr/bin/env bash
#
# deploy-android.sh — push the built plugin into an Obsidian vault on an Android
# device over adb (the mobile dev-test loop; see bench/README.md / the mobile perf
# baseline's Layer-3 pass).
#
# It deploys the three build artifacts — main.js, manifest.json, styles.css — into
#   <android-vault>/.obsidian/plugins/<plugin-id>/
# where <plugin-id> is read from manifest.json (no hardcoding).
#
# Usage:
#   scripts/deploy-android.sh [options] <android-vault-path>
#   npm run deploy:android -- [options] <android-vault-path>
#
# <android-vault-path> is the vault's path ON THE DEVICE, e.g.
#   /sdcard/Documents/MyVault   or   /storage/emulated/0/Obsidian/MyVault
#
# Options:
#   --build       run `npm run build` first — the minified production build (what
#                 ships; use for faithful on-device perf checks)
#   --build-dev   run `npm run build:dev` first — an UNMINIFIED build with an inline
#                 sourcemap (readable stack traces on device; best for debugging)
#   --dry-run     print the adb commands instead of running them
#   -h, --help    show this help
#   (default: reuse the existing main.js, e.g. from a running `npm run dev` watch)
#
# Env:
#   ANDROID_SERIAL   target a specific device when several are attached (adb -s)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BUILD=""          # "" | "prod" | "dev"
DRY_RUN=0
VAULT=""

usage() { sed -n '3,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --build)     BUILD="prod" ;;
    --build-dev) BUILD="dev" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; VAULT="${1:-}"; break ;;
    -*) echo "error: unknown option '$1'" >&2; exit 2 ;;
    *)  VAULT="$1" ;;
  esac
  shift
done

if [ -z "$VAULT" ]; then
  echo "error: missing <android-vault-path>" >&2
  echo "try: scripts/deploy-android.sh /sdcard/Documents/MyVault" >&2
  exit 2
fi

# adb wrapper: honors ANDROID_SERIAL, and echoes instead of runs under --dry-run.
adbx() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "+ adb ${ANDROID_SERIAL:+-s $ANDROID_SERIAL} $*"
    return 0
  fi
  adb ${ANDROID_SERIAL:+-s "$ANDROID_SERIAL"} "$@"
}

command -v adb >/dev/null 2>&1 || { echo "error: adb not found on PATH (install android platform-tools)" >&2; exit 1; }

# Plugin id from manifest (node first — it's a node project — then a grep fallback).
ID="$(node -p "require('$ROOT/manifest.json').id" 2>/dev/null \
      || grep -oE '"id"[[:space:]]*:[[:space:]]*"[^"]+"' "$ROOT/manifest.json" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
if [ -z "${ID:-}" ]; then echo "error: could not read plugin id from $ROOT/manifest.json" >&2; exit 1; fi

# Build if asked; then require the artifacts.
case "$BUILD" in
  prod) echo "→ building (npm run build — minified)…";       ( cd "$ROOT" && npm run build ) ;;
  dev)  echo "→ building (npm run build:dev — unminified)…"; ( cd "$ROOT" && npm run build:dev ) ;;
esac
if [ ! -f "$ROOT/main.js" ]; then
  echo "error: $ROOT/main.js not found — run 'npm run build:dev' (or pass --build-dev), or start 'npm run dev'." >&2
  exit 1
fi

# Confirm a device is actually attached (skipped in dry-run).
if [ "$DRY_RUN" = 0 ]; then
  if ! adbx get-state >/dev/null 2>&1; then
    echo "error: no Android device reachable over adb. Attached devices:" >&2
    adb devices >&2
    echo "hint: enable USB debugging; set ANDROID_SERIAL if several are attached." >&2
    exit 1
  fi
fi

VAULT="${VAULT%/}"                                  # strip a trailing slash
REMOTE_DIR="$VAULT/.obsidian/plugins/$ID"

echo "→ plugin id : $ID"
echo "→ device dir: $REMOTE_DIR"

# Create the plugin dir on-device (inner quotes keep a space-bearing path intact in
# the device shell), then push each artifact that exists locally.
adbx shell "mkdir -p \"$REMOTE_DIR\""

pushed=0
for f in main.js manifest.json styles.css; do
  if [ -f "$ROOT/$f" ]; then
    echo "→ push $f"
    adbx push "$ROOT/$f" "$REMOTE_DIR/$f"
    pushed=$((pushed + 1))
  else
    echo "  (skip $f — not present)"
  fi
done

echo "✓ deployed $pushed file(s) to $REMOTE_DIR"
echo
echo "Next on the phone:"
echo "  • First time: Settings → Community plugins → enable \"OpsBlobs\"."
echo "  • Already enabled: toggle it off/on, or install the 'Hot Reload' plugin to"
echo "    auto-reload on each deploy."
