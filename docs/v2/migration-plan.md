# batonq v2 Migration Plan

Operator runbook for landing v2 on an existing v1 install. The shipping
order is **D → B → A → C**. Between any two phases the operator runs `git
pull && sh install.sh` and the system stays live: 76 production tasks
remain queryable, the loop keeps picking, and `events.jsonl` keeps
appending. No phase requires a manual SQL step.

Track designs live in [`track-a-reputation.md`](./track-a-reputation.md),
[`track-b-trace-hardening.md`](./track-b-trace-hardening.md),
[`track-c-falsification.md`](./track-c-falsification.md), and
[`track-d-control-loop.md`](./track-d-control-loop.md). This document
covers only the migration-mechanics layer.

## 1. What survives v1→v2 untouched

**Tables.** `tasks` is _extended in place_ via `ALTER TABLE ... ADD
COLUMN` (the same idempotent pattern as `migrateAgentColumn` /
`migrateRoleColumn` in `src/migrate.ts`). No row is rewritten and no
column is dropped. `sessions`, `claims`, and `sqlite_sequence` are
untouched. All existing indexes (`idx_task_status`, `idx_task_repo_status`,
`idx_task_pick`, `idx_active_claim`, `idx_claim_file`, `idx_claim_session`)
remain.

**Files.** `~/.claude/batonq/state.db` keeps its canonical path —
`migratePath()` already ran on every v1 machine. `events.jsonl` at
`~/.claude/batonq-measurement/` continues to be appended; v1 lines stay
byte-identical, the v2 hash-chain begins after a one-shot
`v2_chain_init` boundary event (Track B §4).

**Binaries.** `batonq`, `batonq-hook`, and `batonq-loop` are rebuilt by
`sh install.sh` to `~/.local/bin/`. The shipped 2026-04-26 PreToolUse
verify-gate (with `"timeout": 300` in `settings.json`) survives every
phase — verify-gate is the load-bearing structural anti-cheat and
doesn't move.

**Hooks.** `settings.json` template gains the v2 chain-write capability
in Phase B but the matcher list, ordering, and 300 s timeout are
preserved. Operators who already re-ran install.sh on 2026-04-26 don't
need to re-edit anything.

## 2. What's added

- **4 new tables / 1 view.** `rep_outcomes`, `rep_aggregates`,
  `chain_state`, `task_transitions`; view `rep_scores`. (Track A adds
  `rep_outcomes` + `rep_aggregates` + the view; Track B adds
  `chain_state`; Track D adds `task_transitions`. Track C adds NO new
  schema — its honeypot machinery extends the existing tasks table and
  its sandbagging probes live in the prompt envelope.)
- **6 new `tasks` columns.** `model_version`, `provider`, `task_class`,
  `dispatch_kind` (Track A §1.1); `task_state` and `pipeline` (Track D
  §1, §5).
- **`pipeline` field on tasks.** `single | worker_then_refiner |
worker_then_refiner_then_judge` (Track D §5).
- **2 new on-disk artefacts.** `~/.claude/batonq/chain.key` (32 random
  bytes, mode 0400, `chflags uchg`) and `~/.claude/batonq/chain-head`
  (mode 0600, atomic-rename updates).
- **New CLI commands.** `batonq trace verify`, `batonq trace repair`,
  `batonq honeypot inject`, `batonq honeypot stats`, `batonq runners`.
- **New role.** `refiner`, alongside the existing
  `worker|judge|pr-runner|explorer|reviewer` set in `role-skills.ts`.
- **New process.** `bun src/dispatcher.ts` — TypeScript replacement for
  the bash control loop, owns wall-clock and git.

## 3. What gets deprecated

- **`agent-coord-loop-watchdog`** — its nine signals are absorbed by the
  in-process dispatcher timer (Track D §6). Removed in Phase D.
- **The bash `agent-coord-loop`** — kept as a one-line `exec bun
src/dispatcher.ts` wrapper so existing systemd/launchd units keep
  working; physically removed in v2.1.
- **Old `events.jsonl` lines before the `v2_chain_init` marker** — still
  readable and still tailed by the TUI; treated as _unverified_ by the
  chain walker (Track B §3). Verify-gate counts only over the validated
  prefix.

## 4. Per-table migration mechanics

Each new SQL artefact gets its own migration function in
`src/migrate.ts` following the `migrateAgentColumn` /
`migrateModelColumn` pattern: `pragma_table_info` (or
`sqlite_master WHERE type='table' AND name=?`) check, then
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN`. Every
function is idempotent — invoked on every CLI start, hook fire, and
test setup, same as today.

| Step                        | Migration function                                                                                                                    | Phase | Idempotent                                                       | Backfill                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrateTaskStateColumn`    | `task_state TEXT NOT NULL DEFAULT 'queued'` + `task_transitions` table                                                                | D     | yes (column-exists check)                                        | rows with `status='done'` → `task_state='pass'`; `status='lost'` → `'abandon'`; everything else → `'queued'` (one `UPDATE` inside the migration)           |
| `migrateTaskPipelineColumn` | `pipeline TEXT NOT NULL DEFAULT 'single'`                                                                                             | D     | yes                                                              | none — default suffices                                                                                                                                    |
| `migrateChainStateTable`    | `CREATE TABLE chain_state (id INTEGER PK CHECK(id=1), head TEXT NOT NULL, updated_at TEXT NOT NULL)` + writes the `v2_chain_init` row | B     | yes (re-run is no-op once `id=1` exists)                         | seals existing `events.jsonl` as `{ v1_lines_sha256, v1_line_count }`; also generates `chain.key` if absent                                                |
| `migrateTaskAuditColumns`   | 4 ALTERs: `model_version`, `provider`, `task_class`, `dispatch_kind`                                                                  | A     | yes (per-column `pragma_table_info` check, one ALTER each)       | `task_class` backfilled from `body` via `detectTaskType` for the 76 prod rows; `dispatch_kind='single'`; `provider`/`model_version` left NULL (Track A §1) |
| `migrateRepTables`          | `rep_outcomes`, `rep_aggregates`, view `rep_scores`, both indexes                                                                     | A     | yes (`CREATE TABLE IF NOT EXISTS` / `CREATE VIEW IF NOT EXISTS`) | none — v1 rows predate the audit and generate no outcomes by design (Track A §1, "v2 starts cold")                                                         |

A v1 install upgrades by running `sh install.sh`. Install.sh invokes the
new binary once with `BATONQ_RUN_MIGRATIONS=1`, which calls every
migrate-fn in declared order. The 76-task DB stays queryable through
every step because every change is additive (new columns are nullable
or have defaults, new tables coexist with old ones).

## 5. Phase ordering and rollback

### Phase D — control loop (already shipped)

Migrations: `migrateTaskStateColumn`, `migrateTaskPipelineColumn`.
Activates: `bun src/dispatcher.ts`, `task_transitions` audit, refiner
role, finer watchdog signals. **Rollback:** drop the new columns is
non-trivial under SQLite; instead, the operator points
`~/.local/bin/batonq-loop` back at the bash script (the
`exec bun src/dispatcher.ts` shim ships v2.0 → v2.1 explicitly to enable
this). Data preserved — `task_state` becomes a write-only column that
the bash loop ignores.

### Phase B — trace hardening

Migrations: `migrateChainStateTable` (creates `chain_state`, generates
`chain.key`, writes `v2_chain_init` boundary event into the live
`events.jsonl`). Activates: `appendChained` in `agent-coord-hook`,
`batonq trace verify | repair`, the `AuditResult` return type from
`countMutatingEventsSinceClaim` (Track B §3). **Rollback:** delete
`chain.key`, `chain-head`, the `chain_state` row; `events.jsonl` past
the boundary stays readable and the v1 counter falls back to "all
lines" mode. Hook-discipline rule (any error → fail open) means a
broken chain doesn't deadlock the loop.

### Phase A — reputation

Migrations: `migrateTaskAuditColumns`, `migrateRepTables`. Activates:
`rep_outcomes` writer in `tasks-core.markDone/markLost`, the routing
wrapper in `agent-runners/routing.ts`. **Rollback:** the operator can
`DROP TABLE rep_outcomes; DROP TABLE rep_aggregates; DROP VIEW
rep_scores;` and routing immediately falls back to v1
`ROUTING_TABLE` (the wrapper checks for an empty
`trustworthyCells()` result and uses v1 by design — Track A §5).
**Yes, a broken reputation table can be deleted; routing keeps
working.** This is the single most important rollback property of
Phase A and is enforced by the wrapper's "if candidates is empty, use
v1Default" fallback.

### Phase C — falsification

Migrations: `migrateRunnerReputation`. Activates: honeypot scheduler,
canary stanza in `prompt-prepend.ts`, replication policy in
`shouldReplicate()`, sandbagging A/B probe job. **Rollback:** drop the
two `runner_*` tables and unset the routing flag; canary stanza is
prompt-only and removing it from `prompt-prepend.ts` is a one-line
revert.

## 6. Testing strategy for migrations

The existing pattern is `tests/migrate-path.test.ts` — each test
constructs a fresh `mkdtempSync` `home`, lays down a representative v1
state, runs the migration, and asserts shape + idempotency by running
twice. `bun test tests/migrate*.test.ts` is the gate; CI already runs it.

Per-phase additions, all following that template:

- **Schema-shape tests** per migration: `pragma_table_info('tasks')`
  contains the expected columns; `sqlite_master` contains the new
  tables and view.
- **Idempotency tests** per migration: run the function twice on the
  same DB, assert no exceptions and identical schema. Mirrors how
  `migrateAgentColumn` is exercised today (implicitly — every CLI start
  re-invokes it).
- **Downgrade-safety tests:** open a DB created by v2, run the v1
  binary's queries (`SELECT * FROM tasks WHERE status='pending'`,
  `claim`, `done`); assert success. New columns are ignored, new tables
  are unread.
- **Data-preservation tests across upgrades:** seed a v1 DB with 76
  representative rows (fixture from prod schema), run all v2
  migrations in order, assert `SELECT COUNT(*) FROM tasks = 76` and
  every external_id is preserved.
- **Phase-B chain-init test:** write a 100-line v1 `events.jsonl`,
  run `migrateChainStateTable`, assert `chain_state.id=1` exists,
  `chain.key` is mode 0400, the `v2_chain_init` line is appended with
  the correct `v1_line_count` and a valid MAC.
- **Phase-A backfill test:** seed three tasks whose bodies match
  `detectTaskType`'s `architecture | implementation | quick_fix`
  branches; run `migrateTaskAuditColumns`; assert `task_class` is set
  on all three and `dispatch_kind='single'`.

The `memDb()` helper from `tests/core.test.ts` (Hard Rule #4) is the
constructor for every migration test — no test ever touches
`~/.claude/`. CI for each phase blocks merge on the new tests passing
plus the full `bun test` suite of 370+ existing tests.
