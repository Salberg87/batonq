# Contributing to batonq

Thanks for considering a contribution! batonq is small and unix-shaped on
purpose — keep that in mind when proposing changes.

## Development setup

```sh
git clone https://github.com/fsalb/batonq.git
cd batonq
bun install
```

The three binaries live in `src/` and are run directly via shebang
(`#!/usr/bin/env bun`). Wrappers in `bin/` just `exec` the src files so the
repo can be used as a bin target by `npm`/`bun link`.

## Running tests

```sh
bun test
```

Tests use an in-memory SQLite (`new Database(":memory:")`) so they run
hermetically. No external services required.

## Typechecking

```sh
bun run typecheck
```

## Code style

- TypeScript, `strict: true`.
- No dependencies beyond Bun built-ins and the types already in `package.json`.
  New runtime deps need strong justification.
- Shell scripts start with `set -euo pipefail`.
- Follow existing conventions — match the tone of surrounding code.

## Commit messages

Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`,
`ci:`. Keep subjects under 72 chars. Body optional but welcome for non-obvious
changes.

## Pull requests

1. Fork, branch off `main` (`feat/<slug>` or `fix/<slug>`).
2. Add tests for new behavior.
3. `bun test` + `bun run typecheck` must pass.
4. Open a PR with a clear description of the change and the motivation.

## Reporting bugs

Open an issue with:

- What you expected.
- What happened.
- Minimal repro (`TASKS.md` snippet + command).
- `batonq tail -n 50` output if relevant.

## Scope

batonq is coordination-as-a-primitive. Features that would turn it into a
workspace/orchestrator (tmux management, container spawning, UI dashboards
beyond the TUI, per-agent prompts) are out of scope — those belong in the
tools that _use_ batonq.

Things that are in scope:

- Making the queue, locks, and event log more robust.
- Better observability (TUI, JSON output modes).
- Integrations with existing agent runners (Claude Code, aider, etc.).
- Cross-machine coordination (if it stays optional and boring).
