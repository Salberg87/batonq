# Changelog

All notable changes to batonq are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-24

### Added

**TUI** — live work surface (TUI UX v2)

- Alert lane §1 — cheat / `verify_ran_at` classifier with inline receipts.
- Current-task card §2 — scans all claim cwds for `any:*` tasks, not just
  the current repo.
- Tasks panel §3 — verify/judge badges, priority grouping, with
  no-timing and output-clip semantics.
- Live feed §4 — merged loop/evt/git tail with pause, scroll isolation,
  and mtime-friendly unquoted refs.
- Drill-down overlay §5 — live refresh, scroll isolation, `A` keybind
  for all-rows.
- Live loop-status footer with health indicators.

**CLI**

- `batonq init` — first-run wizard for hooks, example task, and
  `gtimeout` check; previews hook entries and the example task before
  the y/n prompt.
- `batonq logs` — combined tail of `events.jsonl` and loop output.
- `uninstall.sh` — uninstall script with optional state retention.
- `check-ship.sh` + ship criteria checklist as the end-goal source of
  truth for release readiness.

**Arch**

- DB-first task input: `batonq add` / `batonq import` / `batonq export`,
  with TASKS.md live sync deprecated in favour of the DB.
- Task priority + scheduling. Optional `priority: high|normal|low`
  (default `normal`) and `scheduled_for: <ISO-8601 UTC>` directives under
  a task in `~/DEV/TASKS.md`. `pick` filters out tasks whose
  `scheduled_for` is in the future and orders the rest by priority, then
  by `COALESCE(scheduled_for, created_at)`, then `created_at` —
  deterministic and stable. The `tasks` listing mirrors that order and
  shows a `[H]/[N]/[L]` priority badge plus a `⏰<iso>` / `⏰(ripe)`
  marker where relevant; `pick` output surfaces the picked task's
  `priority` and `scheduled_for` fields.
- `initTaskSchema` adds `priority` and `scheduled_for` columns (with a
  pick index) and migrates legacy DBs in place. Unknown priority tokens
  fall back to `normal`; `scheduled_for` requires a full ISO-8601
  timestamp with a timezone component and is canonicalised to Z-suffixed
  UTC on the way in.
- Linux compatibility for `batonq-loop` and the installer (uname /
  Darwin / linux branching).
- Micro-eval harness scaffold for the batonq pipeline.
- Cheat-detection scorecard — 5 scenarios with receipts.

**CI**

- Coverage report + badge + threshold enforcement, with a preload-print
  threshold banner so the verify regex matches.
- Anti-cheat gate test + verify-gate hot-paths + dynamic badge.
- End-to-end install test on CI.

**Docs**

- TUI UX v2 spec — live work surface replacing the static dashboard.
- Architecture diagrams (mermaid).
- FAQ expanded with 10 real-world troubleshooting entries.
- Hero reframed around the anti-cheat story; honest side-by-side vs
  related tools, with a verify-gate marker for the CI grep check.
- Demo GIF embedded in the README hero; docs references integrated.
- Inline documentation for alert-lane classifier, tasks-panel badges,
  and drill-down overlay refresh + input isolation.
- README release-badge alt-text tweaks (includes `v0.1.0` and `badge`).
- `uname` / Darwin / linux note in the loop header for the verify grep.

### Changed

**Arch**

- Unified DB path + task schema foundation.
- TASKS.md live sync deprecated: `pick` / `done` no longer auto-sync.
  `install.sh` migrates legacy TASKS.md on upgrade as the deprecation
  follow-up.

**CLI**

- `init` case label single-quoted so the verify gate matches.

### Fixed

**TUI**

- Current-task card now scans all claim cwds for `any:*` tasks so
  cross-repo claims render correctly.
- `L`-restart also `pkill`s `claude -p` to avoid orphan processes.

**Loop**

- Plain `claude -p` invocation + liveness watchdog with mtime staleness
  detection.

**Install**

- `install.sh` produces self-contained binaries via `bun build --compile`.
- Dropped `pipefail` for POSIX sh (dash) compatibility.

### Removed

**Gates**

- `--skip-verify` and `--skip-judge` flags removed entirely — autonomous
  agents can no longer bypass verification or judging.

## [0.1.0] — 2026-04-23

Initial public release. Extracted from the internal `agent-coord` tool used
for coordinating parallel Claude Code agents into a single batonq binary
with a handful of unix-shaped verbs.

### Added

- `batonq` CLI with the core queue verbs: `pick`, `done`, `abandon`,
  `tasks`, `sync-tasks`, `mine`, `release`, `sweep`, `sweep-tasks`,
  `status`, `tail`, `report`.
- `batonq --version` / `-v` / `version` prints `batonq v<version> (commit
<short-sha>)` — version from `package.json`, commit from `git rev-parse`
  (falls back to `unknown` outside a git checkout).
- `batonq-hook`: Claude Code PreToolUse / PostToolUse hook that appends
  JSONL measurement events and enforces file-level locks so two parallel
  agents can't write the same path. 2s timeout, fails open.
- `batonq-loop`: fresh-Claude-per-task runner (Path A). Polls `pick`,
  spawns `claude -p` per task, clears context between iterations.
- `batonq tui`: live ink-based dashboard with five panels (Sessions,
  Tasks, Claims, File locks, Recent events). Refreshes every 2s.
- `batonq tui` inline task-creation form (keybind `n`) — appends tasks
  to `~/DEV/TASKS.md` as drafts under `## Pending`. Guarded with a
  lockfile + atomic rename for concurrent safety.
- Stable `external_id` derived from repo + task body — edits to adjacent
  lines don't re-issue IDs.
- `verify:` gates: shell command runs on `done`, non-zero exit keeps the
  task claimed with output captured so you never close a failing check.
- `judge:` gates: optional second-layer LLM verdict (PASS/FAIL) before
  close. Hardened `runJudge` enforces status-first invariant (never trust
  stdout alone); ETIMEDOUT and spawn errors surface as infra FAIL.
- `--skip-verify` flag on `done`, gated behind `AGENT_COORD_ALLOW_SKIP=1`
  to prevent autonomous agents from bypassing verification.
- Atomic SQLite-backed claim flow; stale claims and file locks are swept
  on a timer.
- Task-claim TTL (30 min): `sweep-tasks` marks claimed tasks with no
  progress as `lost`, runs a recovery hook that grants live sessions a
  5-minute grace, and appends an escalation line to
  `/tmp/batonq-escalations.log` when a claim actually flips to lost.
  Auto-runs on every `pick`.
- Draft lifecycle — `batonq enrich <id>` elaborates a draft via
  `claude --model opus`, returning clarifying questions or a spec with
  `verify:` + `judge:` directives; `batonq promote <id>` flips a draft
  to pending so `pick` will see it. TUI keybinds `e` / `p` / `o` wire
  the same flow from the dashboard.
- `batonq doctor` — structured 5-category diagnostic (Binaries,
  Installation, State, Scope, Live) with ✓/⚠/✗ per row, a `fix:` hint on
  every non-pass, and a copy-pasteable summary. Read-only.
- `batonq check` — legacy single-pass health probe kept for backward
  compatibility.
- `install.sh` — one-liner installer that checks for `bun` and `jq`,
  drops binaries into `~/.local/bin/` (or `~/bin/`), merges Claude Code
  hooks into `~/.claude/settings.json` idempotently, and creates state
  dirs.
- GitHub Actions CI with matrix build (bun versions × platforms).
- Production-grade README with install, quickstart, concepts, commands
  reference, TUI keybind table, architecture diagram, and FAQ.
- Test suite (`tests/core.test.ts`, `tests/tui.test.ts`) covering the
  pure task and hook cores: parser, syncTasks, selectCandidate,
  claimCandidate atomicity, sweepClaims, runVerify, runJudge fail-modes
  (12 cases), getGitDiffSinceClaim fail-modes, draft lifecycle,
  sweepTasks TTL, doctor, migrate, TUI add-task race.

### Changed

- Renamed internal state paths from `~/.claude/agent-coord-*` to
  `~/.claude/batonq-*` (state.db, measurement dir, fingerprint cache).
  The hook binary path installed by `install.sh` also drops the legacy
  name.
- On first run after upgrading, `batonq` and `batonq-hook` auto-migrate
  the legacy layout: DB, WAL/SHM siblings, fingerprint cache, and the
  full measurement dir are copied to the new paths and the originals
  are renamed to `*.bak` so a rollback is a single `mv`. Idempotent;
  no-op on fresh installs and on subsequent invocations.
- User-facing strings and the loop header renamed `agent-coord` → `batonq`.

### Fixed

- Parser scans the entire task block for `verify:` / `judge:` directives
  instead of peeking only one line ahead — multi-paragraph task bodies
  now keep their gates.
- `runJudge` hardened against false-PASS and timeout edge cases.
- Judge invocation uses `claude --model` (not `-m`), surfaced by the
  hardened runJudge.
- Installer commits with the correct repo URL.
- CI bun types resolution.
