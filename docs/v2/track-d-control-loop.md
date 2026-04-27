# Track D — Per-Task Control Loop & Stopping Rules

Status: design, not yet implemented. Targets v2 dispatcher rewrite.
Grounding: Liu & Meng (self-correction stopping rule), McAndrews (refiner > generator, early-stop critical), Affonso (per-provider behaviour is structural, not a tunable).

---

## 1. State machine

Per-task lifecycle. Each transition has a single trigger (event) and a decision criterion (gate). Implemented as an explicit `task_state` column in the DB plus a `task_transitions` audit table — no inferring state from joined columns.

```
                         [queued]
                            │ pick → claim succeeds + cwd matches
                            ▼
                        [claimed]
                            │ runner spawn (agent-run) starts
                            ▼
                        [working]
              ┌─────────────┼─────────────┐
              │ runner exit │ gtimeout    │ liveness signal stalls
              │  code = 0   │  fires      │  (events.jsonl stale,
              │             │  (SIGTERM)  │   no commit, no edit)
              ▼             ▼             ▼
        [submitted]    [pre-die-hook] [pre-die-hook]
              │             │             │
              │             ▼             ▼
              │        commit-or-park: wip branch + state := submitted-partial
              │             │             │
              ▼             ▼             ▼
        [verifying]    [verifying]   [verifying]
              │ runVerify(verify_cmd)
              ▼
       ┌──────┴──────────┬──────────┬──────────┐
       │ exit 0          │ exit ≠0  │ exit ≠0  │ exit ≠0
       │                 │ retries  │ retries  │ verify itself
       │                 │ < cap    │ ≥ cap    │ malformed
       ▼                 ▼          ▼          ▼
    [pass]           [retry]   [escalate]  [abandon]
                         │          │          │
                         │          ▼          │
                         │     refiner-spawn  │
                         │     (different      │
                         │      runner+model)  │
                         │          │          │
                         └──────────┴──> back to [working]
                                        OR
                                  [replicate] (n parallel attempts,
                                   first to verify wins, others
                                   killed; only when EIR per provider
                                   exceeds threshold)
```

Terminal states: `pass`, `abandon`, `escalate-human` (parked on a wip branch with a note in TASKS.md).

Key rule (Liu & Meng): we only re-enter `working` from `retry` when the provider's measured EIR (probability the next attempt makes a correct answer wrong) is below threshold for that role. Otherwise we skip straight to `escalate` and switch runner.

---

## 2. Stopping rules

Concrete numbers. Tunables live in `~/.claude/batonq/control.toml`; values below are defaults pending real EIR data.

| Signal                                   | Default                                        | Hard cap              | Notes                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Max retries (same runner+role)           | 1                                              | 2                     | McAndrews: every refine iteration is net-negative without early stop. One retry, then flip role.                                                                             |
| Max wall-time per attempt                | 12 min                                         | 20 min                | Down from current 20 min — see §6. Codex/opencode get 8/15.                                                                                                                  |
| Max wall-time per task (sum of attempts) | 30 min                                         | 45 min                | Subscription cost cap. After this, `escalate-human`.                                                                                                                         |
| Max edits per attempt                    | 25 files / 800 LoC                             | 50 files / 1500 LoC   | Soft signal of run-away refactor; triggers verify even if agent hasn't called done.                                                                                          |
| Token budget per task (proxy)            | 5h-bucket Δ ≤ 8%                               | Δ ≤ 12%               | Subscription CLIs don't expose tokens. We sample `batonq burn` before/after each attempt. Hard cap aborts the attempt.                                                       |
| Refiner escalation trigger               | verify-fail #1 + diff is "near-correct"        | always after retry #1 | "Near-correct" = verify_cmd exit ≠ 0 but ≥80% of grep-anchors pass (heuristic in `task-schema.ts`). Far-off → `escalate` straight to a different runner, not a refiner pair. |
| EIR sampling window                      | last 50 verify-fail retries per (runner, role) | —                     | Used to gate `retry` vs `escalate`. Stored in `runner_stats` table.                                                                                                          |

Token-budget enforcement against subscription CLIs: we cannot read live token use from claude/codex/gemini stdout. Surrogate is the 5h-bucket %-delta from `batonq burn`. Sampled at attempt-start and again every 60s during the run via the watchdog (now repurposed, see §4). When Δ exceeds the per-task cap mid-run we SIGTERM the runner and transition to `[pre-die-hook]`.

---

## 3. Per-provider control parameters

Each runner gets its own row. Values are placeholders until §6's EIR measurement runs for ~2 weeks. The table is the schema, not the final numbers.

| Runner            | Max retries (worker) | Max retries (refiner) | EIR threshold                             | Refiner-pair (when this runner fails) | Replication default | Wall-time per attempt |
| ----------------- | -------------------- | --------------------- | ----------------------------------------- | ------------------------------------- | ------------------- | --------------------- |
| `claude` (sonnet) | 1                    | 1                     | ≤ 1.0%                                    | claude/opus refiner                   | off                 | 12 min                |
| `claude` (opus)   | 1                    | 0                     | ≤ 0.5%                                    | escalate-human                        | off                 | 18 min                |
| `codex`           | 0                    | 0                     | ≤ 2.0% (placeholder, suspect higher)      | claude/sonnet refiner                 | off                 | 8 min                 |
| `gemini` (flash)  | 0                    | 0                     | ≤ 5.0% (placeholder)                      | claude/sonnet refiner                 | off                 | 8 min                 |
| `gemini` (pro)    | 1                    | 0                     | ≤ 2.0%                                    | claude/opus refiner                   | off                 | 15 min                |
| `opencode`        | 0                    | 0                     | unknown — measure before enabling retries | claude/sonnet refiner                 | off                 | 8 min                 |

Reasoning per cell:

- **claude/sonnet**: best-measured runner in our logs, lowest observed regression on retry, default worker. Retries flow to opus (refiner role), not back to sonnet — McAndrews "specialist > generalist".
- **claude/opus**: expensive per attempt, low regression risk, but no point retrying opus with opus. Failure → human.
- **codex**: limited evidence. Affonso warns we cannot transfer claude's retry-safety to a different vendor. Treat retries as net-negative until proven otherwise.
- **gemini/flash**: cheap and fast, but observed to hallucinate file paths. No retry; if it fails, hand off to claude/sonnet who will re-read the repo.
- **gemini/pro**: 1M context useful for bulk_analysis; one retry but no replication (expensive at 1M).
- **opencode**: too little data. EIR unknown means no retries — Liu & Meng explicitly: don't iterate when the regression rate is uncharacterised.

`replication-default = off` everywhere because per-attempt cost is high under subscription billing. Replication is opt-in per task via `Task.replicate = N` for the small set of tasks where we genuinely care about variance reduction (e.g. ship-criteria tests).

---

## 4. Auto-commit-before-die

The failure: 20-min `gtimeout` SIGTERM'd `claude -p`, edits sat uncommitted on the working tree, next loop iteration `batonq pick` ran `git status`-blind and the next agent saw stray uncommitted files from the dead one. Root cause: dispatch shell trusted the agent to commit; agent ran out of wall-clock before reaching its commit step.

**Design: a `pre-die-hook` runs in the dispatcher, NOT in the runner adapter.** The runner is dumb; it spawns a subprocess and waits. The dispatcher owns the wall-clock and owns git.

Lifecycle:

1. Dispatcher records `pre_attempt_sha` = `git rev-parse HEAD` before spawn.
2. Spawn runner under gtimeout. Watchdog (repurposed, see §6) monitors liveness.
3. On any of {SIGTERM from gtimeout, watchdog kill, dispatcher receiving SIGINT, runner exit ≠ 0 with dirty tree}: dispatcher enters `pre-die-hook`:
   - Compute `git diff --stat` against `pre_attempt_sha`.
   - If diff is empty → emit `events.jsonl` row `attempt_aborted_clean`, transition to `verifying` (verify_cmd will likely fail; that's the truth).
   - If diff is non-empty → create branch `batonq/wip/<task_external_id>/<attempt_n>`, stage all, commit with `wip(batonq): partial work from <runner>/<model>, attempt <n>, killed by <signal>`. Push nothing. Branch stays local. Original `HEAD` is restored on the active branch via `git reset --hard pre_attempt_sha` so the next attempt starts from a clean tree.
   - Update task row: `last_wip_branch`, `last_wip_diff_stat`, `last_kill_reason`. State → `submitted-partial`.
4. `verifying` runs verify_cmd against the wip branch (checked out into a worktree to avoid tree-state side-effects on the active branch). If it passes → merge wip into main; rare but possible. If it fails → standard retry/refiner path; refiner gets the wip diff as input (see §5).

**Where the code lives:**

- New component: `src/dispatcher.ts` (TypeScript, replaces the bash `agent-coord-loop` shell). Bash was fine for hard-coded `claude -p`; the per-task state machine + git ops + EIR bookkeeping is too complex for bash. Keep `agent-coord-loop` as a thin shell wrapper that just `exec`s `bun src/dispatcher.ts` so existing systemd/launchd units still work.
- Pre-die hook is a method on the dispatcher: `dispatcher.handleAttemptDeath(taskId, reason, signal)`. Not in the runner adapter — adapter doesn't know about git, and shouldn't.
- The bash `agent-coord-loop` script is kept for one minor version as a fallback path, removed in v2.1.

**Integration with PreToolUse verify-gate (shipped 2026-04-26):** that hook catches `batonq done` calls without verify passing — it's the front door. The pre-die hook is the back door for the case where the agent never reached the front door at all. They don't overlap. Verify-gate runs in-process inside claude-code's hook system; pre-die-hook runs in the dispatcher process after the runner has been killed. Both write to the same `events.jsonl` for the watchdog and TUI.

---

## 5. Refiner role separation

McAndrews showed worker+refiner pipeline matches single-bigger-model. Right now each task is a single dispatch — when verify fails we just respawn the same runner on the same task. That's the "every iteration net-negative" trap.

Proposal: the task schema gains a `pipeline` field (default `single`). Values: `single`, `worker_then_refiner`, `worker_then_refiner_then_judge`. The dispatcher reads this on retry-trigger.

When the dispatcher invokes a refiner:

- Inputs handed to the refiner prompt:
  - The original task body
  - The `verify_cmd` and its captured stdout/stderr from the failing attempt
  - The wip diff (from `pre-die-hook` or from a normal exit with dirty tree)
  - Explicit instruction: "Do NOT redo this from scratch. The diff above is 80%+ correct per heuristic. Apply minimal changes to make verify_cmd pass."
- Default refiner runner per worker: see §3 table. Cross-vendor by default (codex worker → claude refiner) on the Affonso assumption that per-vendor reasoning patterns are structurally different and a different vendor is more likely to spot a stuck rationalisation than the same vendor's bigger model.
- Refiner is wall-time-capped at 8 min — shorter than worker because the input is already 80% there.
- Refiner role appears in the existing `role` channel (`worker | judge | pr-runner | explorer | reviewer | refiner`), routed via the same SKILL.md mechanism. New `refiner` SKILL.md ships in `Salberg87/batonq-skills`.

When NOT to invoke a refiner: if the worker exited cleanly with a passing verify but failed judge — that's not a refiner case, that's a re-dispatch-to-worker case (judge feedback as additional context). Refiner is specifically for "code is almost right, verify says no".

Task routing pseudocode in the dispatcher:

```
verifyResult = runVerify(task, attempt)
if (verifyResult.pass) → state := pass
else if (attempt.n < maxRetries[runner, role]
         && eir[runner, role] < eirThreshold[runner]
         && nearCorrectHeuristic(verifyResult, attempt.diff))
  → spawn refiner per pipeline; state := working
else if (attempt.n < maxRetries[runner, role])
  → spawn same runner fresh session; state := working
else
  → state := escalate-human
```

---

## 6. Failure modes the loop now catches that watchdog used to

Today's watchdog watches `events.jsonl` mtime and kills the gtimeout tree after 10 min stale. That catches "agent went silent" but is too late and too coarse. The new dispatcher control loop has finer-grained signals, all checked once per minute by an in-process timer (replacing the standalone watchdog process). The standalone `agent-coord-loop-watchdog` script is **deleted** in v2 — its job is fully absorbed by the dispatcher.

Signals the dispatcher monitors per attempt:

1. **events.jsonl mtime** (existing) — same threshold, but now 5 min instead of 10. Stricter because we have the pre-die-hook to clean up.
2. **No tool-use event in N min** — distinct from mtime; agent could be writing to stdout but doing no work. Threshold: 3 min.
3. **No file edit in N min after first edit** — agent started, made some edits, then stalled. Threshold: 4 min. Distinct from #2 because Read/Bash without Edit can mean "thinking", but if it goes too long it's drift.
4. **No git commit when task body says "commit before done"** — checked at the moment the agent calls `batonq done`. Already covered by PreToolUse verify-gate for claude; for codex/gemini/opencode the dispatcher checks post-hoc and rejects the done.
5. **Burn-rate spike mid-attempt** — sample `batonq burn` every 60s; if 5h-bucket Δ exceeds per-task token cap, kill attempt with `reason: token_budget`. Watchdog never had this — it only fired on liveness, not cost.
6. **Repository drift detector** — `git diff --stat` shows edits to files outside the task's declared `paths` glob (if set). Soft-warn at 1 file, kill at 5 files. Catches the runaway-refactor case.
7. **Runner-specific liveness** — claude prints session_id within 30s; codex prints model-init within 20s; gemini prints approval-mode within 15s. If any of these markers don't appear in their window, the agent didn't actually start (auth failure, rate limit, etc.) and the dispatcher kills early instead of waiting 20 min.
8. **Verify-cmd self-test** — before the very first attempt of a task, dispatcher runs `verify_cmd` against the unchanged tree to confirm it returns ≠ 0 (else the task is already "done" and the spec is wrong) AND syntactically parses. Fail-fast on malformed verify saves a full attempt cycle.
9. **Same-task ping-pong** — dispatcher refuses to retry if the previous attempt's diff equals the pre-pre-attempt diff (agent is reverting and re-applying the same change). Hard signal of stuck reasoning; jumps to `escalate-human`.

Together these replace the watchdog's single coarse signal with nine targeted ones. The watchdog's only remaining job — killing across a process boundary — is unnecessary because the dispatcher owns the runner subprocess directly and can SIGTERM in-process.

---

## Open questions (deliberately unresolved here)

- EIR threshold values for codex/gemini/opencode are placeholders. We need 2 weeks of real verify-fail-retry data per (runner, role) to set them. Until then, `max_retries = 0` for those runners is the conservative default.
- Refiner-pair table assumes cross-vendor is better than same-vendor-bigger-model. Defensible from Affonso but unmeasured for our stack. Worth an experiment after the dispatcher rewrite ships.
- Replication default `off` is a cost decision. If we ever get prompt-cache discounts that bring per-attempt cost down significantly, revisit.
