# Comparison — batonq vs related tools

Honest side-by-side with the other parallel-Claude-agent tools people
actually reach for. The table is a snapshot from 2026-04-24 based on each
project's README/docs; anywhere a claim wasn't documented I've marked
`unknown` rather than guess.

## Feature matrix

| Feature                  | batonq               | claude-squad         | crystal                | conductor            | manual `/loop` scripts | ccswarm             |
| ------------------------ | -------------------- | -------------------- | ---------------------- | -------------------- | ---------------------- | ------------------- |
| Parallel agents          | yes (shared queue)   | yes (worktree/tmux)  | yes (worktree)         | yes (worktree)       | yes (by hand)          | yes (worktree)      |
| Coordination model       | shared queue + locks | worktree isolation   | worktree isolation     | worktree isolation   | none                   | worktree isolation  |
| Peer-visible file locks  | yes (`flock(2)`+DB)  | n/a (isolated)       | n/a (isolated)         | n/a (isolated)       | no                     | n/a (isolated)      |
| `verify:` gate on `done` | yes                  | no                   | no                     | no                   | no                     | no                  |
| Judge-LLM review gate    | yes (`judge:` dir.)  | no (human diff view) | no (human diff view)   | no (human diff view) | no                     | unknown             |
| Anti-juks hardened       | yes (named goal)     | no                   | no                     | no                   | no                     | no                  |
| Reproducible eval rig    | yes (`evals/`)       | no                   | no                     | no                   | no                     | no                  |
| TUI                      | yes (Ink)            | yes (Bubbletea)      | no (Electron GUI)      | no (native macOS)    | no                     | yes (terminal UI)   |
| Standalone install       | single binary        | single binary        | desktop app            | macOS-only app       | n/a (bash)             | cargo / release bin |
| Composable with anything | yes (unix verbs)     | no (owns workspace)  | no (owns workspace)    | no (owns workspace)  | yes (it's just bash)   | no (owns workspace) |
| Status (2026-04-24)      | v0.1.x, active       | active, polished     | deprecated → Nimbalyst | active, commercial   | none                   | active              |

Sources: [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad),
[stravu/crystal](https://github.com/stravu/crystal),
[conductor.build](https://www.conductor.build/),
[nwiizo/ccswarm](https://github.com/nwiizo/ccswarm).
"manual `/loop` scripts" is the `while true; claude -p "$prompt"; sleep
60; done` pattern batonq itself replaces — no canonical repo.

## What batonq does that nobody else does

Every other tool on this list answers the question _"how do I run many
agents in parallel without them stepping on each other?"_ with
**isolation** — give each agent its own git worktree, let them work in
peace, merge later. That's a clean design and it works. But isolation
doesn't catch an agent that marks a task `done` without doing the work,
because `done` is just a log line.

batonq is the only tool that treats `done` as a **gate** instead of a
claim. The `verify:` directive runs the user-supplied command inside
`batonq done <id>` and keeps the claim open on any non-zero exit — the
agent literally cannot close past a failing test. The optional `judge:`
directive adds a second LLM pass over the diff, and every exit code +
stderr line lands in `events.jsonl` as a grep-able receipt. That gate,
plus the `evals/` harness that measures whether it actually changes
outcomes on a fixed task set, is the whole point of the project.

It's also the only one of the six that ships as a unix-shaped
_primitive_ rather than a workspace orchestrator: `pick`, `done`,
`abandon`, `lock`, `release`, backed by SQLite + `flock(2)`. You compose
it with whatever loop you already run — bash, Claude Code, aider, tmux,
cron — instead of adopting its workspace model.

## Where the others are honestly better

- **claude-squad** has more polish, a bigger community, and a
  battle-tested tmux + git-worktree workflow. If you want a product with
  a cared-for TUI and don't need verify gates, it's the obvious pick.
- **crystal / conductor** win on GUI — diff review in a real window, no
  terminal required, discoverable for teammates who don't live in a
  shell. Conductor is a polished commercial macOS app and looks it.
- **manual `/loop` scripts** win on zero install. If you're running one
  agent against one repo and don't need coordination, ten lines of bash
  is less to maintain than a new binary.
- **ccswarm** has role-based agent types (frontend / backend specialists)
  and session checkpoint/resume — a different axis batonq doesn't try
  to compete on.

Pick the tool that matches the problem you actually have. batonq is
narrow on purpose: it exists because a `done` that skipped the gate was
costing real rework on this machine. If that failure mode isn't in your
loop, you don't need it.
