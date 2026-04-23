# batonq micro-eval harness

## What this is

A tiny, throwaway eval rig for empirically comparing two variants of the same
coding-agent invocation on a fixed task set:

- **baseline** — plain `claude -p "<prompt>"` against a fresh fixture repo.
- **batonq** — the same `claude -p` call, but with batonq gates/hooks active
  in the shell environment that invokes it.

The question it tries to answer, over enough runs: does running agents
through batonq's coordination primitives measurably change the outcome on
small, self-contained bug-fix tasks? We measure pass/fail of a scripted
`verify_cmd`, pass/fail of a judge prompt (pluggable), wall-clock time,
files edited, and commits produced.

## Layout

```
evals/
  tasks/                  # 5 JSON task specs
  fixtures/buggy-cli/     # shared Node.js CLI skeleton with intentional bugs
  harness.ts              # runs each task × variant, writes JSONL
  compare.ts              # aggregates last N runs, prints a table
  harness.test.ts         # exercises harness with a mock claude
  compare.test.ts         # exercises compare with synthetic rows
  results/                # JSONL outputs, one file per run (gitignored)
```

Each task JSON has the shape

```json
{
  "id": "...",
  "repo_fixture_path": "fixtures/buggy-cli",
  "prompt": "...",
  "verify_cmd": "...",
  "judge_prompt": "..."
}
```

The harness copies `repo_fixture_path` into a tmpdir, `git init`s it,
commits the fixture once so the agent's work is isolated, then runs the
chosen variant, runs `verify_cmd` inside the tmpdir, collects the diff,
calls the judge, and writes one JSONL row per (task, variant).

## How to run

Prereqs: `bun`, `git`, `node`, and — for a real (non-mock) run — the
`claude` CLI on `$PATH`.

```bash
# Run the whole matrix (baseline + batonq) for all 5 tasks:
bun run evals/harness.ts

# Only one variant:
bun run evals/harness.ts --variant=baseline

# Aggregate the last 5 result files:
bun run evals/compare.ts --last=5
```

Unit tests that exercise the harness with a mock claude run as part of the
regular suite:

```bash
bun test
```

The harness itself is **not** part of CI. It spawns a real subprocess per
task, which is slow and non-deterministic, so anything named `*.eval.ts`
(and the harness entry point invoked via `bun run`) is left to manual
operators. `bun test`'s default glob (`*.test.*`) does not pick up
`*.eval.ts` or `harness.ts`/`compare.ts`.

## Why this is preliminary

This is a **scaffold**, not an eval. In particular:

- The "judge" in the default spawner is a placeholder — it just checks
  that the diff is non-empty. To get a real signal, replace `defaultJudge`
  in `harness.ts` with something that actually calls an LLM against
  `judge_prompt` and the diff.
- The 5 tasks are synthetic — all bugs live in one hand-rolled CLI
  fixture, and are chosen for ease of verification, not for representative
  difficulty.
- There is no statistical rigor: no seeds, no multi-run averaging wired
  into the default invocation, no significance testing. `compare.ts` only
  groups and averages.
- A "real" evaluation would integrate
  [SWE-bench](https://www.swebench.com/) or a similar curated benchmark,
  pin a claude-code version, and run each task many times per variant.
  That is deliberately future work.

Treat any numbers this produces as a smoke signal for wiring, not a
claim about batonq's effect on agent quality.
