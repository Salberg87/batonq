# batonq v2 — Design Docs

## Intent

v1 ships work. v2 makes the work auditable. The pain v2 addresses is concrete: agents that pass `verify_cmd` by faking it, agents that get SIGTERM'd mid-edit and leave uncommitted work for the next claimant, agents whose reputation we can't query because v1 has no per-`(provider, model_version, task_class)` table to query, and a trace oracle (`events.jsonl`) that any Bash call can `echo >>` into. The dispatcher rewrite (Track D) replaces the bash `agent-coord-loop` with a TypeScript state machine that owns git and the wall-clock; trace hardening (Track B) makes `events.jsonl` HMAC-chained so the verify-gate has a load-bearing oracle to read; reputation (Track A) replaces the regex `ROUTING_TABLE` with a Beta-Binomial CI per cell; falsification (Track C) makes "is this agent lying?" the cheapest experiment we can afford. What stays the same: the `tasks` / `sessions` / `claims` schema, the `batonq pick / claim / done / abandon` CLI surface, the per-cwd loop model, the PreToolUse verify-gate (promoted, not replaced). User-facing difference: dispatch is single-runner by default but escalates to replication for `architecture` and `stakes=high`; routing decisions cite a credible interval, not a hardcoded model name; partial work survives a kill on a `batonq/wip/<eid>/<n>` branch instead of vanishing.

## The 4 Tracks

### Track A — Reputation

Frame: PEDAL (interval-valued confidence) + Affonso (per-`model_version` cells, fast decay) + Avalon (role-conditional). Deliverable: migration `0007_reputation.sql` adding `rep_outcomes` (append-only audit) and `rep_aggregates` (Beta(α,β) per `(provider, model_version, role, task_class)` cell), plus the `rep_scores` view that routing reads. Dependencies: needs Track B's chain so `witness_ref` pointers are forge-resistant; consumes Track D's `task_state` + `task_transitions` for terminal-event triggers; constrains Track C's replication eligibility ("low-rep" is a query against this table). See [`track-a-reputation.md`](./track-a-reputation.md).

### Track B — Trace Hardening

Frame: the MCP Pitfall Lab paper assumed a trusted trace producer; we don't have one. Deliverable: hash-chained log with HMAC-keyed entries (hybrid). Each `events.jsonl` line gains `prev` and `mac` fields; the chain head is mirrored to `~/.claude/batonq/chain-head` and the new SQLite `chain_state` table; key lives at `~/.claude/batonq/chain.key` (mode 0400, `chflags uchg`). `countMutatingEventsSinceClaim` becomes a two-pass `verifyChain` returning `AuditResult`. Dependencies: nothing upstream — it's the foundation. Track A's audit columns and Track D's transitions both write through the chained appender. See [`track-b-trace-hardening.md`](./track-b-trace-hardening.md).

### Track C — Falsification

Frame: "what is the cheapest experiment that would prove the agent is lying, if it is?" Deliverable: `shouldReplicate(task, runnerRep, budget)` decision function, four-category honeypot taxonomy (impossible, contradictory-spec, trap-detection, silent-noop), a `runner_sandbagging_probes` table for the A/B framing probe, the canary stanza appended to every prompt, and `docs/v2/verify-recipes.md`. Dependencies: reads Track A's `rep_aggregates` for the runner-rep input; runs inside Track D's state machine (replication is a state, not a special case); audit pointers chain through Track B. See [`track-c-falsification.md`](./track-c-falsification.md).

### Track D — Control Loop

Frame: Liu & Meng (stop iterating when EIR rises) + McAndrews (refiner > generator, early-stop critical) + Affonso (per-provider control parameters). Deliverable: `src/dispatcher.ts` (TypeScript, replaces bash `agent-coord-loop`), `task_state` column, `task_transitions` audit table, the auto-commit-before-die hook, the nine-signal in-process watchdog. Dependencies: Phase 1 (auto-commit-before-die) shipped 2026-04-27 ahead of the rest. The standalone `agent-coord-loop-watchdog` is **deleted** once D lands. Tracks A/B/C all hook their writes through D's transitions. See [`track-d-control-loop.md`](./track-d-control-loop.md).

## New SQL Tables

| Table              | Purpose                                                                                | Track |
| ------------------ | -------------------------------------------------------------------------------------- | ----- |
| `rep_outcomes`     | append-only row per terminal task event; single source of truth for reputation         | A     |
| `rep_aggregates`   | materialised Beta(α,β) + counts per `(provider, model_version, role, task_class)` cell | A     |
| `chain_state`      | belt-and-braces mirror of `chain-head` for cross-check between disk and DB             | B     |
| `task_state`       | explicit per-task lifecycle column (no inferring from joined columns)                  | D     |
| `task_transitions` | audit row per state edge (trigger event, decision criterion, signal source)            | D     |

## Phased Rollout

### Phase 1 — D, auto-commit-before-die (shipped 2026-04-27)

Prerequisites: none. Deliverable: `pre-die-hook` in `src/dispatcher.ts` that records `pre_attempt_sha`, on SIGTERM/watchdog/dirty-exit creates `batonq/wip/<eid>/<n>` and `git reset --hard pre_attempt_sha` to leave the active branch clean. Ship-criterion: SIGTERM during a 12-min attempt produces a wip branch and leaves the working tree clean for the next `batonq pick`. Already shipped.

### Phase 2 — B, trace hardening

Prerequisites: Phase 1 (dispatcher owns the writer process so the key path can be redacted from agent env). Deliverable: HMAC-chained `events.jsonl`, `verifyChain`, `chain_state` table, migration that seals the v1 prefix as a single hashed `v2_chain_init` boundary event, `batonq trace verify` and `batonq trace repair` operator commands. Ship-criterion: `echo '<fake event>' >> events.jsonl` produces an `AuditResult.tampered` from `verifyChain`, the verify-gate denies on it, and `batonq trace repair` is the only path back.

### Phase 3 — A, reputation

Prerequisites: Phase 2 (witness pointers must chain). Deliverable: migration `0007_reputation.sql`, the four audit columns on `tasks`, the writer in `tasks-core.ts` next to `markDone`/`markLost`, the nightly recomputation job, the `routeTaskV2` wrapper around the existing `detectTaskType`. Ship-criterion: `rep_aggregates` rebuilds bit-identical from `rep_outcomes`; routing falls through the §4 fallback chain on cell sparsity; cold-start `(provider, model_version)` cells force `replicated-2of3` for their first 8 outcomes.

### Phase 4 — C, falsification

Prerequisites: Phase 3 (replication policy reads runner-rep). Deliverable: `shouldReplicate`, four honeypot categories with per-category `verify_cmd` shapes, the canary stanza in `prompt-prepend.ts`, `runner_sandbagging_probes`, the H/R/S-track scorecards alongside the existing V-track. Ship-criterion: a runner with `done > 0` on any honeypot category is demoted for 7 days; canary triggers fail every dispatched task; replication respects the provider-diversity rule (≥2 of the 4 providers per round).

## Cross-Track Conflicts (Resolved)

Three places where the tracks disagreed; the synthesiser picked.

**Replication policy.** Track A scoped replication around "cold-start cells" (first 8 outcomes for a new `(provider, model_version)` × class). Track C scoped it around `architecture`/`implementation`/`refactor` × `stakes=high` OR low-rep. **C wins.** Cold-start is a special case OF "low rep, normal stakes" in C's matrix — Track A's cold-start rule is preserved as the implementation of one cell, not as a parallel policy. The `shouldReplicate` function owns the decision; the cold-start escalation lives inside it.

**Default replication k.** Track A defaulted to `k=2-of-3`. Track C defaulted to `k=2-of-2` escalating to `2-of-3` only on disagreement. **C wins.** The 2-of-2 floor is cheaper (2.2× vs 3.4× spend factor) and the disagreement-triggered escalation catches the case 2-of-3 is meant to catch. Track A's "first 8 outcomes for cold-start" still uses 2-of-3 explicitly because the goal there is sample-rate, not consensus.

**Watchdog deletion.** Track D §6 deletes `agent-coord-loop-watchdog` ("its job is fully absorbed by the dispatcher"). Tracks A and B both reference watchdog-killed signals in their schemas. **D wins, but only after D lands.** Phase 2 and Phase 3 keep reading `watchdog_killed` from whatever process is killing — the standalone watchdog during Phase 1, the dispatcher's in-process timer once Phase 4's prerequisite (D fully shipped) is met. The signal name doesn't change; the producer does.

## What's NOT in v2

- **Closed-weight elicitation.** No training-time access, no logit inspection, no "ask the model if it's lying" probe that would require model cooperation. The sandbagging probe (§4 of Track C) is the strongest move available — observable behavioural delta between framings — and even that is a weak signal at 30 probes per runner.
- **Agents that bypass Claude Code's hook system.** `codex exec`, `gemini`, `opencode` produce no `PostToolUse` event. The verify-gate caveat from CLAUDE.md hard rule #2 stands. Trace hardening, reputation, and falsification are Claude-runner-load-bearing for the in-process signals; cross-tool dispatch leans entirely on `verify_cmd` + the dispatcher's nine-signal watchdog.
- **Runners we haven't measured yet.** Per Track D §3, `codex`, `gemini/flash`, and `opencode` ship with `max_retries=0` and EIR thresholds marked placeholder until ~2 weeks of real verify-fail-retry data is collected. v2 ships the schema for per-provider control parameters; v2.1 ships the measured values.
- **Sybil providers and cross-replicate collusion** (Track A §6). The dispatch is ours, so the cell key is ours; defending against an operator editing the DB directly is out of scope. Closed-weight subprocesses with no shared channel can't collude without operator collusion, and the second is unsolvable from inside the queue.
- **SQLite row-level integrity** (Track B §6). Same hardening shape as the JSONL chain (HMAC each row, chain by `claim_id`) but a separate doc. The verify-gate today reads `tasks.claimed_at` unprotected; closing this is a follow-on, not v2.
- **Hook binary integrity.** `chflags uchg` on `~/.local/bin/batonq-hook` and the install-time pinned hash are a Track-A-install-integrity item, not a trace-hardening item. Out of scope for v2 the trace pass; in scope for whoever owns install.sh next.
