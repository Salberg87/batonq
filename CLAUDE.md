# CLAUDE.md — batonq

Context for Claude Code (and other CLI agents) working in this repo.
Operational first, gotchas second, narrative third.

## Commands

```bash
bun test                       # full suite (370+ tests)
bun test tests/core.test.ts    # single file
bunx tsc --noEmit              # typecheck
bash scripts/check-ship.sh     # 22 ship-criteria, X/Y readout
sh install.sh                  # install ~/.local/bin/{batonq,batonq-hook,batonq-loop}

# CLI from source (preferred during dev — installed binary may be stale):
bun src/agent-coord <subcommand>
bun src/tui.tsx                # interactive TUI

# Multi-CLI dispatch (added in v0.3.0):
bun src/agent-coord agent-list
bun src/agent-coord agent-run --tool=<claude|codex|gemini|opencode> \
                              --prompt=<text> [--cwd=<dir>] [--model=<nick>]

# Snapshot for pasting into another LLM session:
bun src/agent-coord snapshot --md
```

## Architecture

```
src/
  agent-coord                    main CLI, all subcommand dispatch (~2200 LOC, single file)
  agent-coord-hook               Claude Code hook entry (Pre/Post tool-use, UserPromptSubmit)
  agent-coord-loop               bash loop (Path A — fresh agent per task)
  agent-coord-loop-watchdog      events.jsonl-mtime staleness killer
  agent-runners/                 claude/codex/gemini/opencode adapters + types + routing + context
  tasks-core.ts                  task lifecycle: parser, claim/done/abandon, sweep
  task-schema.ts                 Zod schema, validatedInsertTask, agent enum
  migrate.ts + migrate-path.ts   DB schema + canonical-path migration
  hook-core.ts                   file hashing, destructive-pattern detection
  alerts.ts + alert-lane.tsx     verify-failed / cheat-done / stale-claim classifiers
  tui.tsx + tui-panels.tsx       ink+React TUI (4 panels + footer + drill-down)
  current-task-card.tsx, drill-down.tsx, live-feed.ts
  loop-status.ts                 probe loop PID + claude-p PID + events age
  logs-core.ts                   events.jsonl + loop log tailing

scripts/check-ship.sh            ship-criteria runner (objective done-signal)
tests/*.test.ts                  bun:test, in-memory sqlite via memDb() helper in core.test.ts
```

State lives at `~/.claude/batonq/state.db` (canonical). Legacy
`~/.claude/agent-coord-state.db` and `~/.claude/batonq-state.db` are
auto-migrated by `migrate-path.ts` on first run of any binary.

Hook event log: `~/.claude/batonq-measurement/events.jsonl`.

## Hard rules

1. **Verify-pattern: NEVER use `git log -1 --pretty=%s` in `verify:` lines.**
   In multi-agent setups another agent commits between your claim and your
   done, and HEAD is no longer your commit. Result: infinite claim ↔
   abandon deadlock. Use `git log --since="$BATONQ_CLAIM_TS" --pretty=%s`
   (env var injected by `runVerify`). Pattern audit at pick-time warns
   on the fragile form (commit `25852e9`, `c5c7714`, `29ecc07`).

2. **Gates (verify/judge) are mandatory.** `--skip-verify` and
   `--skip-judge` were removed 2026-04-23 (commit `d4f4026`) after
   repeated agents shipped 40-50% of spec and self-closed past the gate.
   Setting `AGENT_COORD_ALLOW_SKIP=1` does NOT re-enable them. If verify
   fails, fix the underlying issue or `batonq abandon <id>`.

3. **TASKS.md is deprecated.** It carries a `> ⚠️ DEPRECATED` header on
   line 1. Add new tasks via `batonq add` (Zod-validated, schema-strict)
   or `batonq import <file>` for bulk. The old `syncTasks()` auto-call
   is removed from `pick`/`done` hot-paths.

4. **Tests must use in-memory SQLite.** Use `memDb()` from
   `tests/core.test.ts`. NEVER let a test touch `~/.claude/` — there's
   no rollback for production-state corruption.

5. **macOS portability:** `gtimeout` (coreutils), not `timeout`. `sed -i
''` with empty backup arg. `stat -f %m`, not `-c %Y`. The
   `batonq-platform-compat.sh` helper branches on `uname` — use it.

6. **Never `git push --force`. Never `Co-Authored-By: Claude` in commit
   messages.** Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`,
   `test:`, `chore:`, `ci:`, `release:`.

## Quota gotchas

- Two parallel `claude -p` loops can drain a Pro 5h-bucket in <3 hours
  (observed 2026-04-23). Burn-rate tracking is a known TODO; until then
  watch `/usage` and don't spawn a 3rd loop without need.
- Claude runner unsets `CLAUDECODE` and `ANTHROPIC_API_KEY` so the CLI
  bills against the subscription, not pay-as-you-go. Opt out with
  `BATONQ_USE_API_KEY=1`.
- Codex `exec` defaults to read-only sandbox; runner forces `--full-auto`
  in execute mode so it can edit files.
- Gemini `--yolo` is often blocked by Workspace admin policy; runner
  uses `--approval-mode=auto_edit` instead.

## Workflow

- Loop picks one task at a time per cwd repo-tag. Multi-loop is fine on
  different cwds; same cwd works but file-claims serialise edits.
- `BATONQ_FORCE_AGENT=codex batonq-loop` pins one loop to a single
  runner — useful for cross-tool dogfood/eval.
- Ship-criteria (`scripts/check-ship.sh` → `docs/ship-criteria.md`) is
  the objective termination signal. When it reads `N/N`, you're done.
- `batonq snapshot --md` produces a paste-ready status block for
  cross-session handoff.

## Conventions

- bun, not npm/pnpm/yarn
- TypeScript strict; Zod for schema; ink+React for TUI
- kebab-case file names (`my-component.tsx`)
- Norwegian or English in commit bodies — both fine, README/CHANGELOG
  English-only
- One subcommand = one top-level function in `src/agent-coord`; keep
  that file's `switch` statement the canonical entry-point map
