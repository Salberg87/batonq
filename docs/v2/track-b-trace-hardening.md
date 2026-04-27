# Track B — Trace Tampering Protection (batonq v2)

The v1 verify-gate added today (`countMutatingEventsSinceClaim`) treats
`events.jsonl` as a trustworthy oracle. It isn't. The hook's writer (`appendFileSync` in `agent-coord-hook`) targets a path that is reachable to every Bash call the agent makes inside `~/.claude/batonq-measurement/`. The MCP Pitfall Lab paper assumed a trusted trace producer; we don't have that. This doc designs the smallest hardening that makes the trace oracle worth gating on.

## 1. Threat model

Concrete attacks against `~/.claude/batonq-measurement/events.jsonl`, ranked by feasibility × impact:

| #   | Attack                                                                                                                                                                                                                                                  | Feasibility                                                                        | Impact                                                                                                                                      | Notes                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A   | **Append fake `Edit` events** before `batonq done` to defeat the no-edit audit. `echo '{"phase":"pre","session":"<sid>","tool":"Edit","ts":"...",...}' >> ~/.claude/batonq-measurement/events.jsonl`                                                    | Trivial. One Bash line.                                                            | High — directly defeats the only structurally-preventive anti-cheat we have.                                                                | Doesn't even require thinking about the schema — paste a real-looking line.                                               |
| B   | **Spoof `session_id`.** The session id is in the hook payload from Claude Code; agent reads it from any prior event in the log and reuses it in fake entries.                                                                                           | Trivial. `tail -1 events.jsonl \| jq .session`.                                    | High. Couples with A.                                                                                                                       | Attack A is useless without B — fakes must carry a session id the gate will recognise.                                    |
| C   | **Delete or truncate the log** to erase evidence (e.g. of an earlier abandon, of a peer's claim, or to reset audit state).                                                                                                                              | Trivial. `: > events.jsonl` or `sed -i '' '/foo/d'`.                               | Medium — verify-gate counts edits since claim, so truncation makes count = 0 → deny. But: combined with A, agent rebuilds a clean fake log. | Disk-full / crash recovery has the same shape (see §5).                                                                   |
| D   | **Race the hook mid-write.** Two processes appending simultaneously; or agent appending while hook appends. POSIX `O_APPEND` is atomic for writes ≤ `PIPE_BUF` (4 KiB on macOS), but JSONL lines from the hook are typically ~400 B so atomicity holds. | Low — hook writes are atomic in practice.                                          | Low.                                                                                                                                        | Not a real threat at our payload size. Mention but don't design for it.                                                   |
| E   | **Edit / replace the hook binary** (`~/.local/bin/batonq-hook` or `src/agent-coord-hook` if running from source). Agent shims it to a no-op.                                                                                                            | Medium — the install path is writable and the source path lives in scope.          | Critical — disables every defence.                                                                                                          | Out-of-scope for a trace-hardening pass; covered by §6. Filesystem-level mitigation (chflags / SIP) is a different track. |
| F   | **Edit the SQLite DB directly** to flip `tasks.status` or fabricate a `claimed_at`.                                                                                                                                                                     | Medium — `~/.claude/batonq/state.db` is writable; `bunx sqlite3` is on the system. | High — bypasses verify-gate entirely (status reads from DB).                                                                                | Same hardening shape (HMAC over rows or chain) but a separate doc; this design focuses on the JSONL trace.                |

**Primary threat: A + B + C as a combined attack.** The agent doesn't need to reverse-engineer the hook; it just needs to make the log look like work happened. Everything in the hardening below is aimed at making that combination detectable.

## 2. Hardening protocol

**Primary choice: hash-chained log with HMAC-keyed entries (hybrid).**

Each event line gains two fields:

```json
{ ...existing v1 fields..., "prev": "<sha256 of prior line's `mac`>", "mac": "<hex hmac-sha256 over canonical(event_minus_mac) using key K>" }
```

The chain head pointer (last known good `mac`) is mirrored to `~/.claude/batonq/chain-head` (a sibling of the SQLite DB, owned by the user, mode 0600) and to a `chain_head` row in SQLite for cross-check.

**Why this over the alternatives:**

- **Plain hash chain (no key).** Detects deletion and reordering but not append. An agent who reads the last line and computes `sha256` over its own forged line can extend the chain perfectly. We need a secret.
- **Pure HMAC, no chain.** Detects tampering of any single entry but not deletion of an entire range — the surviving entries would still each be individually valid. We need both the chain (range integrity) and the MAC (forgery resistance).
- **Separate-process writer (Unix socket / FIFO daemon).** Strongest isolation but adds a long-running process the operator must manage, recover after reboot, and reason about for crash semantics. Operator's machine is single-user; the threat is the agent subprocess, not other users. The daemon's key still has to live somewhere reachable by the dispatcher that spawned it. We get most of the benefit by hiding the key inside the dispatcher process and writing through it.
- **Sovereign Agentic Loops "Evidence Chain".** The architectural shape (intent → state observation → validation receipt) is what we're already doing at the verify-gate; the chain is the auditability layer underneath. We're adopting the chain idea, not the full control-plane decoupling — that's a v3 conversation.

**Where the key lives.** The chain key `K` is generated on first run, stored in `~/.claude/batonq/chain.key` (mode 0400). Two layers of access control:

1. The hook reads `K` directly from disk — same trust boundary as the DB.
2. **The agent's Bash environment has `BATONQ_CHAIN_KEY_PATH` redacted.** The dispatcher (`agent-coord-loop`) sets up the subprocess env with that path unset and adds a `chflags uchg` (macOS) / chattr +i (Linux) on the keyfile so even an agent that finds the path can't rewrite it. The agent _can_ still `cat` the file if it guesses the path — this is not real isolation. See §6.

The honest framing: this raises the floor from "type one bash line" to "the agent needs to (a) discover the key path, (b) read the key, (c) compute HMAC with it, (d) maintain the chain head correctly across multiple forged entries." That's a meaningfully larger lift, and it leaves a forensic trail (the `cat ~/.claude/batonq/chain.key` invocation itself appears as a `Bash` event in the chain — see §3).

## 3. Verification protocol

`countMutatingEventsSinceClaim` becomes a two-pass operation:

**Pass 1 — chain validation.** Walk the entire log forward, recomputing each entry's expected `mac` from its content and verifying `prev` matches the previous line's `mac`. The first mismatch is the **tamper point**. Compare the final entry's `mac` to the persisted `chain-head` pointer.

**Pass 2 — counting.** Only over the validated prefix, apply the existing v1 logic (filter to `phase === "pre"`, matching session, `Edit/Write/MultiEdit`, `ts >= claimedAtIso`).

**What a tampered trace looks like:**

- _Pure append (attack A without key access):_ MAC verification fails on the appended line. `mac` ≠ `hmac(K, canonical(line))` because the agent didn't have `K`. Tamper point is the appended line; pass 2 stops short of it; count for the cheating session = 0; gate denies.
- _Truncation (attack C):_ Final stored `mac` ≠ `chain-head` pointer. Gate refuses to make a count-based decision and falls back to denying done unless the operator runs `batonq trace repair` (which writes an explicit `chain_reset` event signed with `K` and a new head — only the dispatcher process, not the agent, can do this).
- _Mid-log deletion:_ Breaks `prev` linkage at the seam. Same outcome as truncation.
- _Session-id spoof with a real append + valid MAC_ (the worst case — agent has stolen `K`): undetectable from the chain alone. Falls through to §6.

**Output of the verification API** (replaces the `number` return of `countMutatingEventsSinceClaim`):

```ts
type AuditResult =
  | { kind: "ok"; count: number }
  | {
      kind: "tampered";
      tamperPoint: number;
      reason: "mac_mismatch" | "prev_break" | "head_mismatch";
    }
  | { kind: "unrunnable"; reason: string };
```

Verify-gate denies on `tampered`. `unrunnable` (missing log, missing key, missing claim ts) keeps the existing fail-open behaviour — same hook-discipline rule as today.

## 4. Concrete changes

### `events.jsonl` schema (v2)

Two new fields per line, schema version bumped:

```json
{
  "v": 2,
  "event_id": "...",
  "ts": "...",
  "phase": "pre",
  "session": "...",
  "...": "...",
  "prev": "abcd...64hex...",
  "mac": "fed0...64hex..."
}
```

`canonical(event_minus_mac)` = JSON-stringify with sorted keys, omitting `mac`. The `prev` value of the very first line is `"genesis"` (a fixed sentinel signed under `K`).

### Migration from v1

`migrate.ts` gains a one-shot routine: read existing `events.jsonl`, treat the entire content as a "v1 prefix", emit a single signed `v2_chain_init` boundary event whose payload is `{ v1_lines_sha256: <hash>, v1_line_count: N }`, then start the v2 chain from there. Old lines are not retroactively MACed (we don't have their original key — there was none); they're sealed as a single hashed blob. Verification skips counting prior to the boundary (the v1 prefix doesn't have a chain to validate against). Operator-visible: a one-line "v1 trace sealed at boundary" log entry on first v2 run.

### `hook-core.ts`

- New `appendChained(logPath, keyPath, headPath, event): Promise<void>` — opens key, reads current head, computes `mac`, appends `{...event, prev, mac}`, atomically updates head pointer (write-temp-then-rename to `chain-head`).
- New `verifyChain(logPath, keyPath, headPath): AuditResult` — pass-1 walker.
- `countMutatingEventsSinceClaim` rewritten on top of `verifyChain`: returns `AuditResult` instead of `number`.

### `agent-coord-hook`

- Replace `appendFileSync(LOG_PATH, ...)` with `appendChained(...)`.
- Verify-gate (`extractDoneEid` branch) calls the new audit and switches on `AuditResult.kind`.
- Hook-discipline preserved: any error in chain code falls open, same as today.

### New files

- `~/.claude/batonq/chain.key` — 32 random bytes, mode 0400, immutable (`chflags uchg` on macOS).
- `~/.claude/batonq/chain-head` — 64-char hex of latest mac. Mode 0600. Atomically updated.
- SQLite: new `chain_state` table (`id INTEGER PRIMARY KEY CHECK(id=1), head TEXT NOT NULL, updated_at TEXT NOT NULL`). Belt-and-braces against single-file corruption — gate refuses if disk head and DB head disagree.

### Operator commands

- `batonq trace verify` — runs `verifyChain`, prints OK / tamper-point / line numbers.
- `batonq trace repair --reason "<text>"` — emits a signed `chain_reset` event after operator confirmation, advancing the head. Only callable from the dispatcher's session id.

### Process model

No new long-running process. Same hook-as-subprocess model.

## 5. Performance + reliability

**Per-event overhead.**

- One `readFileSync` on `chain.key` (32 B, hot in OS page cache after first call): ~0.1 ms.
- One `readFileSync` on `chain-head` (64 B): ~0.1 ms.
- HMAC-SHA256 over a ~400 B canonical event: ~0.05 ms in node:crypto.
- `JSON.stringify` with sorted keys: ~0.1 ms.
- Atomic head update (`writeFile` to `chain-head.tmp` + `rename`): ~0.5 ms.

Budget: **~1 ms added per event.** Well inside the 50 ms hot-path budget. Verify-gate's pass-1 walk on a 10k-line log (~4 MB) is ~30 ms — acceptable because it only runs on `batonq done`, not every Bash. For logs >50 MB we add an incremental verifier that reads from the last verified offset (cached in `chain_state`).

**Crash / disk-full recovery (non-malicious causes).**

- _Disk full mid-append:_ `appendFileSync` is atomic at the syscall level for writes ≤ PIPE_BUF — partial lines are unusual but possible at the FS layer. `verifyChain` treats a final partial line as `tampered: prev_break` at the last good line. Recovery: `batonq trace repair --reason "disk-full <date>"` truncates to the last validated line and emits a `chain_reset`. No silent data loss — the head pointer + the chain together make the truncation visible.
- _Crash between append and head update:_ The log advanced but the head pointer didn't. Gate sees `head_mismatch`. Recovery: same `repair` command rolls head forward to the latest-validated line and emits `chain_reset`.
- _Hook killed mid-write by `timeout 300`:_ Same as crash — partial line, head un-advanced. Same recovery path.

**The recovery story is asymmetric:** `repair` requires an interactive operator confirmation (`y/N` prompt; bypass with `BATONQ_REPAIR_CONFIRMED=1` for tooling). Agents inside `claude -p` can't supply interactive input, so they can't issue their own `repair` to launder a forged chain.

## 6. What this can't catch

Honest residual surface:

1. **Agents that don't go through Claude Code's hook system.** `codex exec`, `gemini`, `opencode` — none of them call our `PostToolUse` hook. They produce no trace at all. The verify-gate already documents this caveat (CLAUDE.md hard rule #2). Trace hardening is a Claude-runner-only feature; cross-tool dogfood relies entirely on `verify_cmd` + the watchdog.

2. **Agent that reads `chain.key` directly via Bash.** We don't have real isolation. `cat ~/.claude/batonq/chain.key` works. The mitigations are detective, not preventive: (a) the `cat` itself appears as a `Bash` event in the chain, (b) `tasks-core` audit on `done` greps for any prior `Bash` event in this session that touched a path under `~/.claude/batonq/`, denies if found. Determined adversary still wins; opportunistic cheats get caught.

3. **Hook binary replacement (attack E).** Out of scope here. The dispatcher (v2) should refuse to start if `sha256(~/.local/bin/batonq-hook)` doesn't match a pinned hash recorded at install time, and the install script should `chflags uchg` the binary on macOS. That's a Track A install-integrity item, not a trace-hardening item.

4. **SQLite tampering (attack F).** Same shape as the JSONL chain (HMAC each row, chain by `claim_id`), but a separate doc. The verify-gate today reads `tasks.claimed_at` unprotected — closing this is a follow-on.

5. **Side-channel completion claims that don't go through `done`.** Agent that writes "task done" in a comment, returns a final assistant message, and exits. No `done` call → no gate → no audit fires. Watchdog catches as stale claim, post-hoc. Trace hardening doesn't help here either; this is a `done`-call-discipline problem solved at task-prompt construction time.

The honest summary: this raises the cost of the cheapest cheat from "one-line bash forge" to "discover keyfile, read it, compute HMAC, maintain chain state, and avoid leaving the keyfile read in the chain." Combined with attack #2's detective mitigation, that's enough to make the verify-gate's no-edit audit a load-bearing oracle rather than the security-theatre it currently risks being.
