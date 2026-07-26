# Mobile perf baseline — bench harness

Measurement infrastructure for **docs/mobile-perf-baseline-spec.md**. It drives the
**real** sync stack (`TestDevice` → `ServerSyncClient` → `FakeSyncServer`) over the
in-memory fakes, so every benchmark exercises production code — never a
reimplementation. **Nothing here ships** (it's outside `src/`).

## Run

```bash
npm run bench                          # default profiles: xs, s, m
BENCH_PROFILES=xs,s npm run bench       # quick regression pass
BENCH_PROFILES=xs,s,m,l,xl npm run bench # full sweep (slow — L/XL seed huge vaults)
BENCH_FULL=1 npm run bench              # adds deep K=200/1000 points to B2/B4
```

Requires `--expose-gc` (the npm script passes it) so heap deltas are real signal.

Each run writes a **date + profile-stamped** pair — `bench/results/<date>_<profiles>.{json,md}`
(e.g. `2026-07-23_xs-s-m.json`) — so a quick `xs` smoke can never clobber a full
baseline: they land in different files. Those stamped files are the durable, committable
record. It also refreshes `bench/results/latest.{json,md}`, a **transient, git-ignored**
pointer to the most recent run — never commit those. Override the date with `BENCH_DATE`
(e.g. to match a `docs/perf-baseline-<date>.md`).

## The three layers (why some numbers are "relative")

- **Layer 1 — wall time + heap delta.** A *relative* regression signal only. It is
  **not** the mobile number — a phone WebView is ~3–5× slower single-thread. Never
  quote a Layer-1 ms as "how long this takes on mobile".
- **Layer 2 — op-counts + byte-counts.** Exact and **device-independent**: how many
  times we SHA-256, AES-GCM, walk the DAG, and how many bytes we rewrite. This is the
  portable signal that scales badly, read straight off the fakes' `io` counters
  (`__tests__/helpers/fakes/io-counters.ts`) and the CPU-op counters the harness
  installs by monkey-patching `crypto.subtle` + the `VersionDag` prototype (external —
  no production edit).
- **Layer 3 — on-device wall-clock.** The only source of truth for absolute time.
  Turn on the **Performance logging** diagnostic (Settings → Diagnostics, the
  `perfLog` setting), run the matrix on a real phone, and read
  `.opsblobs/perf-log.txt`. Recorded by hand into the baseline table.

## Scenarios (B1–B9)

Each isolates one hypothesized hot path (spec §5 / Appendix A). See `run.ts`:
B1 steady-state round vs F · B2 round vs history H (DAG walks) · B3 cold startup vs F ·
B4 cold pull vs H · B5 write amplification · B6 memory over a session ·
B7 concurrent-head fold vs C · B8 diff3 large-file merge · B9 crypto attribution.

## Regression tracking

To gate a change, diff a fresh run's Layer-2 counts against a committed stamped
baseline (e.g. `bench/results/2026-07-23_xs-s-m.json`) — a jump in an op-count or
byte-count is the review flag (spec §8), not the noisy Layer-1 wall time.
