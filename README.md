<p align="center">
  <img src="./docs/logo.svg" alt="batonq" width="140" height="140">
</p>

<h1 align="center">batonq</h1>

<p align="center"><strong>Stop AI coding agents from faking test results.</strong></p>

<p align="center">
  <img src="./demo/intro.gif" alt="batonq anti-cheat walkthrough — add → try to skip the gate → verify+judge pass → ✓V ✓J" width="820">
</p>

<p align="center">
  A coordination queue for parallel AI coding agents — with a<br/>
  verify-or-stay-claimed gate that catches the <code>done</code>-without-work<br/>
  receipts your loop was quietly producing.
</p>

<p align="center">
  <a href="https://github.com/Salberg87/batonq/actions/workflows/ci.yml"><img src="https://github.com/Salberg87/batonq/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Salberg87/batonq/releases/latest"><img src="https://img.shields.io/github/v/release/Salberg87/batonq?color=4ADE80&label=release" alt="Latest release v0.2.0 badge"></a>
  <a href="./docs/coverage.svg"><img src="https://img.shields.io/badge/coverage-81%25-97CA00.svg" alt="Coverage 81%"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4ADE80.svg" alt="License: MIT"></a>
</p>

---

## What is this?

An autonomous Claude loop will happily close a task it never did the work
for. Four times today, on this machine, an agent marked a task `done` whose
`verify:` gate never ran — the receipts are sitting in the state DB,
queryable with one line:

```sh
sqlite3 ~/.claude/batonq/state.db \
  "SELECT external_id, substr(body,1,60) FROM tasks
     WHERE status='done' AND verify_cmd IS NOT NULL
       AND verify_ran_at IS NULL;"
```

This is the failure mode batonq was hardened against. The TUI flags those
rows with a red `cheat-done` badge; `batonq done <id>` now runs the
`verify:` command itself and keeps the claim open on a non-zero exit, so
the agent _cannot_ close past the gate. An optional `judge:` directive
adds a second-layer LLM review — only a `PASS` verdict lets the task
close. Every exit code and stderr line lands in `events.jsonl` as a
receipt you can grep.

That gate is what Anthropic's own eval pipeline didn't have on 2026-04-23
([postmortem](https://www.anthropic.com/engineering/april-23-postmortem)) —
three Claude Code quality regressions shipped because the evals failed to
reproduce the degradation. If a first-party eval rig can silently drift,
your solo `claude -p` loop has zero chance of catching a fabricated `done`
by vibe. You need the gate to fire when it says it fires, and you need
the receipts when it doesn't.

The repo ships a [cheat-detection scorecard](./evals/results/2026-04-24-cheat-detection.md)

## Multi-CLI fan-out

batonq orchestrates parallel agents across the four major CLI runners — Claude (`claude`), OpenAI Codex (`codex`), Google Gemini (`gemini`), and Anthropic's opencode — with a single shared queue and verify gate. Each runner speaks its own dialect: `claude -p`, `codex`, `gemini cli`, and `opencode` all map to batonq's same `pick` / `done` primitives. List available agents:

```sh
batonq agent-list
```

Run a task on a specific runner:

```sh
batonq agent-run --tool=claude <task-id>
```

The anti-cheat gates (`verify:`, `judge:`) fire identically regardless of which runner executes the work — no runner-specific exceptions exist.

For an honest side-by-side vs claude-squad, crystal, conductor, manual
`/loop` scripts, and ccswarm — including where those tools beat batonq —
see [docs/comparison.md](./docs/comparison.md).

## Demo

Run `batonq tui` (or `bun src/tui.tsx` from a checkout) to see the live
dashboard — sessions, tasks, claims, file locks, and recent events in one
ink-rendered view, refreshed every 2s. The layout is described under
[TUI](#tui) below.

> **Screenshot / screencast TBD** — PRs welcome. A real `docs/tui.png` and a
> 3-tab tmux `docs/screencast.gif` (parallel pick → work → done) will land
> alongside v0.2.

## Install

**One-liner (recommended):**

```sh
curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/install.sh | sh
```

The installer checks for `bun` and `jq`, clones the repo, **runs
`bun build --compile`** to produce self-contained binaries (each one bundles
its sibling-module imports — `loop-status`, `logs-core`, etc. — so the
installed binary has zero filesystem deps), drops them into `~/.local/bin/`
(or `~/bin/`), merges the Claude Code hooks into `~/.claude/settings.json`
idempotently, and creates the state dirs. Re-running it is safe — existing
hook entries are replaced, not duplicated. If `bun build --compile` fails
(rare; usually a too-old bun), the installer falls back to copying `src/` to
`~/.local/share/batonq/src/` and writing thin shell wrappers in the bindir.

**Manual (if you want to vendor the checkout):**

```sh
git clone https://github.com/Salberg87/batonq.git
cd batonq
bun install
export PATH="$PWD/bin:$PATH"
```

The `bin/` wrappers exec `bun` against `src/` directly, so no compile step is
needed for a vendored checkout. To produce installable self-contained binaries
manually (the same artefacts the installer would write):

```sh
mkdir -p build dist
cp src/*.ts src/*.tsx build/
cp src/agent-coord      build/agent-coord.ts        # bun bundler treats
cp src/agent-coord-hook build/agent-coord-hook.ts   # extensionless files
                                                    # as opaque assets
bun build --compile --target=bun build/agent-coord.ts \
  --outfile dist/batonq
bun build --compile --target=bun build/agent-coord-hook.ts \
  --outfile dist/batonq-hook
install -m 0755 dist/batonq      ~/.local/bin/batonq
install -m 0755 dist/batonq-hook ~/.local/bin/batonq-hook
install -m 0755 src/agent-coord-loop          ~/.local/bin/batonq-loop
install -m 0755 src/agent-coord-loop-watchdog ~/.local/bin/batonq-loop-watchdog
```

Requires [Bun](https://bun.sh) ≥ 1.0, `jq` (for the hooks merge), and
`gtimeout` from GNU coreutils (used by `batonq-loop` to bound each `claude -p`
invocation so a stuck task can't wedge the loop). On macOS:
`brew install coreutils`. On Debian/Ubuntu: `sudo apt-get install -y coreutils`.

> **Heads up on multiple loops per host:** `batonq-loop`'s liveness watchdog
> watches the shared hook log (`~/.claude/batonq-measurement/events.jsonl`).
> If you run two loops on the same machine and only one is making progress,
> the other's watchdog won't fire on its own wedge because the shared log
> keeps getting fresh writes from the peer. Run at most one `batonq-loop` per
> host, or give each loop its own events log.

**Uninstall (if you change your mind):**

```sh
batonq uninstall
# or, without batonq on PATH:
curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/uninstall.sh | sh
```

The uninstaller removes the batonq binaries from `~/.local/bin/` (or `~/bin/`)
and strips the three hook blocks from `~/.claude/settings.json` via `jq`, so
unrelated hooks survive. It then asks whether to delete state
(`~/.claude/batonq-state.db`, `batonq-measurement/`, `batonq-fingerprint.json`).
The default is **no** — data is kept so a later reinstall picks up where you
left off. Pass `--remove-state` (or `-y`) to delete without prompting, or
`--keep-state` to skip the prompt non-interactively.

## Quickstart

**1. Add a task straight to the queue:**

```sh
batonq add --body "add release notes for v0.1.1" --repo any:infra
# → task added: 51592069b22d
```

The DB is the source of truth. `batonq add` validates every task via a
strict Zod schema (non-empty repo, body ≥ 20 chars, `verify:` / `judge:` ≥ 10
chars when present, enum priorities) and writes straight to
`~/.claude/batonq/state.db`. No file parsing, no reformatter risk.

**2. In the repo you want to work from, start a loop:**

```sh
cd ~/DEV/batonq
batonq-loop
```

The loop spawns a fresh `claude -p` per task, with context cleared between
iterations. Each instance picks, works, and marks done autonomously.

**3. Watch the queue from another tab:**

```sh
batonq tasks     # list everything
batonq tui       # live dashboard
```

That's it. Open another terminal, `cd` into a different repo, and run
`batonq-loop` again — it picks a different task because the first one is
already claimed.

### Adding tasks

There are three supported entry points, all of which route through the same
schema gate and write directly to the DB:

```sh
# Single task, flag-driven. --repo defaults to the cwd's git root.
batonq add --body "investigate flaky auth test on CI" \
           --verify "bun test tests/auth.test.ts" \
           --priority high

# Single task, JSON on stdin — useful from other tools / scripts.
echo '{"body": "migrate login copy to new schema", "repo": "any:copy"}' \
  | batonq add --json

# Bulk from YAML (array or { tasks: [...] } wrapper) or markdown.
batonq import ~/DEV/my-backlog.yaml
batonq import ~/DEV/TASKS.md
```

Reasonable YAML shape:

```yaml
- body: investigate flaky auth test on CI
  repo: orghub
  priority: high
  verify: bun test tests/auth.test.ts
- body: migrate login copy to new schema
  repo: any:copy
  scheduled_for: 2026-05-01T09:00:00Z
```

Invalid entries are written to `/tmp/batonq-import-<ts>.log` with the Zod
reason and the offending raw object; valid entries still land in the DB. The
exit code is non-zero only when at least one entry was invalid — pure
duplicates are skipped silently (insert-new semantics).

Snapshot the DB back out as markdown at any time:

```sh
batonq export --md                      # to stdout
batonq export --md --file snapshot.md   # or to a file
```

The snapshot leads with a `# Snapshot — read-only, regenerate with 'batonq
export'` header so it's clear the file is not authoritative input.

> **TASKS.md is deprecated as a live sync target.** Pre-existing
> `~/DEV/TASKS.md` files still work as a one-way import via
> `batonq import ~/DEV/TASKS.md` or the legacy `batonq sync-tasks`, but
> `pick` / `done` / `tasks` / `enrich` no longer auto-parse the file on
> every invocation — the DB is the truth. Existing TASKS.md files get a
> `> ⚠️ DEPRECATED …` banner prepended on the first `batonq add` /
> `batonq import`.
>
> **Upgrading from a pre-arch-2 install?** `install.sh` runs
> `batonq import ~/DEV/TASKS.md` automatically at the end of install if
> the file has pending entries, so your in-flight tasks land in the DB
> instead of vanishing. The import is idempotent (duplicates skipped), so
> re-running it is always safe. If you're upgrading by hand, run
> `batonq import ~/DEV/TASKS.md` once before your next `batonq pick`.

## Concepts

- **Sessions** — each running agent registers a session keyed by pid. Claims
  and locks are owned by a session; a heartbeat keeps them alive. When the
  session dies, `sweep` releases anything it was holding.
- **Tasks** — parsed from `~/DEV/TASKS.md`. Each task gets a stable
  `external_id` derived from repo + body, so editing adjacent lines doesn't
  re-issue IDs. Scope is taken from the bold prefix: `**RepoName**` matches
  only that repo's `cwd`, `**any:tag**` matches any cwd.
- **Verify gates** — add a `verify:` line under a task. On `done`, batonq
  runs the shell command; non-zero exit keeps the task claimed with stderr
  captured, so you never close a task whose own check failed.
- **Judge agent** — an optional second-layer LLM review (`judge:` line).
  Only a `PASS` verdict lets the task close; `FAIL` leaves it claimed with
  the reasoning in the event log.
- **Priority + scheduling** — add optional `priority: high|normal|low`
  (default `normal`) and/or `scheduled_for: <ISO-8601 UTC>` directives
  under a task. `pick` drains `high` before `normal` before `low`; within a
  priority, tasks whose `scheduled_for` is in the future are invisible, and
  ripe tasks fire earliest-first. Stable ordering: `high → normal → low`,
  then `COALESCE(scheduled_for, created_at)` ascending, then `created_at` as
  the final tiebreaker.
- **Hooks** — `batonq-hook` plugs into Claude Code's PreToolUse and
  PostToolUse hooks. Layer 1 appends JSONL measurement events; layer 2
  enforces file locks, so two parallel agents can't write to the same path.

## Commands

| Command                                                 | Description                                                                                                                                                                                                              | Example                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `batonq pick`                                           | Claim the next task matching the current cwd's repo (or an `any:*` task).                                                                                                                                                | `batonq pick`                        |
| `batonq mine`                                           | Show tasks claimed by the current session (pid).                                                                                                                                                                         | `batonq mine`                        |
| `batonq done <id>`                                      | Mark a claimed task done. Runs the `verify:` gate if the task has one.                                                                                                                                                   | `batonq done 51592069b22d`           |
| `batonq abandon <id>`                                   | Release a claim so another agent can pick the task.                                                                                                                                                                      | `batonq abandon 51592069b22d`        |
| `batonq tasks`                                          | List every task in the DB with status.                                                                                                                                                                                   | `batonq tasks`                       |
| `batonq add --body <text>`                              | Insert a single task directly into the DB. Validates via the task schema (body ≥ 20 chars, priority enum, etc.). Supports `--repo`, `--verify`, `--judge`, `--priority`, `--at`, `--status`, and `--json` (reads stdin). | `batonq add --body "add v0.2 notes"` |
| `batonq import <file>`                                  | Bulk-import from a YAML or markdown file. Valid entries are inserted; duplicates are skipped; invalid entries go to `/tmp/batonq-import-<ts>.log`.                                                                       | `batonq import ./backlog.yaml`       |
| `batonq export --md [--file PATH]`                      | Write a read-only markdown snapshot of the DB. Stdout by default, a file with `--file`.                                                                                                                                  | `batonq export --md --file snap.md`  |
| `batonq sync-tasks`                                     | Legacy one-way import from `~/DEV/TASKS.md` into the DB. Prefer `batonq import <file>` for new workflows — the file itself is deprecated as a live sync target.                                                          | `batonq sync-tasks`                  |
| `batonq release <path>`                                 | Release a file lock held by the current session.                                                                                                                                                                         | `batonq release src/app.ts`          |
| `batonq sweep`                                          | Purge expired claims and file locks whose owning session is gone.                                                                                                                                                        | `batonq sweep`                       |
| `batonq sweep-tasks`                                    | Mark claimed tasks with no progress in 30 min as `lost`; live sessions get a 5-min grace via recovery hook. Logs lost tasks to `/tmp/batonq-escalations.log`. Auto-runs on every `pick`.                                 | `batonq sweep-tasks`                 |
| `batonq status`                                         | Print overall queue + lock state as a compact summary.                                                                                                                                                                   | `batonq status`                      |
| `batonq check`                                          | Health check: schema version, state-db permissions, hook wiring.                                                                                                                                                         | `batonq check`                       |
| `batonq doctor`                                         | Structured 5-category diagnostic (Binaries, Installation, State, Scope, Live) with `✓/⚠/✗` per row, a `fix:` hint on every non-pass, and a copy-pasteable summary. Read-only.                                            | `batonq doctor`                      |
| `batonq tail [-n N]`                                    | Tail the event log (JSONL).                                                                                                                                                                                              | `batonq tail -n 50`                  |
| `batonq logs [-f] [-n N] [--source events\|loop\|both]` | Combined tail of `events.jsonl` + newest `/tmp/batonq-loop*.log`, merged by timestamp. Events cyan, loop yellow, errors red. `-f` follows (500 ms poll).                                                                 | `batonq logs -f -n 50 --source both` |
| `batonq report`                                         | Aggregate measurement events over a time range (`--since`, `--until`, `--json`).                                                                                                                                         | `batonq report --since 2026-04-01`   |
| `batonq enrich <id>`                                    | Elaborate a draft via `claude --model opus`. Returns clarifying questions OR a spec with `verify:`+`judge:`.                                                                                                             | `batonq enrich 51592069b22d`         |
| `batonq promote <id>`                                   | Flip a draft to pending so `pick` will see it. Use after `enrich` once you're happy with the spec.                                                                                                                       | `batonq promote 51592069b22d`        |
| `batonq tui`                                            | Live ink-based TUI dashboard with sessions, tasks, claims, locks, events. Press `n` to add a task inline.                                                                                                                | `batonq tui`                         |
| `batonq loop-status`                                    | Print the loop footer state one-shot: loop state (running/idle/dead), current claimed task, claude-p pid+uptime, events.jsonl age. Add `--json` for machine-readable output.                                             | `batonq loop-status --json`          |
| `batonq-hook`                                           | Claude Code PreToolUse / PostToolUse hook. Not invoked manually.                                                                                                                                                         | (wired by `install.sh`)              |
| `batonq-loop`                                           | Fresh-Claude-per-task runner. `cd` into a repo, run, and the loop does the rest.                                                                                                                                         | `cd ~/DEV/MyRepo && batonq-loop`     |

## TUI

`batonq tui` opens a live dashboard backed by the same SQLite state. It
refreshes every 2s and gives you five panels — Sessions, Tasks, Claims, File
locks, Recent events.

**Keybinds:**

| Key            | Action                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `q` / `Ctrl-C` | Quit.                                                                                                               |
| `Tab`          | Cycle panel focus.                                                                                                  |
| `j` / `↓`      | Move selection down in focused panel.                                                                               |
| `k` / `↑`      | Move selection up in focused panel.                                                                                 |
| `/`            | Filter rows in focused panel. `Esc` cancels.                                                                        |
| `n`            | New task — open an inline form to append one to `TASKS.md` as draft.                                                |
| `e`            | Enrich selected draft via opus. If questions come back, answer inline.                                              |
| `p`            | Promote selected draft to pending so `pick` will see it.                                                            |
| `o`            | Toggle "Original: …" expand/collapse on an enriched draft.                                                          |
| `a`            | Abandon selected task (Tasks panel only).                                                                           |
| `r`            | Release selected lock (Claims panel only).                                                                          |
| `L`            | Restart `batonq-loop` (confirm y/n). Kills running loop + claude-p, re-spawns via `nohup` → `/tmp/batonq-loop.log`. |
| `?`            | Show full help overlay.                                                                                             |

**Loop-status footer:**

Below the four panels the TUI shows a two-line live footer tracking the
`batonq-loop` subsystem, refreshed on the same 2s tick as the panels:

1. **Loop state** — `✅ running` (loop + `claude -p` alive), `⏸ idle` (loop up
   but no claude), or `❌ dead` (no `agent-coord-loop` process). Detected via
   `pgrep -f agent-coord-loop`.
2. **Current task** — the claimed task the loop's PID is working, shown as
   `<external_id[:8]> · <first 50 chars of body>`. Falls back to `— (idle)`
   when nothing is claimed.
3. **Claude-p** — the PID of the oldest-alive `claude -p` process plus its
   elapsed seconds (`ps -o etimes`).
4. **Events age** — seconds since `events.jsonl` was last written. Colour
   flips yellow past **300 s** and red past **600 s** (the watchdog's default
   `BATONQ_WATCHDOG_STALE_SEC`). Missing log → dim `no events.jsonl`.

Press `L` to restart the loop: the TUI opens a confirm prompt, then on `y`
runs `pkill -f agent-coord-loop` and re-spawns `batonq-loop` detached via
`nohup`, logging to `/tmp/batonq-loop.log`. Use this when the events-age cell
has gone red and the queue stopped moving. For scripting, `batonq loop-status
--json` prints the same snapshot from the CLI.

**Add-task form — keybind `n`:**

Opens an overlay with four fields — **Repo** (prefilled from the current cwd's
git-root basename, or `any:infra` when outside a git repo), **Body** (required),
**Verify** (optional shell gate), **Judge** (optional LLM prompt). `Tab` /
`Shift-Tab` moves between fields, `Enter` submits (only when Body is non-empty),
`Esc` cancels without writing. Submitted tasks land under `## Pending` in
`~/DEV/TASKS.md` as **drafts** (`- [?]`), not pending — they're invisible to
`pick` until a human enriches and promotes them.

**Draft workflow — keybinds `e` / `p` / `o`:**

Drafts are the "before an autonomous agent sees it" lane. The TUI marks them
with `📝draft` in the accent colour because the Tasks panel is where you shake
a terse idea into a concrete spec:

1. Press `e` on a selected draft. The TUI spawns `batonq enrich <id>` (calls
   `claude --model opus --dangerously-skip-permissions` under the hood) and
   streams progress to the status line.
2. If opus decides the brief is ambiguous it returns a `QUESTIONS:` block. The
   TUI opens an inline overlay — one input per question, `Tab` navigates,
   `Enter` submits them all. The answers are appended to the draft body and
   `e` is re-run automatically, giving opus another shot with more context.
3. If opus returns a spec, the draft body is rewritten with the elaborated
   text plus `verify:` / `judge:` directives. The Tasks panel then shows a
   **hybrid view**: the enriched spec as the main row, and a collapsed
   `Original: <user-body>` metadata line underneath. Press `o` to expand/
   collapse that line — handy when reviewing opus' interpretation against
   your original phrasing.
4. Press `p` to promote. Status flips `[?]` → `[ ]` in both the DB and
   `TASKS.md`; `pick` will hand it out to the next autonomous agent.

A draft never leaks into `pick` on its own — `selectCandidate` filters on
`status = 'pending'` exactly. Enrichment is the human-in-the-loop step that
keeps opus' default-bias from producing wrong work downstream.

**Task-claim TTL & the `lost` status:**

Claimed tasks carry a 30-minute progress TTL (`TASK_CLAIM_TTL_MS`). Every
PostToolUse hook refreshes `last_progress_at` on the session's claimed tasks,
so an agent actively doing work keeps its claim warm. When `batonq sweep-tasks`
runs — automatically on every `pick`, or on demand — it scans claimed tasks
whose last progress predates the TTL and runs `tryRecoverTaskBeforeMarkLost`
on each. If the claiming session still has a heartbeat within 5 minutes the
task gets a 5-minute grace extension; if the session looks dead, the task
flips to **`lost`** and a JSONL line (timestamp, `external_id`, repo, body
snippet) is appended to `/tmp/batonq-escalations.log` so a human — or another
agent tailing the file — can pick up the pieces. `lost` tasks are out of the
`pick` rotation; abandon + re-promote (or manually flip the DB row back to
`pending`) to re-queue them.

For the full UX spec driving the TUI implementation — panel layouts, badge
semantics, and the agent/human task-slice split — see
[`docs/tui-ux-v2.md`](./docs/tui-ux-v2.md).

> **TODO:** add `docs/tui.png` once v0.2 ships.

## Architecture

```
       ┌─ ~/DEV/TASKS.md (human source of truth)
       │
       ▼
┌─────────────┐   sync    ┌──────────────────────────────┐
│ parse tasks │─────────▶│  ~/.claude/                   │
└─────────────┘           │  ├─ batonq-state.db          │  SQLite:
                          │  │                           │  sessions, tasks,
                          │  │                           │  claims, locks
                          │  └─ batonq-measurement/      │
                          │     └─ events.jsonl          │  append-only log
                          └──────────────────────────────┘
                                   ▲            ▲
           ┌───────────────────────┘            │
           │                                    │
    ┌──────┴──────┐                  ┌──────────┴──────────┐
    │  batonq     │                  │  batonq-hook        │
    │  CLI / TUI  │                  │  (Claude Code)      │
    │             │                  │  PreToolUse   →─────┤
    │  pick/done/ │                  │  PostToolUse  →─────┤
    │  abandon…   │                  │                     │
    └─────────────┘                  │  enforces file lock │
                                     │  + appends events   │
                                     └─────────────────────┘
```

Three moving parts: the **event log** (`events.jsonl`, append-only, grep-able),
the **SQLite state** (`~/.claude/batonq-state.db`, mutated under
transactions), and the **hooks** (`batonq-hook pre|bash|post`, 2-second
timeout, never blocks Claude on its own failure). Everything else is a shell
of unix verbs around those three files.

For mermaid-rendered component, state, claim-write-path, and data-flow
diagrams (with prose), see [`docs/architecture.md`](./docs/architecture.md).

## Ship status

Ship-readiness is not a vibe. `docs/ship-criteria.md` lists every
machine-checkable assertion that defines "ready to release the next
version" — Track A TUI surfaces, Track B gates, Track C infra, Track D
docs, and the Viral V1–V4 marketing artifacts. Each row is a one-line
shell check.

Run the report:

```sh
batonq ship-status       # or: scripts/check-ship.sh
```

Example output:

```
PASS  SHIP-001  README anti-cheat tagline present
PASS  SHIP-002  install.sh shell-syntax valid
PASS  SHIP-003  install.sh uses strict mode and chmods binaries
…
PASS  SHIP-016  Test suite green under bun test
FAIL  SHIP-017  TypeScript typecheck clean
PASS  SHIP-018  Docs: positioning + comparison + architecture + FAQ present
…

21/22 criteria passing. Blockers: SHIP-017
```

The script always exits 0 — it is a report, not a gate. Ship-readiness
is a human decision, but the blocker list tells you exactly what still
needs attention. To add a criterion, append a `SHIP-<id> | <name> |
<shell-check>` row to [`docs/ship-criteria.md`](./docs/ship-criteria.md)
and re-run.

## FAQ

Full troubleshooting list — install, verify/judge gates, the loop, the TUI,
and the state DB — lives in [`docs/faq.md`](./docs/faq.md). Three entries
below as a teaser.

**Something isn't working — where do I start?**
Run `batonq doctor`. It walks five categories — Binaries, Installation, State,
Scope, Live — and prints `✓ / ⚠ / ✗` per row with a `fix:` hint on every
non-pass. Exit code is 0 when nothing critical is wrong, 1 otherwise. The
output is designed to paste straight into a bug report. Doctor is read-only:
it never edits settings, recreates the DB, or touches your tasks.

**How does this differ from Claude Squad / ccswarm?**
Claude Squad and ccswarm are workspace orchestrators: they own the tmux
layout, the agent lifecycle, and the overall mental model. batonq is the
opposite end of the design space — a single binary wrapping a shared queue
and a file lock, meant to be composed with whatever you already use. If you
want a product, use Squad. If you want a primitive, use batonq.

**An agent marked a task `done` without actually doing the work.**
The TUI flags this as `cheat-done` — a done task where `verify_cmd` is set but
`verify_ran_at` and `judge_ran_at` are both null, meaning the agent closed
the claim past the gate. Confirm on the DB:

```sh
sqlite3 -header -column ~/.claude/batonq/state.db \
  "SELECT external_id, status, verify_cmd, verify_ran_at, judge_ran_at
     FROM tasks WHERE external_id='<id>';"
```

See [`docs/faq.md`](./docs/faq.md) for the re-queue SQL, the `judge:` failure
playbook, install recovery, two-loop coordination, and the rest.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and PRs are welcome —
especially around the hook (correctness, latency), the TUI (usability), and
docs. Keep changes unix-shaped and small.

Design context lives in [`docs/`](./docs/):
[positioning](./docs/positioning.md) (hero rewrite rationale),
[comparison](./docs/comparison.md) (vs. Claude Squad / ccswarm),
[architecture](./docs/architecture.md) (mermaid diagrams),
[ship-criteria](./docs/ship-criteria.md) (release checklist),
[tui-ux-v2](./docs/tui-ux-v2.md) (TUI spec).

## License

[MIT](./LICENSE) © 2026 Fredrik Salberg
