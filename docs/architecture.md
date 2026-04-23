# Architecture

batonq is three files and a handful of verbs. This document zooms in on the
pieces: how the binaries talk to state, how a task moves through its
lifecycle, how claims are granted without two agents colliding, and how a
full `pick → done` run flows end-to-end.

## 1. Components

```mermaid
flowchart LR
    subgraph state["~/.claude/ (local state)"]
      DB[("batonq-state.db<br/>SQLite<br/>sessions · tasks · claims")]
      EV["batonq-measurement/<br/>events.jsonl<br/>append-only log"]
    end

    subgraph cc["Claude Code runtime"]
      CC["claude -p"]
      HOOK["batonq-hook<br/>pre · bash · post"]
      CC -- "PreToolUse / PostToolUse" --> HOOK
    end

    subgraph user["User-facing binaries"]
      CLI["batonq<br/>(pick · done · abandon · add · import · sweep)"]
      TUI["batonq tui<br/>ink dashboard"]
      LOOP["batonq-loop<br/>fresh-claude-per-task"]
    end

    HOOK -->|"BEGIN IMMEDIATE<br/>INSERT claim / UPDATE last_progress_at"| DB
    HOOK -->|"append JSONL"| EV

    CLI -->|"SELECT · UPDATE"| DB
    TUI -->|"SELECT (2s poll)"| DB
    TUI -->|"tail"| EV

    LOOP -->|"batonq pick"| CLI
    LOOP -->|"spawn"| CC
```

The diagram separates three concerns that stay separate in the code as well.
**State** lives in two files: a SQLite DB (`batonq-state.db`) holding the
three tables (`sessions`, `tasks`, `claims`) under ACID transactions, and an
append-only JSONL event log (`events.jsonl`) that anything can `tail -F`.
**Claude Code** drives the hook via its PreToolUse and PostToolUse callbacks;
the hook never calls back into Claude. **User-facing binaries** are clients
of the two state files: the CLI (`batonq`) runs one-shot verbs, the TUI polls
the DB every two seconds for a live view, and `batonq-loop` is a thin bash
wrapper that alternates `batonq pick` with a fresh `claude -p` invocation per
task. The arrows are intentionally one-way: the hook writes, the TUI reads,
the CLI does both but never talks to the hook directly. If the DB is
unreachable the hook fails open — Claude's tool call still runs, it just
won't be coordinated.

## 2. Task lifecycle

```mermaid
stateDiagram-v2
    [*] --> draft: batonq add --status draft<br/>or TUI (n)
    [*] --> pending: batonq add<br/>batonq import
    draft --> pending: batonq promote<br/>(after enrich + human OK)
    pending --> claimed: batonq pick<br/>(UPDATE ... WHERE status='pending')

    state "verify gate" as verify
    state "judge gate" as judge
    claimed --> verify: batonq done<br/>(if verify_cmd)
    verify --> claimed: exit ≠ 0<br/>(stderr captured,<br/>task stays claimed)
    verify --> judge: exit 0<br/>(or no verify_cmd)
    judge --> claimed: PASS missing<br/>(judge_output logged)
    judge --> done: PASS

    claimed --> pending: batonq abandon<br/>batonq sweep (session dead)
    claimed --> lost: sweep-tasks<br/>(TTL expired, no heartbeat)

    done --> [*]
    lost --> [*]: human re-queues manually
```

A task always lives in exactly one of five statuses. `draft` is the pre-spec
lane — the TUI's `n` keybind and `batonq add --status draft` put work here,
and `selectCandidate` hard-filters drafts out so an autonomous agent can
never claim one. `pending` means ready-to-pick. `claimed` means a session's
PID owns it; `last_progress_at` is refreshed by the PostToolUse hook so
active work keeps the claim warm. `done` and `lost` are terminal. The two
gates between `claimed` and `done` are a key invariant: `verify` is a shell
command whose non-zero exit keeps the task claimed rather than closing it,
and `judge` is an optional LLM review whose non-PASS verdict likewise keeps
it claimed. Neither gate is skippable (the `--skip-verify` / `--skip-judge`
flags were removed on 2026-04-23). The `lost` transition fires from
`batonq sweep-tasks` when a claim's progress TTL expires without a live
heartbeat — it is an escalation, not a graceful exit, and shows up in
`/tmp/batonq-escalations.log` for a human to re-queue.

## 3. Write path for file claims

```mermaid
sequenceDiagram
    autonumber
    participant CC as claude -p
    participant H as batonq-hook (pre)
    participant DB as SQLite (claims)

    CC->>H: PreToolUse { tool: Edit, paths: [src/app.ts] }
    H->>DB: touchSession · sweepStale · refreshHolderClaims
    H->>DB: BEGIN IMMEDIATE
    Note over DB: write-lock acquired;<br/>other writers block here
    H->>DB: SELECT * FROM claims<br/>WHERE fingerprint=? AND file_path=?<br/>AND released_at IS NULL
    alt active claim held by peer
      H->>DB: ROLLBACK
      H-->>CC: { permissionDecision: "deny",<br/>reason: "held by session abc123…" }
    else no conflict
      H->>DB: INSERT INTO claims (…, released_at=NULL)
      Note over DB: UNIQUE partial index<br/>idx_active_claim(fingerprint, file_path)<br/>WHERE released_at IS NULL<br/>→ second writer racing us<br/>hits constraint, rolls back
      H->>DB: COMMIT
      H-->>CC: (no output → allow)
    end
    CC->>CC: run Edit tool
    CC->>H: PostToolUse
    H->>DB: UPDATE claims SET released_at=?, release_hash=?<br/>WHERE session_id=? AND released_at IS NULL
```

The write path combines two defences. First, every claim-granting
transaction starts with `BEGIN IMMEDIATE`, which acquires SQLite's write
lock up front instead of on first write — so two hooks running at the same
instant serialise at step 3 rather than racing to step 4 and hitting the
busy handler mid-commit. Second, the `claims` table carries a **unique
partial index** on `(fingerprint, file_path) WHERE released_at IS NULL`.
Even if the SELECT-then-INSERT check-and-act pattern were somehow
short-circuited, a duplicate live claim can't physically land in the table
— the index rejects the second insert at commit time. Released claims
(`released_at IS NOT NULL`) drop out of the partial index, so the same
file can be re-claimed freely after a PostToolUse release. The hook fails
open on any exception: a ROLLBACK wrapped in `try`, and the tool call is
allowed to proceed. Worst case the coordination silently degrades; the
edit never gets blocked by a bug in the hook itself.

## 4. Data flow: agent runs a task

```mermaid
sequenceDiagram
    autonumber
    participant L as batonq-loop (bash)
    participant CLI as batonq
    participant DB as SQLite
    participant CC as claude -p
    participant H as batonq-hook
    participant V as verify / judge runner

    L->>CLI: batonq pick
    CLI->>DB: sweepTasks · selectCandidate · claimCandidate
    DB-->>CLI: task { external_id, body, verify_cmd, judge_cmd }
    CLI-->>L: TASK_CLAIMED … TASK: <body>
    L->>CC: spawn claude -p --append-system-prompt (/pick-next)

    loop tool use (Edit / Bash / …)
      CC->>H: PreToolUse
      H->>DB: grant / deny file claim
      H-->>CC: allow | deny
      CC->>CC: run tool (edit code, run tests…)
      CC->>H: PostToolUse
      H->>DB: release claim · touch tasks.last_progress_at
    end

    CC->>CLI: batonq done <external_id>
    CLI->>V: run verify_cmd in repo cwd
    V-->>CLI: exit code + stdout/stderr
    alt verify exit ≠ 0
      CLI->>DB: UPDATE tasks SET verify_output=? (status stays 'claimed')
      CLI-->>CC: ✗ verify FAILED — task still claimed
    else verify passed (or absent)
      CLI->>V: run judge_cmd (opus) on git diff
      V-->>CLI: PASS | FAIL + reasoning
      alt judge PASS
        CLI->>DB: UPDATE tasks SET status='done', completed_at=?
        CLI-->>CC: ✓ done
      else judge FAIL
        CLI->>DB: UPDATE tasks SET judge_output=? (status stays 'claimed')
        CLI-->>CC: ✗ judge FAILED — task still claimed
      end
    end

    CC-->>L: exit (context cleared between iterations)
    L->>CLI: batonq pick (next iteration)
```

End-to-end, one pass of the loop is: `batonq-loop` asks the CLI for a
claim, the CLI atomically flips one `pending` row to `claimed` and prints
the task body to stdout, and bash pipes that into a fresh `claude -p`
with the `/pick-next` system prompt appended. Claude then edits files;
each Edit/Write/MultiEdit round-trips through the hook, which grants a
file lock in the claims table (see §3) and — on the way back out —
releases it and bumps `tasks.last_progress_at` so the sweep doesn't
reclaim the task from under a live agent. When Claude finishes it calls
`batonq done <id>`, which runs the `verify_cmd` inside the repo checkout;
a non-zero exit keeps the task claimed so a subsequent pick can re-try
after a fix. If `verify` passes, the `judge_cmd` is handed to opus along
with the `git diff`; only a `PASS` verdict flips the row to `done`. The
Claude process then exits, context is implicitly cleared by the fresh
spawn, and the loop rolls to the next task. Everything a human would want
to audit is in two files: the DB row's `verify_output` / `judge_output`
columns for the gates, and `events.jsonl` for the hook-level tool trace.
