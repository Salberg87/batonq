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
  tasks/                       # 5 JSON task specs (bug-fix matrix)
    juks/                      # + 5 JSON specs for cheat-detection scenarios
  fixtures/buggy-cli/          # shared Node.js CLI skeleton with intentional bugs
  fixtures/juks-001-…/         # one tiny fixture per cheat scenario
  harness.ts                   # runs each task × variant, writes JSONL
  compare.ts                   # aggregates last N runs, prints a table
  juks-detection.ts            # cheat-detection runner (deterministic, no LLM)
  harness.test.ts              # exercises harness with a mock claude
  compare.test.ts              # exercises compare with synthetic rows
  juks-detection.test.ts       # exercises juks runner against real fixtures
  results/                     # JSONL outputs (gitignored) + checked-in
                               # *-juks-detection.md scorecards
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

## Results

The juks-detection runner is fully deterministic (no LLM calls — the
cheats are hard-coded JS against fixed fixtures) so its scorecard is
checked into the repo. Latest run:

- **2026-04-24 — [`results/2026-04-24-juks-detection.md`](./results/2026-04-24-juks-detection.md)** — 5/5 cheats blocked by batonq's verify gate; bare `claude -p` would have closed all 5 silently.

Re-generate with:

```bash
bun run evals/juks-detection.ts
```

Each scenario lives as one JSON in `tasks/juks/` paired with a hard-coded
"cheat" behavior in `juks-detection.ts`. The cheat runs against a fresh
fixture workspace; we then record what each variant would conclude
(gates-on / gates-off) and a one-line verdict per row. The receipts
table at the bottom of each scorecard records the verify exit code and
stderr per scenario.

## Why the bug-fix harness is preliminary

The juks-detection scorecard above is real (deterministic). The bug-fix
matrix (`harness.ts` against `tasks/*.json`) is still a **scaffold**:

- The "judge" in the default spawner is a placeholder — it just checks
  that the diff is non-empty. To get a real signal, replace `defaultJudge`
  in `harness.ts` with something that actually calls an LLM against
  `judge_prompt` and the diff.
- The 5 bug-fix tasks are synthetic — all bugs live in one hand-rolled
  CLI fixture, and are chosen for ease of verification, not for
  representative difficulty.
- There is no statistical rigor: no seeds, no multi-run averaging wired
  into the default invocation, no significance testing. `compare.ts` only
  groups and averages.
- A "real" evaluation would integrate
  [SWE-bench](https://www.swebench.com/) or a similar curated benchmark,
  pin a claude-code version, and run each task many times per variant.
  That is deliberately future work.

Treat numbers from `harness.ts` as a smoke signal for wiring, not a
claim about batonq's effect on agent quality. The juks-detection results
are stronger because every input and gate is reproducible — they only
say "the gate fires when we make it fire," but that's the load-bearing
claim batonq makes.
