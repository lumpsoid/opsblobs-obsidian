#!/usr/bin/env python3
"""release.py — cut a plugin release and publish it to GitHub Releases (BRAT-ready).

What it does, in order:
  1. sanity checks (clean tree, tools present, gh auth, tag not taken)
  2. build the production bundle (npm run build)  -- done first so a compile
     failure aborts BEFORE anything is committed/pushed
  3. bump the version in manifest.json, package.json and versions.json
  4. commit the bump          (chore(release): X.Y.Z)
  5. create an annotated tag  (X.Y.Z  -- no "v" prefix, per Obsidian convention)
  6. push the commit and the tag
  7. create a GitHub release and upload main.js, manifest.json, styles.css

No zip is produced: BRAT and Obsidian download those three files as individual
release assets, so the version-bumped manifest.json must ship AS an asset (which
is why the tag == manifest version -- BRAT keys updates off that).

Usage:
  scripts/release.py [patch|minor|major]     # default: patch
  scripts/release.py minor
  scripts/release.py --set 1.2.0             # explicit version, no bumping
  scripts/release.py --dry-run               # print every step, change nothing
  scripts/release.py -y                      # skip the confirmation prompt

Options:
  part                 major | minor | patch   (positional, default: patch)
  --set X.Y.Z          set an explicit version instead of bumping
  --prerelease         mark the GitHub release as a pre-release
                       (BRAT ignores pre-releases unless the user opts in)
  --no-build           reuse the existing main.js instead of running the build
  --notes TEXT         release notes body (default: auto-generated from commits)
  --remote NAME        git remote to push to (default: origin)
  --dry-run            show what would happen without mutating anything
  -y, --yes            do not prompt for confirmation

Requires: git, npm, and the GitHub CLI `gh` (authenticated: gh auth login).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ["main.js", "manifest.json", "styles.css"]

# ANSI helpers (skipped when not a tty)
_TTY = sys.stdout.isatty()
def _c(code: str, s: str) -> str: return f"\033[{code}m{s}\033[0m" if _TTY else s
def bold(s): return _c("1", s)
def red(s): return _c("31", s)
def green(s): return _c("32", s)
def yellow(s): return _c("33", s)
def dim(s): return _c("2", s)

DRY_RUN = False


def die(msg: str) -> "None":
    print(red(f"error: {msg}"), file=sys.stderr)
    sys.exit(1)


def run(cmd: list[str], *, mutating: bool, capture: bool = False) -> str:
    """Run a command. Mutating commands are skipped (only printed) under --dry-run."""
    printable = "$ " + " ".join(cmd)
    if DRY_RUN and mutating:
        print(dim(printable + "   (skipped: --dry-run)"))
        return ""
    print(dim(printable))
    try:
        res = subprocess.run(
            cmd, cwd=ROOT, check=True,
            stdout=subprocess.PIPE if capture else None,
            text=True,
        )
    except FileNotFoundError:
        die(f"command not found: {cmd[0]}")
    except subprocess.CalledProcessError as e:
        die(f"command failed ({e.returncode}): {' '.join(cmd)}")
    return (res.stdout or "").strip() if capture else ""


def read(cmd: list[str]) -> str:
    """Run a read-only command (always executes, even under --dry-run)."""
    return run(cmd, mutating=False, capture=True)


def bump(version: str, part: str) -> str:
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    if not m:
        die(f"current version {version!r} is not plain X.Y.Z semver -- use --set")
    major, minor, patch = (int(x) for x in m.groups())
    if part == "major":
        major, minor, patch = major + 1, 0, 0
    elif part == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    return f"{major}.{minor}.{patch}"


def set_json_version_field(path: Path, new_version: str) -> None:
    """Rewrite the first top-level "version": "..." string, preserving formatting."""
    text = path.read_text()
    new_text, n = re.subn(
        r'("version"\s*:\s*")[^"]*(")',
        lambda mo: mo.group(1) + new_version + mo.group(2),
        text, count=1,
    )
    if n == 0:
        die(f'no "version" field found in {path.name}')
    path.write_text(new_text)


def update_versions_json(path: Path, new_version: str, min_app_version: str) -> None:
    """Map new_version -> minAppVersion in versions.json (Obsidian convention)."""
    data = json.loads(path.read_text())
    data[new_version] = min_app_version
    path.write_text(json.dumps(data, indent="\t") + "\n")


def main() -> None:
    global DRY_RUN

    p = argparse.ArgumentParser(
        prog="release.py",
        description="Bump the version and publish a BRAT-ready GitHub release.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("part", nargs="?", choices=["major", "minor", "patch"],
                   default="patch", help="which part to bump (default: patch)")
    p.add_argument("--set", dest="explicit", metavar="X.Y.Z",
                   help="set an explicit version instead of bumping")
    p.add_argument("--prerelease", action="store_true",
                   help="mark the GitHub release as a pre-release")
    p.add_argument("--no-build", action="store_true",
                   help="reuse the existing main.js instead of building")
    p.add_argument("--notes", help="release notes body (default: auto-generated)")
    p.add_argument("--remote", default="origin", help="git remote (default: origin)")
    p.add_argument("--dry-run", action="store_true",
                   help="print steps without mutating anything")
    p.add_argument("-y", "--yes", action="store_true", help="skip confirmation")
    args = p.parse_args()

    DRY_RUN = args.dry_run

    manifest_path = ROOT / "manifest.json"
    package_path = ROOT / "package.json"
    versions_path = ROOT / "versions.json"

    # --- sanity checks -------------------------------------------------------
    for tool in ("git", "npm", "gh"):
        if not read(["bash", "-lc", f"command -v {tool} || true"]):
            die(f"{tool} not found on PATH")

    # gh must be authenticated (release upload needs it)
    if subprocess.run(["gh", "auth", "status"], cwd=ROOT,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        die("gh is not authenticated -- run: gh auth login")

    # clean working tree (we are about to commit; stray changes would leak in)
    if read(["git", "status", "--porcelain"]):
        if DRY_RUN:
            print(yellow("warning: working tree is not clean (a real run would abort here)"))
        else:
            die("working tree is not clean -- commit or stash changes first")

    manifest = json.loads(manifest_path.read_text())
    current = manifest["version"]
    min_app_version = manifest.get("minAppVersion", "0.15.0")

    if args.explicit:
        if not re.fullmatch(r"\d+\.\d+\.\d+", args.explicit):
            die(f"--set expects X.Y.Z, got {args.explicit!r}")
        new_version = args.explicit
    else:
        new_version = bump(current, args.part)

    tag = new_version  # Obsidian convention: tag == manifest version, no "v"
    branch = read(["git", "rev-parse", "--abbrev-ref", "HEAD"])

    # tag must not already exist (locally or on the remote)
    if read(["git", "tag", "--list", tag]):
        die(f"tag {tag} already exists locally")
    if read(["git", "ls-remote", "--tags", args.remote, tag]):
        die(f"tag {tag} already exists on remote {args.remote}")

    # --- summary + confirm ---------------------------------------------------
    print()
    print(bold("Release plan"))
    print(f"  version : {yellow(current)} -> {green(new_version)}")
    print(f"  tag     : {green(tag)}")
    print(f"  branch  : {branch}  ->  {args.remote}")
    print(f"  build   : {'skip (reuse main.js)' if args.no_build else 'npm run build'}")
    print(f"  release : {'pre-release' if args.prerelease else 'latest'}")
    print(f"  assets  : {', '.join(ASSETS)}")
    if DRY_RUN:
        print(yellow("  (dry-run: nothing will be changed)"))
    print()
    if not args.yes and not DRY_RUN:
        if input("Proceed? [y/N] ").strip().lower() not in ("y", "yes"):
            print("aborted.")
            sys.exit(1)

    # --- 1. build first (fail before we touch git) ---------------------------
    if not args.no_build:
        run(["npm", "run", "build"], mutating=True)
    missing = [f for f in ASSETS if not (ROOT / f).is_file()]
    if missing and not DRY_RUN:
        die(f"build artifact(s) missing: {', '.join(missing)} -- drop --no-build?")

    # --- 2. bump version files ----------------------------------------------
    if not DRY_RUN:
        set_json_version_field(manifest_path, new_version)
        set_json_version_field(package_path, new_version)
        update_versions_json(versions_path, new_version, min_app_version)
    print(dim(f"  bumped manifest.json, package.json, versions.json -> {new_version}"))

    # --- 3. commit + tag + push ---------------------------------------------
    run(["git", "add", "manifest.json", "package.json", "versions.json"], mutating=True)
    run(["git", "commit", "-m", f"chore(release): {new_version}"], mutating=True)
    run(["git", "tag", "-a", tag, "-m", tag], mutating=True)
    run(["git", "push", args.remote, "HEAD"], mutating=True)
    run(["git", "push", args.remote, tag], mutating=True)

    # --- 4. GitHub release + assets -----------------------------------------
    cmd = ["gh", "release", "create", tag, *ASSETS,
           "--title", new_version, "--target", branch]
    cmd += ["--prerelease"] if args.prerelease else ["--latest"]
    if args.notes:
        cmd += ["--notes", args.notes]
    else:
        cmd += ["--generate-notes"]
    url = run(cmd, mutating=True, capture=True)

    print()
    print(green(f"✓ released {new_version}"))
    if url:
        print(f"  {url}")
    print()
    print(bold("Install / update in Obsidian via BRAT:"))
    print("  Add beta plugin  ->  lumpsoid/obsidian-sync-p2p")
    print("  (already added)  ->  BRAT: Check for updates")


if __name__ == "__main__":
    main()
