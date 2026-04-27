// verify-gate.test — drives the real agent-coord-hook binary with simulated
// PreToolUse payloads to confirm the verify-gate fires only on `batonq done`
// calls, runs the task's verify_cmd inline, and emits the deny JSON shape
// Claude Code expects on failure.
//
// This is the only structurally-preventive anti-cheat measure we ship — every
// other measure (alerts, post-hoc detection, SKILL.md prompts) is detective
// or instructional. So this test file is more load-bearing than it looks: a
// regression here means cheats slip through silently.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const HOOK_BIN = join(import.meta.dir, "..", "src", "agent-coord-hook");

// Drive the hook with a synthetic Bash PreToolUse payload + an isolated HOME
// so the hook's own DB / events log point at a temp dir, not the operator's
// real ~/.claude. Returns the parsed stdout (deny JSON or empty) plus exit.
function driveHook(opts: {
  cmd: string;
  cwd: string;
  fakeHome: string;
  sessionId?: string;
}): { stdout: string; stderr: string; status: number; deny?: any } {
  const payload = {
    session_id: opts.sessionId ?? "test-session-abc",
    cwd: opts.cwd,
    tool_name: "Bash",
    tool_input: { command: opts.cmd },
  };
  const r = spawnSync("bun", [HOOK_BIN, "bash"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: opts.fakeHome },
    timeout: 30_000,
  });
  let deny: any | undefined;
  const stdout = r.stdout ?? "";
  if (stdout.trim()) {
    try {
      deny = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    } catch {
      // not JSON, leave undefined
    }
  }
  return {
    stdout,
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
    deny,
  };
}

// Seed a tasks DB at <fakeHome>/.claude/batonq/state.db with one row.
function seedTask(opts: {
  fakeHome: string;
  externalId: string;
  verifyCmd: string | null;
  claimedAt?: string | null;
  status?: string;
}): void {
  const dbDir = join(opts.fakeHome, ".claude", "batonq");
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(join(dbDir, "state.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE NOT NULL,
        repo TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        verify_cmd TEXT,
        verify_output TEXT,
        verify_ran_at TEXT,
        judge_cmd TEXT,
        judge_output TEXT,
        judge_ran_at TEXT,
        enrich_questions TEXT,
        original_body TEXT,
        last_progress_at TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        scheduled_for TEXT,
        agent TEXT,
        model TEXT,
        session_id TEXT,
        reuse_session INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'worker'
      );
    `);
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, claimed_at, created_at, verify_cmd)
       VALUES (?, 'any:infra', 'test task', ?, ?, ?, ?)`,
      [
        opts.externalId,
        opts.status ?? "claimed",
        opts.claimedAt ?? "2026-04-26T00:00:00.000Z",
        "2026-04-26T00:00:00.000Z",
        opts.verifyCmd,
      ],
    );
  } finally {
    db.close();
  }
}

// Append synthetic measurement events to <fakeHome>/.claude/batonq-measurement/events.jsonl.
// The verify-gate's tool-event audit reads this file; without it every test
// looks like a no-edit cheat and denies before verify_cmd ever runs.
function seedEvents(opts: {
  fakeHome: string;
  sessionId: string;
  events: Array<{ tool: string; phase?: "pre" | "post"; tsOffsetMs?: number }>;
  baseTs?: string;
}): void {
  const dir = join(opts.fakeHome, ".claude", "batonq-measurement");
  mkdirSync(dir, { recursive: true });
  const baseMs = Date.parse(opts.baseTs ?? "2026-04-26T01:00:00.000Z");
  const lines = opts.events
    .map((e, i) => {
      const ts = new Date(baseMs + (e.tsOffsetMs ?? i * 1000)).toISOString();
      return JSON.stringify({
        event_id: `test-${i}`,
        ts,
        phase: e.phase ?? "pre",
        session: opts.sessionId,
        cwd: "/tmp",
        git_root: "/tmp",
        tool: e.tool,
        paths: ["/tmp/x"],
        hashes: {},
      });
    })
    .join("\n");
  appendFileSync(join(dir, "events.jsonl"), lines + "\n");
}

// Each test gets a fresh git repo under `${fakeHome}/DEV/test-repo` because
// the hook's `inScope()` check requires the cwd path to begin with
// `${HOME}/DEV/` or `${HOME}/dev/`. Without an in-scope cwd the hook returns
// early before any gate evaluation.
function makeFixture(): {
  fakeHome: string;
  cwd: string;
  cleanup: () => void;
} {
  // realpathSync resolves macOS's /var/folders → /private/var/folders symlink.
  // Without this, `git rev-parse --show-toplevel` returns the resolved path
  // while HOME is the symlinked one, and the hook's inScope() check fails.
  const fakeHome = realpathSync(
    mkdtempSync(join(tmpdir(), "verify-gate-home-")),
  );
  const cwd = join(fakeHome, "DEV", "test-repo");
  mkdirSync(cwd, { recursive: true });
  // Init git so resolveGitRoot() succeeds.
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd });
  spawnSync("git", ["config", "user.name", "t"], { cwd });
  return {
    fakeHome,
    cwd,
    cleanup: () => rmSync(fakeHome, { recursive: true, force: true }),
  };
}

describe("verify-gate (PreToolUse hook integration)", () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  test("denies `batonq done` when verify_cmd exits non-zero", () => {
    const eid = "abcdef0123456789";
    const session = "test-session-abc";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "exit 7",
    });
    // Seed a mutating event so the tool-event audit passes and we reach
    // verify_cmd — otherwise the audit denies first with a no-edits message.
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: session,
      events: [{ tool: "Edit" }],
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeTruthy();
    expect(r.deny.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /verify-gate/,
    );
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /exit 7/,
    );
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /abcdef01/,
    );
    expect(r.status).toBe(0); // hook still exits 0; deny is in JSON, not exit code
  });

  test("allows `batonq done` when verify_cmd exits 0", () => {
    const eid = "feedfacefeedface";
    const session = "test-session-abc";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true",
    });
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: session,
      events: [{ tool: "Write" }],
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeUndefined();
    expect(r.status).toBe(0);
  });

  test("allows `batonq done` when no verify_cmd configured (gate is opt-in via verify_cmd)", () => {
    const eid = "1234567890abcdef";
    const session = "test-session-abc";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: null,
    });
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: session,
      events: [{ tool: "MultiEdit" }],
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeUndefined();
    expect(r.status).toBe(0);
  });

  test("allows non-`done` commands (gate must not fire on regular Bash)", () => {
    const r = driveHook({
      cmd: "ls -la",
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
    });
    expect(r.deny).toBeUndefined();
    expect(r.status).toBe(0);
  });

  test("denies on verify failure even when called via `&& chain`", () => {
    const eid = "cafebabecafebabe";
    const session = "test-session-abc";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "exit 1",
    });
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: session,
      events: [{ tool: "Edit" }],
    });
    const r = driveHook({
      cmd: `git push origin main && batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeTruthy();
    expect(r.deny.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  // ── Tool-event audit (zero-edit-cheat detection) ─────────────────────────
  // The audit fires BEFORE verify_cmd: an agent that calls `batonq done`
  // without ever invoking Edit/Write/MultiEdit since claim is the canonical
  // "no work" cheat. The audit catches it even when verify_cmd would have
  // passed for unrelated reasons (peer commit, lenient script, etc.).

  test("audit denies when no Edit/Write/MultiEdit events exist for this session since claim", () => {
    const eid = "1111111111111111";
    const session = "no-work-session";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true", // would pass — but audit fires first
      claimedAt: "2026-04-26T00:00:00.000Z",
    });
    // No seedEvents call — the audit log is empty for this session.
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeTruthy();
    expect(r.deny.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /no edits since claim/,
    );
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /agent did not actually do the work/,
    );
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /11111111/,
    );
  });

  test("audit allows when at least one mutating event exists since claim (and verify_cmd passes)", () => {
    const eid = "2222222222222222";
    const session = "good-work-session";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true",
      claimedAt: "2026-04-26T00:00:00.000Z",
    });
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: session,
      events: [
        { tool: "Read" }, // ignored
        { tool: "Edit" }, // counts
      ],
      baseTs: "2026-04-26T00:30:00.000Z", // after claimed_at
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeUndefined();
    expect(r.status).toBe(0);
  });

  test("audit denies a Read-only session (Read events alone are not work)", () => {
    const eid = "3333333333333333";
    const session = "read-only-session";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true",
      claimedAt: "2026-04-26T00:00:00.000Z",
    });
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: session,
      events: [
        { tool: "Read" },
        { tool: "Read" },
        { tool: "Bash" }, // ls/grep don't count either
      ],
      baseTs: "2026-04-26T00:30:00.000Z",
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeTruthy();
    expect(r.deny.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /no edits since claim/,
    );
  });

  test("audit ignores edits from a different session (cross-session contamination)", () => {
    const eid = "4444444444444444";
    const session = "victim-session";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true",
      claimedAt: "2026-04-26T00:00:00.000Z",
    });
    // Edit events exist — but from a *different* session. Must not satisfy
    // the audit for the cheating session.
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: "some-other-session",
      events: [{ tool: "Edit" }, { tool: "Write" }],
      baseTs: "2026-04-26T00:30:00.000Z",
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeTruthy();
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /no edits since claim/,
    );
  });

  test("audit ignores edits from before the task was claimed", () => {
    const eid = "5555555555555555";
    const session = "stale-edits-session";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true",
      claimedAt: "2026-04-26T12:00:00.000Z",
    });
    // Edits exist for this session but predate the claim — agent did the
    // work for a previous task and is now trying to coast on those events.
    seedEvents({
      fakeHome: fx.fakeHome,
      sessionId: session,
      events: [{ tool: "Edit" }, { tool: "Write" }],
      baseTs: "2026-04-25T00:00:00.000Z",
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: session,
    });
    expect(r.deny).toBeTruthy();
    expect(r.deny.hookSpecificOutput.permissionDecisionReason).toMatch(
      /no edits since claim/,
    );
  });

  test("audit fails open when claimed_at is unparsable", () => {
    const eid = "6666666666666666";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true",
      claimedAt: "not-a-date",
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
      sessionId: "bad-claim-ts-session",
    });
    expect(r.deny).toBeUndefined();
    expect(r.status).toBe(0);
  });

  test("fails open when task row is missing (don't break agents on bad eid)", () => {
    // No seedTask call — the eid the agent passes doesn't exist.
    const r = driveHook({
      cmd: "batonq done deadbeefdeadbeef",
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
    });
    expect(r.deny).toBeUndefined();
    expect(r.status).toBe(0);
  });
});
