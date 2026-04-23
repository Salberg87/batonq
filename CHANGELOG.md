# Changelog

All notable changes to batonq are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- Renamed internal state paths from `~/.claude/agent-coord-*` to
  `~/.claude/batonq-*` (state.db, measurement dir, fingerprint cache). The
  hook binary path installed by `install.sh` also drops the legacy name.
- On first run after upgrading, `batonq` and `batonq-hook` auto-migrate the
  legacy layout: DB, WAL/SHM siblings, fingerprint cache, and the full
  measurement dir are copied to the new paths and the originals are renamed
  to `*.bak` so a rollback is a single `mv`. Idempotent; no-op on fresh
  installs and on subsequent invocations.

## [0.1.0] — 2026-04-22

Initial public release. Extracted from the internal `agent-coord` tool used
for coordinating parallel Claude Code agents.

### Added

- `batonq` CLI: `pick`, `done`, `abandon`, `tasks`, `mine`, `lock`,
  `release`, `sweep`, `status`, `tail`.
- `batonq-hook`: Claude Code PreToolUse / PostToolUse hook for measurement
  (JSONL event log) and coordination (file-lock enforcement).
- `batonq-loop`: fresh-Claude-per-task runner (Path A). Polls `pick`, spawns
  `claude -p` per task, clears context between iterations.
- Stable `external_id` derived from repo + task body — edits to adjacent
  lines don't re-issue IDs.
- `verify:` gates: shell command runs on `done`, non-zero exit keeps the task
  claimed.
- `judge:` gates: optional second-layer LLM verdict (PASS/FAIL) before close.
- `--skip-verify` flag gated behind `AGENT_COORD_ALLOW_SKIP=1` to prevent
  autonomous agents from bypassing verification.
- Atomic SQLite-backed claim flow; stale claims/locks are swept on a timer.
