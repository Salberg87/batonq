# FAQ

**Something isn't working — where do I start?**
Run `batonq doctor`. It walks five categories — Binaries, Installation, State,
Scope, Live — and prints `✓ / ⚠ / ✗` per row with a `fix:` hint on every
non-pass. Exit code is 0 when nothing critical is wrong, 1 otherwise. The
output is designed to paste straight into a bug report. Doctor is read-only:
it never edits settings, recreates the DB, or touches your tasks.

**How does this differ from Claude Squad / ccswarm?**
Claude Squad and ccswarm are workspace orchestrators: they own the tmux
layout, the agent lifecycle, and the overall mental model. batonq is the
opposite end of the design space — a single binary wrapping a shared queue
and a file lock, meant to be composed with whatever you already use. If you
want a product, use Squad. If you want a primitive, use batonq.

**What happens if an agent crashes mid-task?**
Nothing stays stuck. Each session has a heartbeat; when it stops, its claims
and file locks go stale. `batonq sweep` (or the TUI running in the
background) reclaims them. The task flips back to `pending` and any other
agent with a matching scope can pick it up.

**Can it coordinate across machines?**
Not yet — state lives in a local SQLite DB (`~/.claude/batonq-state.db`)
and locks use `flock(2)` on the local filesystem. Cross-machine would need
either a hosted DB + lock service or a syncing agent; that's deliberately
out of scope for v0.x. If you mount `~/.claude` over NFS with working byte
locking you get a janky version of it, but I don't recommend it.

**How much overhead does the hook add?**
The PreToolUse hook runs with a 2s timeout and does a single SQLite SELECT
plus one optional INSERT — sub-millisecond in the common case, dominated by
SQLite startup cost (~1–5ms per invocation). The hook fails open: if it
can't reach the DB, the tool call still runs. Measure it yourself on your
own machine with `batonq report --since ...`.

**How do I debug a failing verify gate?**
Three places to look. First, `batonq tail -n 50` — the `verify-failed`
event carries the exit code and captured stderr. Second, `batonq mine` shows
the task still claimed by you with the last error attached. Third, re-run
the gate by hand (`cd <repo> && <the verify command>`) to see full output.
Abandon with `batonq abandon <id>` once you've investigated.

**Where do I find the loop's stdout?**
`batonq-loop` run from the TUI (`L` keybind) detaches via `nohup` and writes
stdout+stderr to `/tmp/batonq-loop.log`. The fastest way to read it alongside
hook events is `batonq logs -f` — it merges the newest `/tmp/batonq-loop*.log`
with `events.jsonl`, paints events cyan and loop lines yellow (errors red),
and polls every 500 ms in follow mode. Filter with `--source loop` to see the
bash script's output only, or `--source events` for hook events only.

**My task never gets picked up.**
`pick` matches on repo scope. A task with `repo: orghub` only fires in a cwd
whose git-root basename is `orghub`; `any:<tag>` tasks match any cwd. Confirm
what's actually queued with `batonq tasks` and note the `scope` column — then
either `cd` into the matching repo, or re-file the task with
`batonq add --repo any:infra --body "..."` so any loop can grab it. If the
task _is_ scoped correctly and still isn't picked, check `batonq status` for
someone else already holding it, and `batonq doctor` for a broken install
(missing hook, stale DB path) that would silently skip candidates.

**Verify failed, but my code is correct.**
Re-run the gate by hand in the same cwd the loop used: `cd <repo> && <verify
cmd>`. `batonq tail -n 30` shows the last `verify-failed` event with exit code
and captured stderr. Three usual culprits: the gate depends on a binary not on
the loop's `PATH` (e.g. `gtimeout`, `bun` not linked), the gate is flaky
(timeouts, ports), or shell-escaping mangled the command. If the gate itself
is wrong, `batonq abandon <id>` and rewrite the `verify:` line; if it's a real
failure, fix the code and re-run `batonq done <id>`.

**The loop seems to sleep too long.**
`batonq-loop` sleeps 60s between `claude -p` invocations when `pick` returns
`NO_TASK`. That's expected — there's nothing to do, so the loop stays quiet.
Confirm the queue is actually empty with `batonq status` (`pending: 0`). If
pending tasks exist and the loop still sleeps, the scope doesn't match the
loop's cwd (see "My task never gets picked up"). The footer's events-age cell
goes yellow past 300s and red past 600s — once it's red, the watchdog will
restart the loop on its own, or press `L` in the TUI to restart manually.

**Can I run two loops in parallel?**
Yes, as long as each runs in a different cwd. Two loops in `~/DEV/orghub` and
`~/DEV/pifre-crm` will naturally claim different tasks — the DB locks enforce
one-claim-per-task, and file-scope locks stop them from editing the same path.
The catch: `batonq-loop`'s liveness watchdog tails the shared
`~/.claude/batonq-measurement/events.jsonl`. If only one loop is making
progress, the other's log-staleness alarm won't fire because the peer's writes
keep the file warm. Rule of thumb: at most one `batonq-loop` per host, or give
each loop its own events log via `BATONQ_EVENTS_LOG=...`.

**The TUI crashes.**
First capture stderr so the trace isn't lost to the alt-screen flip:
`batonq tui 2> /tmp/batonq-tui.err`, reproduce, then `head -n 80
/tmp/batonq-tui.err`. Most crashes are one of: terminal narrower than 80
cols, a corrupt state DB (rare; `batonq doctor` flags it), or an Ink render
bug against an odd task row. File it at
<https://github.com/Salberg87/batonq/issues> with that stderr excerpt plus
`batonq doctor` output. Workaround until it's fixed: `batonq tasks` + `batonq
logs -f` covers 90% of what the TUI shows.

**Install failed with `Cannot find module …`.**
Means `bun build --compile` fell back to shell wrappers and the `src/` copy
step didn't land (older bun, interrupted install, or a PATH pointing at a
stale `~/.local/bin/batonq`). Fix:

```sh
bun upgrade                                         # get a recent bun
curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/uninstall.sh | sh --keep-state
curl -fsSL https://raw.githubusercontent.com/Salberg87/batonq/main/install.sh | sh
```

If that still fails, vendor the repo manually — no compile needed — and
symlink the `bin/` wrappers onto your PATH:

```sh
git clone https://github.com/Salberg87/batonq.git ~/.local/share/batonq
cd ~/.local/share/batonq && bun install
ln -sf "$PWD"/bin/* ~/.local/bin/
```

**I added tasks to `~/DEV/TASKS.md` but `pick` doesn't see them.**
`TASKS.md` is no longer a live sync target — the DB is authoritative. On every
upgrade `install.sh` runs `batonq import ~/DEV/TASKS.md` once, but edits made
afterwards stay in the file. Run `batonq import ~/DEV/TASKS.md` (or the legacy
`batonq sync-tasks`) to flush them into the DB, then verify with
`batonq tasks | grep pending`. Going forward, prefer `batonq add --body "..."`
or `batonq import <file>.yaml` so the DB is the only writer.

**`judge:` fails on tasks that look fine.**
`judge:` is an LLM call — small prompt changes flip verdicts. Grab the raw
output from `batonq tail -n 50` (`judge-failed` event carries `judge_output`)
and read what the judge actually objected to. Four common fixes: (1) the
`judge:` prompt says "production-ready" or similar absolutes — loosen to the
minimum the change needs to prove; (2) the prompt asks for behaviour not in
the diff — reference specific files/symbols; (3) the prompt is in Norwegian
but the diff is English (or vice-versa) — match the working language; (4) the
work genuinely isn't done. If you don't need a second layer, drop the
`judge:` directive and rely on `verify:` alone.

**Where is `state.db`? How do I inspect it?**
`~/.claude/batonq/state.db` (directory-based since arch-2; older installs had
`~/.claude/batonq-state.db` and get auto-migrated on first `batonq` run).
Read it live — writes are transactional, so a concurrent loop won't corrupt
your query:

```sh
sqlite3 ~/.claude/batonq/state.db '.tables'
sqlite3 -header -column ~/.claude/batonq/state.db \
  "SELECT external_id, status, scope, claimed_by FROM tasks ORDER BY created_at DESC LIMIT 20;"
sqlite3 -header -column ~/.claude/batonq/state.db \
  "SELECT * FROM claims;"
```

`batonq tasks` and `batonq status` cover the common views without SQL.

**An agent marked a task `done` without actually doing the work.**
The TUI flags this as `juks-done` — a done task where `verify_cmd` is set but
`verify_ran_at` and `judge_ran_at` are both null, meaning the agent closed
the claim past the gate. Confirm on the DB:

```sh
sqlite3 -header -column ~/.claude/batonq/state.db \
  "SELECT external_id, status, verify_cmd, verify_ran_at, judge_ran_at
     FROM tasks WHERE external_id='<id>';"
```

If `verify_ran_at` is `NULL` on a task with a `verify_cmd`, re-queue it:

```sh
sqlite3 ~/.claude/batonq/state.db \
  "UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL
     WHERE external_id='<id>';"
```

Structural fix: give every non-trivial task a `verify:` line so the gate has
to run before `done` sticks, and watch the TUI's `juks-done` badge during
rollouts of new prompts.
