<p align="center">
  <img src="./docs/logo.svg" alt="batonq" width="140" height="140">
</p>

<h1 align="center">batonq</h1>

<p align="center"><strong>A baton queue for parallel agents.</strong></p>

<p align="center">
  <a href="https://github.com/Salberg87/batonq/actions/workflows/ci.yml"><img src="https://github.com/Salberg87/batonq/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4ADE80.svg" alt="License: MIT"></a>
</p>

---

## 60-second pitch

Running multiple agents against the same repo creates coordination chaos. Two
instances claim the same task. Edits collide on the same file. A crashed run
holds a lock nobody can see. The usual answer — Claude Squad, ccswarm — bundles
coordination inside a full workspace orchestrator: you buy into their tmux
layout, their lifecycle, their mental model. That's a lot of product for what
is, underneath, a shared queue and a file lock.

batonq is a single binary with a handful of unix-shaped verbs: `pick`, `done`,
`abandon`, `lock`, `release`. Under the hood it's SQLite and `flock(2)` — no
daemon to configure, no DSL to learn, no workspace to opt into. It composes
with whatever you already use: Claude Code, aider, a bash loop, a cron job,
tmux panes, git worktrees. Point any number of agents at the same queue and
they politely pass the baton: one picks a task, works it, drops it, the next
one picks the next. Files held by a peer are visible; stale locks expire;
everything is inspectable with `cat` and `sqlite3`.

Think of it as the unix-tool cousin of Claude Squad and ccswarm — the part
you'd reach for when you want coordination as a _primitive_, not a platform.
Pass the baton, finish the leg, drop the baton. Small surface, big leverage,
boring on purpose.

## Demo

```
┌─ batonq ──────────────────────────── tui · refresh 2s · q quit · ? help ─┐
│                                                                          │
│  ┌─ Sessions ──────────────┐  ┌─ Claims ────────────────────────────┐    │
│  │ ● pid 2047  batonq      │  │  51592069  pid 2047  README (1m)    │    │
│  │ ● pid 2113  OrgHub      │  │  7a3b9c14  pid 2113  auth fix (4m)  │    │
│  │ ● pid 2145  any:infra   │  │  e112ff20  pid 2145  CI pipe  (2m)  │    │
│  └─────────────────────────┘  └─────────────────────────────────────┘    │
│                                                                          │
│  ┌─ Tasks ─────────────────────────────────────────────────────────┐     │
│  │ [ ] any:infra  — publish release notes for v0.1.1               │     │
│  │ [~] batonq     — README production-grade (claimed pid 2047)     │     │
│  │ [~] OrgHub     — fix auth redirect loop (claimed pid 2113)      │     │
│  │ [x] any:infra  — GitHub Actions CI workflow                     │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  ┌─ File locks ─────────────────┐  ┌─ Recent events ────────────────┐    │
│  │ README.md       pid 2047 45s │  │ 00:04  pick   51592069         │    │
│  │ auth.ts         pid 2113 2m  │  │ 00:03  lock   README.md 2047   │    │
│  │ workflows/*.yml pid 2145 1m  │  │ 00:02  done   a9f01c3e         │    │
│  └──────────────────────────────┘  └────────────────────────────────┘    │
│                                                                          │
│   q quit · Tab focus · j/k nav · / filter · a abandon · r release · ?    │
└──────────────────────────────────────────────────────────────────────────┘
```

> **TODO:** record a real `docs/screencast.gif` once v0.2 is tagged — capture
> a 3-tab tmux session picking + completing tasks in parallel. Until then,
> the ASCII block above is the placeholder reference for the TUI layout.

## Install

**One-liner (recommended):**

```sh
curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/install.sh | sh
```

The installer checks for `bun` and `jq`, clones the repo, drops the three
binaries into `~/.local/bin/` (or `~/bin/`), merges the Claude Code hooks
into `~/.claude/settings.json` idempotently, and creates the state dirs.
Re-running it is safe — existing hook entries are replaced, not duplicated.

**Manual (if you want to vendor the checkout):**

```sh
git clone https://github.com/Salberg87/batonq.git
cd batonq
bun install
export PATH="$PWD/bin:$PATH"
```

Or install the three binaries directly to a directory on your `PATH`:

```sh
install -m 0755 src/agent-coord      ~/.local/bin/batonq
install -m 0755 src/agent-coord-hook ~/.local/bin/batonq-hook
install -m 0755 src/agent-coord-loop ~/.local/bin/batonq-loop
```

Requires [Bun](https://bun.sh) ≥ 1.0 and `jq` (for the hooks merge).

## Quickstart

**1. Write a task to `~/DEV/TASKS.md`:**

```md
## Pending

- [ ] **any:infra** — add release notes for v0.1.1
```

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
- **Hooks** — `batonq-hook` plugs into Claude Code's PreToolUse and
  PostToolUse hooks. Layer 1 appends JSONL measurement events; layer 2
  enforces file locks, so two parallel agents can't write to the same path.

## Commands

| Command                 | Description                                                                      | Example                            |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| `batonq pick`           | Claim the next task matching the current cwd's repo (or an `any:*` task).        | `batonq pick`                      |
| `batonq mine`           | Show tasks claimed by the current session (pid).                                 | `batonq mine`                      |
| `batonq done <id>`      | Mark a claimed task done. Runs the `verify:` gate if the task has one.           | `batonq done 51592069b22d`         |
| `batonq abandon <id>`   | Release a claim so another agent can pick the task.                              | `batonq abandon 51592069b22d`      |
| `batonq tasks`          | List every task in `~/DEV/TASKS.md` with status.                                 | `batonq tasks`                     |
| `batonq sync-tasks`     | Re-parse `TASKS.md` into the SQLite state immediately (usually automatic).       | `batonq sync-tasks`                |
| `batonq release <path>` | Release a file lock held by the current session.                                 | `batonq release src/app.ts`        |
| `batonq sweep`          | Purge expired claims and file locks whose owning session is gone.                | `batonq sweep`                     |
| `batonq status`         | Print overall queue + lock state as a compact summary.                           | `batonq status`                    |
| `batonq check`          | Health check: schema version, state-db permissions, hook wiring.                 | `batonq check`                     |
| `batonq tail [-n N]`    | Tail the event log (JSONL).                                                      | `batonq tail -n 50`                |
| `batonq report`         | Aggregate measurement events over a time range (`--since`, `--until`, `--json`). | `batonq report --since 2026-04-01` |
| `batonq tui`            | Live ink-based TUI dashboard with sessions, tasks, claims, locks, events.        | `batonq tui`                       |
| `batonq-hook`           | Claude Code PreToolUse / PostToolUse hook. Not invoked manually.                 | (wired by `install.sh`)            |
| `batonq-loop`           | Fresh-Claude-per-task runner. `cd` into a repo, run, and the loop does the rest. | `cd ~/DEV/MyRepo && batonq-loop`   |

## TUI

`batonq tui` opens a live dashboard backed by the same SQLite state. It
refreshes every 2s and gives you five panels — Sessions, Tasks, Claims, File
locks, Recent events.

**Keybinds:**

| Key            | Action                                       |
| -------------- | -------------------------------------------- |
| `q` / `Ctrl-C` | Quit.                                        |
| `Tab`          | Cycle panel focus.                           |
| `j` / `↓`      | Move selection down in focused panel.        |
| `k` / `↑`      | Move selection up in focused panel.          |
| `/`            | Filter rows in focused panel. `Esc` cancels. |
| `a`            | Abandon selected task (Tasks panel only).    |
| `r`            | Release selected lock (Claims panel only).   |
| `?`            | Show full help overlay.                      |

> **TODO:** add `docs/tui.png` once v0.2 ships. The ASCII block at the top of
> this README is indicative of the layout; a real screenshot will live here.

## Architecture

```
       ┌─ ~/DEV/TASKS.md (human source of truth)
       │
       ▼
┌─────────────┐   sync    ┌──────────────────────────────┐
│ parse tasks │─────────▶│  ~/.claude/                   │
└─────────────┘           │  ├─ agent-coord-state.db     │  SQLite:
                          │  │                           │  sessions, tasks,
                          │  │                           │  claims, locks
                          │  └─ agent-coord-measurement/ │
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
the **SQLite state** (`~/.claude/agent-coord-state.db`, mutated under
transactions), and the **hooks** (`batonq-hook pre|bash|post`, 2-second
timeout, never blocks Claude on its own failure). Everything else is a shell
of unix verbs around those three files.

## FAQ

**How does this differ from Claude Squad / ccswarm?**
Claude Squad and ccswarm are workspace orchestrators: they own the tmux
layout, the agent lifecycle, and the overall mental model. batonq is the
opposite end of the design space — a single binary wrapping a shared queue
and a file lock, meant to be composed with whatever you already use. If you
want a product, use Squad. If you want a primitive, use batonq.

**What happens if an agent crashes mid-task?**
Nothing stays stuck. Each session has a heartbeat; when it stops, its claims
and file locks go stale. `batonq sweep` (or the TUI running in the
background) reclaims them. The task flips back to `pending` and any other
agent with a matching scope can pick it up.

**Can it coordinate across machines?**
Not yet — state lives in a local SQLite DB (`~/.claude/agent-coord-state.db`)
and locks use `flock(2)` on the local filesystem. Cross-machine would need
either a hosted DB + lock service or a syncing agent; that's deliberately
out of scope for v0.x. If you mount `~/.claude` over NFS with working byte
locking you get a janky version of it, but I don't recommend it.

**How much overhead does the hook add?**
The PreToolUse hook runs with a 2s timeout and does a single SQLite SELECT
plus one optional INSERT — sub-millisecond in the common case, dominated by
SQLite startup cost (~1–5ms per invocation). The hook fails open: if it
can't reach the DB, the tool call still runs. Measure it yourself on your
own machine with `batonq report --since ...`.

**How do I debug a failing verify gate?**
Three places to look. First, `batonq tail -n 50` — the `verify-failed`
event carries the exit code and captured stderr. Second, `batonq mine` shows
the task still claimed by you with the last error attached. Third, re-run
the gate by hand (`cd <repo> && <the verify command>`) to see full output.
Abandon with `batonq abandon <id>` once you've investigated.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and PRs are welcome —
especially around the hook (correctness, latency), the TUI (usability), and
docs. Keep changes unix-shaped and small.

## License

[MIT](./LICENSE) © 2026 Fredrik Salberg
