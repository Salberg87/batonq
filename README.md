<p align="center">
  <img src="./docs/logo.svg" alt="batonq" width="120" height="120">
</p>

![CI](https://github.com/{placeholder}/batonq/actions/workflows/ci.yml/badge.svg)

<h1 align="center">batonq</h1>

<p align="center"><strong>A baton queue for parallel agents.</strong></p>

---

## What it is

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

## Install

Requires [Bun](https://bun.sh) (≥ 1.0).

```sh
git clone https://github.com/fsalb/batonq.git
cd batonq
bun install
export PATH="$PWD/bin:$PATH"
```

Or install the three binaries directly to a directory on your `PATH`:

```sh
install -m 0755 src/agent-coord     ~/.local/bin/batonq
install -m 0755 src/agent-coord-hook ~/.local/bin/batonq-hook
install -m 0755 src/agent-coord-loop ~/.local/bin/batonq-loop
```

## Quickstart

1. Write tasks to `~/DEV/TASKS.md`:

   ```md
   ## Pending

   - [ ] **any:infra** — describe the task here
   - [ ] **MyRepo** — repo-scoped task
   ```

2. In each terminal tab you want to dedicate:

   ```sh
   cd ~/DEV/MyRepo
   batonq-loop
   ```

3. Agents pick tasks, work, mark done. Watch progress:

   ```sh
   batonq tasks
   ```

## Commands

| Command                 | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `batonq pick`           | Claim the next task for the current cwd's repo (or `any:*`). |
| `batonq pick --any`     | Claim any pending task regardless of repo scope.             |
| `batonq done <id>`      | Mark a claimed task done. Runs `verify:` gate if present.    |
| `batonq abandon <id>`   | Release a claim so another agent can pick it.                |
| `batonq tasks`          | List all tasks with status.                                  |
| `batonq mine`           | Show tasks claimed by the current session.                   |
| `batonq lock <path>`    | Acquire a file lock. Blocks on conflict.                     |
| `batonq release <path>` | Release a file lock held by the current session.             |
| `batonq sweep`          | Purge expired claims and file locks.                         |
| `batonq status`         | Print overall queue + lock state.                            |
| `batonq tail [-n N]`    | Tail the event log (JSONL).                                  |
| `batonq-hook`           | Stdin-hook binary for Claude Code. See `docs/hooks.md`.      |
| `batonq-loop`           | Fresh-Claude-per-task loop. `cd <repo> && batonq-loop`.      |

## Concepts

- **Sessions** — each running agent registers a session keyed by pid. Claims
  and locks are owned by a session; the session's heartbeat keeps them alive.
- **Tasks** — parsed from `~/DEV/TASKS.md`. Each task gets a stable
  `external_id` derived from repo + body, so editing adjacent lines doesn't
  re-issue IDs.
- **Pick scope** — inside a git repo, `pick` matches `**<RepoName>**` or
  `**any:***`; outside a repo, only `any:*`.
- **Verify gates** — a `verify:` line under a task runs a shell command on
  `done`. Non-zero exit keeps the task claimed with the error captured.
- **Judge agent** — an optional second-layer LLM review (`judge:` line). Only
  `PASS` lets the task close; `FAIL` leaves it claimed with the verdict.
- **Hooks** — `batonq-hook` plugs into Claude Code's PreToolUse / PostToolUse
  hooks. Layer 1 appends measurement events; layer 2 enforces file locks so
  parallel agents can't write to the same path.

## Philosophy

Coordination is a primitive. The queue is a table, the lock is a file, the
event log is a JSONL. Everything is inspectable with `cat`, `sqlite3`, `jq`.
There's no server to start, no workspace to enter, no DSL to learn. batonq
does one thing: it makes sure the right agent is holding the baton.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2026 Fredrik Salberg
