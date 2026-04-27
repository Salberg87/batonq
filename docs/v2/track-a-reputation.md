# Track A — Reputation System Design (batonq v2)

Status: design, not implementation. Targets `bun:sqlite` at
`~/.claude/batonq/state.db`. Coexists with the v1 `tasks` / `sessions` /
`claims` schema; nothing in v1 is dropped or rewritten.

The four anchors the design is built on:

- **PEDAL** → confidence is interval-valued and partitioned by class.
- **Affonso** → keys are `(provider, model_version)`, decay is fast,
  generational change is treated as a new agent.
- **Avalon** → reputation is _role-conditional_; a per-agent number is a lie.
- **Causality** → routing decisions create the data they're scored against;
  defend the table from the queries that read it.

---

## 1. SQL schema

Two new tables and one view. Existing `tasks` gains four nullable audit
columns so reputation can join back to the dispatch that produced it.

```sql
-- ── Migration: 0007_reputation.sql ───────────────────────────────────────

-- 1.1  Audit columns on the existing tasks table.
ALTER TABLE tasks ADD COLUMN model_version TEXT;        -- e.g. "claude-opus-4-7"
ALTER TABLE tasks ADD COLUMN provider      TEXT;        -- "anthropic"|"openai"|"google"|"opencode"
ALTER TABLE tasks ADD COLUMN task_class    TEXT;        -- denormalised partition key (see §4)
ALTER TABLE tasks ADD COLUMN dispatch_kind TEXT NOT NULL DEFAULT 'single';
       -- 'single' | 'replicated-2of3' | 'replicated-1of1-judged' | 'shadow'
       -- Identifies the experimental design of THIS run, so we can
       -- distinguish solo verdicts from replication consensus.

CREATE INDEX idx_tasks_class_provider
  ON tasks(task_class, provider, model_version, completed_at);

-- 1.2  Atomic outcomes — one row per terminal task event.
--      Append-only. This is the single source of truth; aggregates derive
--      from it and can always be rebuilt.
CREATE TABLE rep_outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id),
  provider        TEXT    NOT NULL,
  model_version   TEXT    NOT NULL,
  task_class      TEXT    NOT NULL,    -- see §4 for grammar
  role            TEXT    NOT NULL,    -- worker|judge|pr-runner|explorer|reviewer
  dispatch_kind   TEXT    NOT NULL,
  observed_at     TEXT    NOT NULL,    -- ISO-8601, == tasks.completed_at
  -- Signals (each ternary: 1=pass, 0=fail, NULL=not run / not applicable):
  verify_pass        INTEGER,
  judge_pass         INTEGER,
  watchdog_killed    INTEGER NOT NULL DEFAULT 0,
  abandoned          INTEGER NOT NULL DEFAULT 0,
  preToolUse_blocked INTEGER NOT NULL DEFAULT 0,   -- the v1 verify-gate hook
  replication_agree  INTEGER,                       -- NULL unless dispatch_kind starts 'replicated-'
  duration_ms        INTEGER NOT NULL,
  -- Witness pointer (PEDAL: keep the worst-case evidence near the score):
  witness_kind    TEXT,           -- 'verify-stdout'|'judge-stdout'|'diff'|'events.jsonl-slice'
  witness_ref     TEXT            -- file path or events.jsonl byte range
);

CREATE INDEX idx_rep_outcomes_class
  ON rep_outcomes(task_class, provider, model_version, role, observed_at);
CREATE INDEX idx_rep_outcomes_recent
  ON rep_outcomes(observed_at);

-- 1.3  Materialised aggregates per (provider, model_version, role,
--      task_class) — Beta posterior parameters + counts.
CREATE TABLE rep_aggregates (
  provider        TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  role            TEXT NOT NULL,
  task_class      TEXT NOT NULL,
  -- Beta(α, β) over P(success). α counts effective successes, β failures.
  -- Updated with exponential time-decay (§3) and credit-weighted by
  -- dispatch_kind (replicated > single > shadow).
  alpha           REAL NOT NULL,
  beta            REAL NOT NULL,
  n_raw           INTEGER NOT NULL,         -- raw outcome count, no decay
  n_effective     REAL NOT NULL,            -- α + β − 2 (subtracts prior)
  last_observed   TEXT NOT NULL,
  worst_witness   TEXT,                     -- ref to the lowest-quality outcome we've seen
  PRIMARY KEY (provider, model_version, role, task_class)
);

CREATE INDEX idx_rep_agg_class ON rep_aggregates(task_class, role);

-- 1.4  View used by routing — exposes the credible interval and the
--      partition fallback chain (§4) in one query.
CREATE VIEW rep_scores AS
  SELECT
    provider, model_version, role, task_class,
    alpha, beta, n_raw, n_effective, last_observed,
    -- Beta posterior mean (smoothed by the prior):
    alpha / (alpha + beta)                                              AS mean,
    -- 90% credible interval, computed in app code from α,β.
    -- The view ships α/β; the function ci90(alpha,beta) lives in TS.
    NULL AS ci_lo,  NULL AS ci_hi
  FROM rep_aggregates;
```

Why a separate `rep_outcomes` table instead of widening `tasks`: outcomes
are append-only and queried very differently from the queue (windowed by
time, partitioned by class). Keeping them separate keeps the queue hot path
narrow and makes the aggregate fully rebuildable from outcomes alone, which
is the whole point of an audit log.

Migration coexistence: existing 76 production rows have `provider`,
`model_version`, `task_class` NULL. The migration backfills `task_class`
from `body` via `detectTaskType`, sets `dispatch_kind='single'`, and leaves
`provider`/`model_version` NULL. Those rows generate **no** `rep_outcomes`
— they predate audit and we will not invent data. v2 starts cold by design.

---

## 2. Scoring math

A Beta-Binomial posterior per partition cell, conjugate-updated with
time-decayed pseudo-counts. Three reasons over a frequentist Wilson CI:

1. The interval is meaningful from the first observation (the prior carries
   it). Wilson goes degenerate at `n < 5`, which is the regime we live in.
2. Decay maps cleanly onto fractional pseudo-counts.
3. Compositional confidence (PEDAL): two cells' Beta posteriors compose
   into a Beta-product whose mean is `μ₁μ₂` and whose variance bounds give
   the right pessimistic interval for chained tasks.

### Prior

`Beta(α₀=2, β₀=2)` per cell. Expected mean 0.5, 90% CI ≈ `[0.19, 0.81]`.
Wide enough to be honestly ignorant; narrow enough that ten observations
visibly move it.

### Update on outcome `o`

Define a single scalar success signal `s ∈ {0, 1}` from the outcome:

```
s = 1  iff   verify_pass = 1
       AND  (judge_pass = 1 OR judge_pass IS NULL)
       AND  watchdog_killed = 0
       AND  abandoned = 0
       AND  preToolUse_blocked = 0
s = 0  otherwise
```

Then weight by dispatch credibility (replication is more informative than
a self-judged solo run):

```
w_dispatch =  1.0  if dispatch_kind = 'single'
              2.0  if dispatch_kind starts with 'replicated-'  (independent peers agree)
              0.25 if dispatch_kind = 'shadow'                 (no real consequences, weak signal)
```

And by recency at update time `t`:

```
w_decay(o, t) = exp( −(t − observed_at) / τ )    with τ = 30 days.
```

Update step:

```
α ← α₀ + Σ s · w_dispatch · w_decay
β ← β₀ + Σ (1 − s) · w_dispatch · w_decay
```

Recomputed nightly over the last 180 days of `rep_outcomes` (and
incrementally on every new outcome, with the nightly job as the
reconciliation truth).

### Credible interval

90% Beta CI via the regularised-incomplete-beta inverse: `[I⁻¹(0.05; α, β),
I⁻¹(0.95; α, β)]`. Computed in TS with a small `betaQuantile` (Newton on
the regularised incomplete beta — 50 lines, no dependency).

### "Trustworthy enough" predicate

A cell is _trustworthy for class C_ iff:

```
ci_lo(α, β)  ≥  threshold(C)        AND   n_raw ≥ 8
```

Thresholds per class type (decisions, not knobs to tune later):

| Class type        | `threshold`                   |
| ----------------- | ----------------------------- |
| `quick_fix`       | 0.55                          |
| `implementation`  | 0.65                          |
| `refactor`        | 0.65                          |
| `code_generation` | 0.60                          |
| `review`          | 0.70                          |
| `exploration`     | 0.50 (read-only — bar is low) |
| `bulk_analysis`   | 0.50                          |
| `architecture`    | 0.80 (irreversible-ish work)  |

The lower-bound test (not the mean) is the whole point of going Bayesian:
a cell with mean 0.95 but only 3 observations has `ci_lo ≈ 0.49` and is
_not_ trustworthy yet. The `n_raw ≥ 8` floor exists because PEDAL is right
that even a tight CI on 5 samples is fooling itself about
non-stationarity.

---

## 3. Update protocol

### Triggers

A row is appended to `rep_outcomes` exactly once per task, at the moment
the task transitions to a terminal status (`done`, `lost`, or
abandonment-via-sweep). The writer lives in `tasks-core.ts` next to
`markDone` / `markLost`; it reads the task row, classifies the outcome via
the signal table above, and inserts.

| Signal               | Source                                                    | Maps to                                                   |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `verify_pass`        | `tasks.verify_output` exit captured in `runVerify`        | `verify_pass`                                             |
| `judge_pass`         | `tasks.judge_output` exit                                 | `judge_pass`                                              |
| `watchdog_killed`    | `agent-coord-loop-watchdog` events.jsonl marker           | `watchdog_killed`                                         |
| `abandoned`          | `batonq abandon` or sweep                                 | `abandoned`                                               |
| `preToolUse_blocked` | `agent-coord-hook bash` deny count for this `external_id` | `preToolUse_blocked`                                      |
| `replication_agree`  | `dispatch_kind='replicated-2of3'` consensus result        | `replication_agree`                                       |
| `duration_ms`        | `completed_at − claimed_at`                               | `duration_ms` (not in `s`, but used for outlier flagging) |

`duration_ms` is recorded but not in the success scalar — using it would
penalise hard tasks routed to slow-but-correct runners (a confounder, see
below).

### Confounder controls (the Causality piece)

Three explicit defences:

1. **`task_class` is fixed at dispatch time, not at outcome time.** The
   classifier (`detectTaskType` from `routing.ts`) runs once when the task
   enters `pending`, the result is written to `tasks.task_class`, and the
   reputation update reads from the column. This stops post-hoc
   reclassification ("this looks hard now, downgrade to architecture")
   from leaking outcome into class.
2. **Selection-bias correction via dispatch logging.** `dispatch_kind`
   records the _experimental design_, not the result. When we mostly
   route hard tasks to high-rep runners, the conditional `P(success |
high-rep)` is biased up. We counter by periodically routing a fraction
   `ε = 0.05` of every class to the **second-best** trustworthy runner
   (epsilon-shadow dispatch); those outcomes weight at `0.25` in α/β but
   keep the score grounded.
3. **Generational firewall.** When `model_version` changes (Anthropic
   rolls out claude-opus-4-7 → 4-8), the new version is a **new cell**
   from scratch. We don't migrate α/β across versions. Affonso's 33×
   generational drop is the cost of being wrong about this.

### Decay semantics

The 30-day τ is short on purpose. After 90 days an outcome contributes
`e⁻³ ≈ 5%` of its original weight. Provider-side regressions (Anthropic
silently changing the system prompt, OpenAI tier changes) propagate into
the score within ~3 weeks, not ~6 months.

---

## 4. Partition strategy

### Partition key (full grain)

```
(provider, model_version, role, task_class)
```

`task_class` is _not_ equal to `task_type`. It encodes more, in this
order:

```
<task_type>:<complexity_bucket>:<stack_tag>
e.g. "implementation:M:ts-bun-sqlite"
     "refactor:S:ts-react"
     "architecture:L:py-pydantic"
```

Definitions:

- `task_type` ∈ the 8 types in `routing.ts`. Already classified.
- `complexity_bucket` ∈ {`S`, `M`, `L`}. Computed from `body.length`
  (S < 500 chars, M < 2000, L ≥ 2000) at task-create time. Crude but
  monotone with actual difficulty in the v1 corpus, and impossible to
  fudge after the fact.
- `stack_tag` derived from `repo` via a static `repo → stack` lookup
  shipping in `src/reputation/stack-tags.ts`. New repos default to
  `unknown` and get explicitly tagged on first use.

### Sparsity & fallback chain

Real dispatch hits the full key first. On a cache miss (or when
`n_raw < 8`), routing falls back along the chain — _each step strictly
generalises the previous_:

```
1. (provider, model_version, role, task_type:complexity:stack)
2. (provider, model_version, role, task_type:complexity:*)
3. (provider, model_version, role, task_type:*:*)
4. (provider, model_version, role, *:*:*)                 — model-vs-role
5. (provider, *,             role, task_type:*:*)         — provider prior
6. (*,        *,             role, task_type:*:*)         — role-only prior
7. global Beta(2,2)                                       — cold start
```

The first level whose `(α + β − 4) ≥ 8` wins. If we never hit 8, we keep
walking up; `ci_lo` widens at every step, which is the point — coarser
data, weaker claim. The aggregate row at each level is computed lazily
(materialised view-style, refreshed on read with TTL 1h) by summing
`rep_outcomes` at that grain.

### Cold start for new (provider, model_version)

On first appearance of a `(provider, model_version)` pair, all of its
cells inherit `Beta(2,2)`. The first 8 outcomes are dispatched with
`dispatch_kind='replicated-2of3'` against the current best runner for the
class — outcome credit is `2.0`-weighted, so the cell reaches the n=8
floor in 4 calendar runs. This is expensive (3× compute for ~4 tasks) and
worth it: routing a brand-new model to solo dispatch on its first task is
the single highest-variance failure mode of the v1 system.

---

## 5. Routing integration

`agent-runners/routing.ts` today returns a single `RoutingDecision` from
regex pattern + lookup table. v2 wraps it without removing it:

```ts
// pseudocode shape, not implementation
function routeTaskV2(body: string, agentField, role, repo, claimTs):
  classified  = detectTaskType(body)            // unchanged
  complexity  = bucketBody(body)
  stack       = stackTagForRepo(repo)
  task_class  = `${classified}:${complexity}:${stack}`

  if agentField is pinned → return { agent, model, dispatch_kind: 'single' }

  candidates = trustworthyCells(role, task_class)   // ci_lo ≥ threshold AND n_raw ≥ 8
  if candidates is empty:
    // Fall back through the chain (§4). If still nothing, use v1 ROUTING_TABLE
    // and force dispatch_kind='replicated-2of3' so the outcome counts double.
    return v1Default(task_class) with dispatch_kind='replicated-2of3'

  best = argmax(candidates, by ci_lo)
  // Exploration probe — 5% of dispatches go to the second-best to keep
  // the score grounded against selection bias (§3).
  if rand() < 0.05 and len(candidates) ≥ 2:
    return secondBest with dispatch_kind='shadow'

  // PEDAL composition: if the task body suggests a multi-step chain
  // (heuristic: detected role transitions worker→reviewer→pr-runner),
  // require ci_lo of the COMPOSED probability, not the individual cells.
  if isComposedTask(body):
    composed_ci_lo = product of cell ci_lo's      // pessimistic
    if composed_ci_lo < threshold(task_class):
      return best with dispatch_kind='replicated-2of3'

  return best with dispatch_kind='single'
```

### When replication beats single dispatch

Three explicit triggers — anything else is single dispatch:

1. **Cold-start cells** (first 8 outcomes for a new `(provider,
model_version)` × class).
2. **Composed-task pessimism** (PEDAL): if `Π ci_lo` across the role
   chain is below the class threshold, even when each cell individually
   passes.
3. **`architecture` class regardless of cell quality.** The threshold is
   0.8 and the cost of being wrong on architecture work is asymmetric.
   Every architecture task gets 2-of-3 replication with a judge cell that
   must also be trustworthy.

Replication topology: `replicated-2of3` runs three independent dispatches
to the top three trustworthy cells (different providers if available),
takes the verify-pass majority. `replicated-1of1-judged` (cheaper) runs
one worker + one judge from a different provider; both must pass.

---

## 6. Anti-gaming properties

Six concrete defences, each tied to a failure mode:

1. **Append-only outcomes, derivable aggregates.** `rep_aggregates` can
   be rebuilt from `rep_outcomes` end-to-end. An adversarial process
   that wants to fabricate reputation has to forge audit rows, and those
   rows carry `witness_ref` pointers to artefacts (verify stdout, diff,
   events.jsonl byte ranges) that don't exist if the run didn't happen.
2. **Witnesses are worst-case-pinned.** `worst_witness` on each
   aggregate row points to the _lowest-quality_ outcome we've seen in
   that cell, not a representative one. PEDAL: a cell's reputation is
   only as good as its worst recent failure; the witness is one click
   away in the TUI drill-down.
3. **Selection-bias correction is built in, not aspirational.** The 5%
   shadow dispatch and the strictly-generalising fallback chain together
   stop the table from converging to "claude-opus is best because we
   only ever dispatched hard things to claude-opus." If you turn off
   shadow dispatch, the daily reconciliation job logs a warning into
   `events.jsonl`.
4. **Provider identity dominates over model size, by construction.**
   `(provider, model_version)` is the cell key. There is no
   provider-aggregated number for a runner to game by, e.g., over-using
   GPT-5-Nano on easy tasks to inflate "OpenAI" globally.
5. **Generational reset.** `model_version` changes wipe credit. A
   provider that silently A/B-tests a worse model under the same name is
   the only attack here, and the 30-day decay catches it within weeks.
6. **The PreToolUse verify-gate (CLAUDE.md §2 hard rule) feeds the
   `preToolUse_blocked` signal.** Any run that tried to call `batonq
done` without a passing verify is recorded as a failure regardless of
   what the agent reported. This is the one structurally-preventive
   anti-cheat already in production; v2 promotes its output from "log
   line" to "score input."

The two failure modes I am explicitly _not_ defending against in v2,
because the fix costs more than the loss:

- **Sybil providers** — a runner pretending to be a different
  `(provider, model_version)`. The dispatch is ours, so the key is
  ours; this can't happen unless someone edits the DB directly, which
  is out of scope.
- **Agent collusion across replicated dispatches.** Closed-weight
  subprocesses with no shared channel — collusion requires either a
  shared model-side signal or operator collusion. The first is unlikely;
  the second is unsolvable from inside the queue.
