# Ship criteria — batonq v0.2 end-goal

This file is the **source of truth** for what "ship-ready" means. It is a
machine-checkable contract: each row below is one assertion that
`scripts/check-ship.sh` runs as a shell command, turning the end-goal into
a hard PASS/FAIL report rather than a vibe.

## How to read a row

```
SHIP-<id> | <short name> | <shell-check>
```

- Pipe-separated, one assertion per line.
- Lines starting with `#` are comments, ignored by the parser.
- `<shell-check>` is executed from the repo root with a 60s timeout.
- Exit 0 → PASS. Any non-zero exit (or timeout) → FAIL.
- Keep checks concrete (`grep`, `test`, exit codes). No vague
  "looks good" predicates — they rot immediately and do not survive
  judge review.

## How to run it

```sh
scripts/check-ship.sh       # report mode, always exits 0
batonq ship-status          # wrapper — same output via the CLI
```

The script is **report-mode only**: it always exits 0. Gating on
ship-readiness is a human call, not a hook. Use the summary line at the
bottom (`X/Y criteria passing. Blockers: <ids>`) to decide.

## Adding a new criterion

1. Pick the next free `SHIP-<id>` (zero-padded, 3 digits).
2. Name it in the present tense (`README anti-juks tagline present`).
3. Write the shortest deterministic shell check that fails if the
   criterion is absent and passes if it is present. Prefer `grep -q`,
   `test`, and `python3 -c 'import yaml; yaml.safe_load(...)'` over
   running the whole test-suite.
4. If a check cannot be written without side effects, write it anyway —
   but keep its runtime under 60s.
5. If the check asserts on a commit subject (`git log ... | grep ...`),
   use `git_commits_since_claim` or `git log --since="$BATONQ_CLAIM_TS"`
   instead of `git log -1`. `HEAD` may not belong to your task in
   multi-agent setups — a peer loop can land a commit between your
   `done` call and the gate running, which makes `git log -1` flake.
   See `docs/faq.md` for the full rationale.

## Criteria

```
# ── Basics — the table stakes that make this a product at all ────────────────
SHIP-001 | README anti-juks tagline present | grep -q "Stop AI coding agents from faking test results" README.md
SHIP-002 | install.sh shell-syntax valid | sh -n install.sh
SHIP-003 | install.sh uses strict mode and chmods binaries | grep -qE "set -eu?$|set -euo pipefail" install.sh && grep -q "chmod +x" install.sh
SHIP-004 | Linux/Darwin compat shim committed | test -f src/batonq-platform-compat.sh && grep -qE "Darwin|Linux" src/batonq-platform-compat.sh
SHIP-005 | Coverage threshold ≥70% in bunfig | grep -qE "coverageThreshold.*line.*0\.7" bunfig.toml
SHIP-006 | CI workflow yaml parses and tests both OSes | python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); sys.exit(0 if 'ubuntu-latest' in str(d) and 'macos-latest' in str(d) else 1)"
SHIP-007 | CI runs bun test + shellcheck | grep -q "bun test" .github/workflows/ci.yml && grep -q "shellcheck" .github/workflows/ci.yml
# ── Track A — TUI v2 (alert lane / current-task card / badges / feed / drill) ─
SHIP-008 | Track A §1 alert lane module | test -f src/alerts.ts && test -f src/alert-lane.tsx && grep -qE "juks-done|juks_done|verify_ran_at IS NULL" src/alerts.ts
SHIP-009 | Track A §2 current-task card module | test -f src/current-task-card.tsx && grep -qE "elapsed|idle" src/current-task-card.tsx
SHIP-010 | Track A §3 tasks panel carries verify/judge badges | grep -qE "✓V|⚠|badge" src/tui-panels.tsx
SHIP-011 | Track A §4 live feed merges loop+events+git | test -f src/live-feed.ts && grep -qE "\\[loop\\]|\\[evt\\]|\\[git\\]" src/live-feed.ts
SHIP-012 | Track A §5 drill-down overlay component | test -f src/drill-down.tsx && grep -qE "verify_cmd|judge_cmd|Esc|escape" src/drill-down.tsx
# ── Track B — CLI gates & coordination primitives ────────────────────────────
SHIP-013 | --skip-verify / --skip-judge rejected (gates mandatory) | grep -qE "skip-verify.*skip-judge|no longer accepted|Gates are mandatory" src/agent-coord
SHIP-014 | judge agent wired into done-flow | grep -q "runJudge" src/agent-coord && grep -q "runJudge" src/tasks-core.ts
SHIP-015 | batonq init first-run wizard shipped | grep -qE 'case .init' src/agent-coord && test -f tests/init.test.ts
# ── Track C — Infra: tests, coverage, cross-platform, installer ──────────────
SHIP-016 | Test suite green under bun test | bun test 2>&1 | tail -40 | grep -qE "^\\s*[0-9]+ pass" && ! bun test 2>&1 | tail -40 | grep -qE "^\\s*[1-9][0-9]* fail"
SHIP-017 | TypeScript typecheck clean | bunx tsc --noEmit
# ── Track D — Docs & positioning ─────────────────────────────────────────────
SHIP-018 | Docs: positioning + comparison + architecture + FAQ present | test -s docs/positioning.md && test -s docs/comparison.md && test -s docs/architecture.md && grep -q "## FAQ" README.md
# ── Viral V1–V4 — the stuff that makes people click ──────────────────────────
SHIP-019 | V1 README hero reframed around anti-juks receipts | grep -qE "juks|fake|fabricated|receipts" README.md
SHIP-020 | V2 demo gif checked in and referenced in README | test -s demo/intro.gif && grep -q "intro.gif" README.md
SHIP-021 | V3 juks-detection scorecard published with results | test -s evals/results/2026-04-24-juks-detection.md && grep -qiE "scenario|verdict|PASS|FAIL" evals/results/2026-04-24-juks-detection.md
SHIP-022 | V4 comparison table links from README | test -s docs/comparison.md && grep -q "comparison.md" README.md
```
