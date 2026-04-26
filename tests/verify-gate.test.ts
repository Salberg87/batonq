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
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "exit 7",
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
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
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "true",
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
    });
    expect(r.deny).toBeUndefined();
    expect(r.status).toBe(0);
  });

  test("allows `batonq done` when no verify_cmd configured (gate is opt-in via verify_cmd)", () => {
    const eid = "1234567890abcdef";
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: null,
    });
    const r = driveHook({
      cmd: `batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
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
    seedTask({
      fakeHome: fx.fakeHome,
      externalId: eid,
      verifyCmd: "exit 1",
    });
    const r = driveHook({
      cmd: `git push origin main && batonq done ${eid}`,
      cwd: fx.cwd,
      fakeHome: fx.fakeHome,
    });
    expect(r.deny).toBeTruthy();
    expect(r.deny.hookSpecificOutput.permissionDecision).toBe("deny");
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
