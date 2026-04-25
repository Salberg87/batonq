# TUI UX v2 — from dashboard to live work surface

**Status:** spec — implementation in progress.
**Audience:** agents implementing the TUI tasks under Track A.
**Last updated:** 2026-04-23.

## Problem

The current TUI is a half-interactive dashboard: four static list panels (Sessions, Active claims, Tasks, Events) plus a loop-status footer. The operator can see _what has happened_ (file edits as events) but not _what is actively being done_ (agent reasoning, test output, verify state, commit deltas). The consequence: when something goes wrong — a task marks itself `done` without passing gates, a claim goes stale, the loop wedges — the TUI does not surface it. The operator must drop to `agent-coord tail`, `git log`, and `sqlite3` to reconstruct reality.

## Goal

The TUI is the one place the operator looks to understand: _is the queue healthy, what is the active agent doing right now, and what did it actually deliver._ Nothing about that understanding should require a second terminal.

## Target information hierarchy

From top to bottom, always visible:

1. **Alert lane** (conditional, 0–2 lines) — red/yellow warnings only. Hidden when nothing is wrong.
2. **Current-task card** (5–7 lines) — the live work surface. Replaces `Active claims`.
3. **Tasks panel** (existing, compacted) — pending/done counts + verify/judge badges.
4. **Live feed** (8–12 lines) — combined tail of loop-log + claude-p stdout + hook events, chronologically merged.
5. **Keybind footer** (existing).

Sessions panel is dropped — session rows are implementation detail, noise for the operator.

## Panel specs

### 1. Alert lane

One line per alert, up to 2 stacked. Hidden when count = 0.

Alert conditions (priority order, higher wins if only 2 slots):

| Alert         | Condition                                                                               | Color  | Text                                                  |
| ------------- | --------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| Verify failed | latest done row has `verify_output` containing `FAIL` or `exit !0`                      | red    | `✗ verify FAILED on <id>: <first line of output>`     |
| Judge failed  | latest done row has `judge_output` containing `FAIL` as first token                     | red    | `✗ judge FAILED on <id>: <reason>`                    |
| Cheat done     | done task with `verify_ran_at IS NULL AND judge_ran_at IS NULL AND verify_cmd NOT NULL` | red    | `⚠ task <id> marked done without gates — investigate` |
| Stale claim   | active claim with `claimed_at < now() - 30min AND last_progress_at < now() - 10min`     | yellow | `⚠ claim <id> stale for <minutes>m`                   |
| Watchdog kill | loop-log last 100 lines contains `[watchdog]…killing`                                   | yellow | `⚠ watchdog killed claude ~<minutes>m ago`            |
| Empty queue   | pending=0 for >15min                                                                    | gray   | `ℹ queue empty for <minutes>m`                        |

Click/Enter on alert → opens drill-down (see §5).

### 2. Current-task card

Shown when any claim exists. Layout:

```
╭─ Active task — <id> ─────────────────────── <elapsed> ─╮
│ <body first 120 chars…>                                │
│                                                        │
│ claimed by <session-short>  ·  <edits> edits  <bash>   │
│ bash calls  ·  last activity <relative>                │
│                                                        │
│ verify: <captured|missing>  judge: <captured|missing>  │
│ latest commit: <sha> <msg first 60 chars>              │
╰────────────────────────────────────────────────────────╯
```

- `<elapsed>` = `claimed_at` to `now` in `Xm Ys`.
- `<edits>` / `<bash>` = count of events for this session in `events.jsonl` since claim.
- `<relative>` = last event timestamp relative ("12s ago", "3m ago"). Turns yellow >2m, red >5m.
- `verify: <captured|missing>` = `✓` if `verify_cmd` non-empty in DB, `✗` if empty but task had `verify:` in source (regression signal).
- `latest commit` = `git log -1 --format="%h %s"` in the task's repo, only if there are commits since `claimed_at`.

When no claim: the card is replaced with a simple line `— idle (queue: <pending> pending) —`.

### 3. Tasks panel (compacted)

Drop the horizontal count header (moved to current-task card). Show:

```
Pending (N)   Draft (N)   Claimed (N)
< task rows, grouped by priority >
  [H] <id>  <body first 80 chars>
  [N] <id>  <body first 80 chars>
  ...

Recent done (last 10)
  ✓V ✓J  <id>  <body>          2m ago
  ✓V ✗J  <id>  <body>          8m ago  (judge reason: …)
  ⊘     <id>  <body>          1h ago  (no gates)
  ⚠     <id>  <body>          3h ago  (DONE WITHOUT VERIFY)
```

Badge alphabet:

- `✓V ✓J` — both passed
- `✓V —` / `— ✓J` — one ran, other absent (task had no gate for it)
- `✗V` / `✗J` — gate ran and FAILED (should never appear in done if gates work)
- `⊘` — task had no gates
- `⚠` — task done without gates running despite gates existing (cheat signal, matches alert-lane condition)

**Badge visibility:** `⚠` must be impossible to miss — rendered red + bold,
all other badges are green (`✓V ✓J`, `✓V —`) or dim (`⊘`). A cheat row
should catch the eye on first glance at the Tasks panel.

**Badges show status, not duration.** A ✓V ✓J row means "both gates ran";
it does not carry elapsed time (like `3s+12s`). Rationale: if a gate
failed, the alert lane would already be red with `verify FAILED on <id>`,
so the only question left for the Tasks panel is "did it run or not."
Duration + captured output live in the drill-down (§5), not in the list
row. Keeps each done line to one visual ≤80 char width and avoids forcing
the operator to parse noise when scanning the queue.

**Output clipping (drill-down only).** `verify_output` is shown
tail-first (`tailLines(n=30)`) — the failing assertion is almost always
at the end of a long log. `judge_output` is shown head-first
(`headLines(n=15)`) — the verdict string starts with PASS/FAIL on line 1
and reason follows. These two helpers live in `src/tui-data.ts`. The main
Tasks-panel rows never show output at all; they show the badge only.

`j`/`k` navigates rows. Enter opens drill-down.

### 4. Live feed

Chronologically merged stream of three sources, newest at bottom (tail -f semantic):

- **Loop log** (`/tmp/agent-coord-loop-*.log`): each line prefixed `[loop]` in yellow
- **Events** (`~/.claude/agent-coord-measurement/events.jsonl`): pretty-printed as `[evt] <sess> <tool> <path>` in cyan
- **Commits** (git log polling per active repo): `[git] <sha> <msg>` in green

Auto-scroll to bottom. Trim to last ~40 lines to avoid growth. If the operator scrolls up (arrow keys), auto-scroll pauses with a `⏸` marker; `End` resumes.

Replaces the current "Events (20 / last 20)" panel entirely.

### 5. Drill-down overlay

Triggered by Enter on any task row or alert. Full-screen modal:

```
╭─ Task <full id> ─ [<status>] <badges> ─────────────╮
│                                                    │
│ Body:                                              │
│   <full body, wrapped>                             │
│                                                    │
│ Verify cmd:                                        │
│   <verify_cmd or "— none —">                       │
│ Verify output (last 30 lines):                     │
│   <tail of verify_output>                          │
│                                                    │
│ Judge cmd:                                         │
│   <judge_cmd or "— none —">                        │
│ Judge verdict:                                     │
│   <first 15 lines of judge_output>                 │
│                                                    │
│ Commits since claim (N):                           │
│   <sha> <msg>                                      │
│   <sha> <msg>                                      │
│                                                    │
│ Esc close · a abandon · r release-claim · e enrich │
╰────────────────────────────────────────────────────╯
```

All existing task keybinds available inside the modal.

## Keybinds (updated)

Same bottom-row footer. Additions:

- `Enter` — open drill-down on selected task or alert
- `Esc` — close drill-down
- `End` — resume live-feed auto-scroll
- `F` — toggle live-feed pause/resume
- `A` — jump to first alert (no-op if none)

Existing bindings preserved: `q`, `Tab`, `j`/`k`, `/`, `n` new, `e` enrich, `p` promote, `o` show original, `a` abandon, `r` release, `?` help, `L` restart loop, `P` priority, `T` scheduled.

## Implementation notes

- Poll interval stays 2s for panel refresh. Live feed polls every 500ms for smoother tail.
- All DB reads are read-only snapshots (open fresh connection, close immediately) — TUI must never block write paths.
- The "cheat" detection (done without gates) runs on every done-list fetch. Alert persists until operator explicitly dismisses (`d` on the alert).
- Color palette reuses `brand.accent` / `brand.dim` / standard `red`/`yellow`/`green`/`cyan` from ink. No new deps.

## What this does not cover

- External notifications (email/Telegram/push) — separate track, future.
- Web dashboard — separate product surface.
- Multi-user concurrent TUI — one operator assumed.
- Keyboard-remapping configurability — default bindings only.

## Success criteria

An operator who has not seen batonq before can, within 5 minutes of launching `batonq` (TUI):

1. Tell whether the queue is healthy.
2. Identify the currently-running task and roughly how far along it is.
3. See the most recent commit it produced.
4. Notice any gate failure or cheat attempt without reading logs.
5. Drill into any task to understand why it is in its current state.
