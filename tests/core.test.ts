// core.test — exercises the pure task and hook cores against an in-memory SQLite
// DB and tmpdir fixtures. No touching of ~/.claude state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  appendClarifyingAnswers,
  appendTaskToPending,
  applyEnrichment,
  claimCandidate,
  enrichTaskBody,
  externalId,
  getGitDiffSinceClaim,
  initClaimsSchema,
  initTaskSchema,
  parseEnrichResponse,
  parseTasksFile,
  parseTasksText,
  promoteDraftToPending,
  rewriteMdTaskStatus,
  runJudge,
  runVerify,
  selectCandidate,
  sweepClaims,
  sweepTasks,
  syncTasks,
  TASK_CLAIM_TTL_MS,
  TASK_RECOVERY_HEARTBEAT_MS,
  type ParsedTask,
  type SpawnFn,
  type SpawnResult,
  type TaskRecoveryContext,
} from "../src/tasks-core";
import {
  DESTRUCTIVE,
  MAX_HASH_BYTES,
  extractBashPaths,
  hashFile,
} from "../src/hook-core";

// ── shared helpers ────────────────────────────────────────────────────────────

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const BATONQ_BIN = join(REPO_ROOT, "bin", "batonq");

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "batonq-core-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function memDb(): Database {
  const db = new Database(":memory:");
  initTaskSchema(db);
  initClaimsSchema(db);
  return db;
}

// ── 1. parseTasksFile: skip HTML comments and code fences ─────────────────────

describe("parseTasksFile", () => {
  test("skips HTML-comment blocks and fenced code blocks", () => {
    const tasksPath = join(workdir, "TASKS.md");
    const fixture = [
      "# Tasks",
      "",
      "<!--",
      "- [ ] **any:infra** — commented-out task that should be ignored",
      "-->",
      "",
      "```md",
      "- [ ] **any:example** — example inside a fence, must be ignored",
      "```",
      "",
      "- [ ] **batonq** — real task A",
      "- [x] 2026-04-23 **any:infra** — real task B done",
      "",
    ].join("\n");
    writeFileSync(tasksPath, fixture);

    const { tasks } = parseTasksFile(tasksPath);
    expect(tasks.map((t) => `${t.repo}:${t.body}:${t.status}`)).toEqual([
      "batonq:real task A:pending",
      "any:infra:real task B done:done",
    ]);
  });

  test("handles single-line HTML comments that open and close on same line", () => {
    const { tasks } = parseTasksText(
      [
        "<!-- hidden in one line --> still text",
        "- [ ] **repo-x** — visible task",
      ].join("\n"),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.repo).toBe("repo-x");
  });

  // Regression: previously the parser only peeked at line i+1 for verify:/judge:
  // so a multi-paragraph body with indented prose between the task line and the
  // directive lost the gates entirely. New contract: scan the whole task block
  // until the next `- [ ]` or EOF.

  test("captures verify: in multi-paragraph body (directive 3 lines below task)", () => {
    const { tasks } = parseTasksText(
      [
        "- [ ] **any:infra** — multi-line task with prose before gate",
        "",
        "  Some indented continuation paragraph that describes the task.",
        "  verify: echo ok",
        "",
        "- [ ] **other** — next task",
      ].join("\n"),
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.verifyCmd).toBe("echo ok");
    expect(tasks[0]?.judgeCmd).toBeUndefined();
    // Directive must not leak into the following task
    expect(tasks[1]?.verifyCmd).toBeUndefined();
  });

  test("multi-paragraph body with both verify: and judge: on non-adjacent lines", () => {
    const { tasks } = parseTasksText(
      [
        "- [ ] **any:infra** — multi-paragraph indented task",
        "",
        "  First paragraph of prose.",
        "",
        "  **Fix A:** some bolded sub-heading in the body.",
        "",
        "  Another paragraph before the gates.",
        "  verify: run-verify.sh",
        "  judge: is this correct? PASS/FAIL.",
        "",
        "- [ ] **next** — boundary",
      ].join("\n"),
    );
    expect(tasks[0]?.verifyCmd).toBe("run-verify.sh");
    expect(tasks[0]?.judgeCmd).toBe("is this correct? PASS/FAIL.");
  });

  test("verify: inside a fenced code block is NOT captured as a directive", () => {
    const { tasks } = parseTasksText(
      [
        "- [ ] **any:infra** — task demonstrating a code block",
        "",
        "  Example command the user might paste:",
        "",
        "  ```bash",
        "  verify: this-is-documentation-not-a-gate",
        "  ```",
        "",
        "  verify: actual-verify-cmd",
        "",
        "- [ ] **next** — boundary",
      ].join("\n"),
    );
    expect(tasks[0]?.verifyCmd).toBe("actual-verify-cmd");
  });

  test("task with no verify/judge returns undefined for both", () => {
    const { tasks } = parseTasksText(
      [
        "- [ ] **any:infra** — task with no directives at all",
        "",
        "  Just some prose, no gates here.",
        "",
        "- [ ] **next** — another bare task",
      ].join("\n"),
    );
    expect(tasks[0]?.verifyCmd).toBeUndefined();
    expect(tasks[0]?.judgeCmd).toBeUndefined();
    expect(tasks[1]?.verifyCmd).toBeUndefined();
    expect(tasks[1]?.judgeCmd).toBeUndefined();
  });

  test("first occurrence wins when a directive appears multiple times", () => {
    const { tasks } = parseTasksText(
      [
        "- [ ] **any:infra** — duplicate-directive task",
        "  verify: first-verify",
        "  verify: second-verify-should-be-ignored",
        "  judge: first-judge",
        "  judge: second-judge-should-be-ignored",
      ].join("\n"),
    );
    expect(tasks[0]?.verifyCmd).toBe("first-verify");
    expect(tasks[0]?.judgeCmd).toBe("first-judge");
  });

  test("dogfood fixture mirroring task 26f32c3d1104 (multi-paragraph with hidden verify/judge)", () => {
    // This fixture reproduces the exact structure of the "TUI add-task hardening"
    // task from ~/DEV/TASKS.md that the old parser was missing: multi-paragraph
    // prose body with bolded sub-headings and BOTH verify/judge on the last two
    // lines of the block. External id for ("any:infra", body) = 26f32c3d1104.
    const body =
      "TUI add-task hardening (basert på judge-FAIL fra 8e1dba0a2439). Judge-dommen identifiserte to issues: (3) auto-refresh-delay opptil 2s etter submit før task vises i listen, og (4) kritisk race condition i `appendTaskToPending` — ingen flock/atomic rename, to samtidige TUI-instanser som begge trykker `n` vil overskrive hverandres tasks silent. Fiks begge i `~/DEV/batonq/src/tui.tsx` + core:";
    const fixture = [
      `- [x] 2026-04-23 **any:infra** — ${body}`,
      "",
      "  **Fix 4 (race condition, kritisk):** endre `appendTaskToPending` til å bruke atomic rename-pattern.",
      "",
      "  **Fix 3 (refresh-delay):** etter submit, trigger umiddelbar refresh.",
      "",
      '  Legg til 2 nye tester. Commit: "fix(tui): race-safe task append + immediate post-submit refresh".',
      "  verify: cd /Users/fsalb/DEV/batonq && bun test tests/tui.test.ts",
      "  judge: Ble begge issues faktisk fikset? PASS/FAIL + per-punkt-vurdering.",
      "",
      "- [ ] **any:infra** — the task that comes right after — must NOT inherit directives",
    ].join("\n");
    const { tasks } = parseTasksText(fixture);
    expect(tasks).toHaveLength(2);
    const [hardening, next] = tasks;
    expect(externalId(hardening!.repo, hardening!.body)).toBe("26f32c3d1104");
    expect(hardening!.verifyCmd).toBe(
      "cd /Users/fsalb/DEV/batonq && bun test tests/tui.test.ts",
    );
    expect(hardening!.judgeCmd).toBe(
      "Ble begge issues faktisk fikset? PASS/FAIL + per-punkt-vurdering.",
    );
    expect(next!.verifyCmd).toBeUndefined();
    expect(next!.judgeCmd).toBeUndefined();
  });
});

// ── 2. externalId: deterministic + collision-free across repo+body ────────────

describe("externalId", () => {
  test("deterministic for identical repo+body, distinct for different inputs", () => {
    const a = externalId("repo-a", "ship feature X");
    const a2 = externalId("repo-a", "ship feature X");
    const b = externalId("repo-b", "ship feature X");
    const c = externalId("repo-a", "ship feature Y");

    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ── 3. syncTasks: insert + update + done-transition ───────────────────────────

describe("syncTasks", () => {
  test("insert new pending, skip duplicate, transition to done on second sync", () => {
    const db = memDb();
    const t: ParsedTask = {
      repo: "batonq",
      body: "add tests",
      status: "pending",
      lineIdx: 0,
    };

    const r1 = syncTasks(db, [t], "2026-04-23T10:00:00.000Z");
    expect(r1).toEqual({ added: 1, completed: 0, parsed: 1 });

    // Second sync with same pending task: no new inserts
    const r2 = syncTasks(db, [t], "2026-04-23T10:01:00.000Z");
    expect(r2).toEqual({ added: 0, completed: 0, parsed: 1 });

    // Now mark done in the parsed input → syncTasks should transition
    const tDone: ParsedTask = { ...t, status: "done" };
    const r3 = syncTasks(db, [tDone], "2026-04-23T10:02:00.000Z");
    expect(r3.completed).toBe(1);

    const row = db
      .query("SELECT status, completed_at FROM tasks WHERE repo = ?")
      .get("batonq") as any;
    expect(row.status).toBe("done");
    expect(row.completed_at).toBe("2026-04-23T10:02:00.000Z");
    db.close();
  });
});

// ── 4. pick scope-logic: in-git → repo+any, out-of-git → only any:* ───────────

describe("selectCandidate (pick scope)", () => {
  test("in-repo picks match repo OR any:*, out-of-repo picks only any:*", () => {
    const db = memDb();
    const mk = (
      repo: string,
      body: string,
      status: "pending" | "done" = "pending",
    ) =>
      syncTasks(
        db,
        [{ repo, body, status, lineIdx: 0 }],
        "2026-04-23T10:00:00.000Z",
      );
    mk("repo-a", "task for A");
    mk("repo-b", "task for B");
    mk("any:infra", "global infra task");

    const inA = selectCandidate(db, { repo: "repo-a" });
    expect(inA.repo).toBe("repo-a");

    // Mark repo-a's only task claimed so next pick in repo-a falls back to any:*
    db.run("UPDATE tasks SET status = 'claimed' WHERE repo = 'repo-a'");
    const inAFallback = selectCandidate(db, { repo: "repo-a" });
    expect(inAFallback.repo).toBe("any:infra");
    // repo-b task must not leak into repo-a's candidate set
    expect(inAFallback.repo).not.toBe("repo-b");

    // Not in a git repo → only any:* candidates
    const outside = selectCandidate(db, { repo: null });
    expect(outside.repo).toBe("any:infra");

    // After the any:* task is claimed too, out-of-git pick returns undefined/null
    db.run("UPDATE tasks SET status = 'claimed' WHERE repo = 'any:infra'");
    const empty = selectCandidate(db, { repo: null });
    expect(empty).toBeFalsy();
    db.close();
  });
});

// ── 5. pick atomic claim: two picks don't grab the same task ──────────────────

describe("claimCandidate atomicity", () => {
  test("second claimer sees 0 changes on an already-claimed row", () => {
    const db = memDb();
    syncTasks(
      db,
      [{ repo: "batonq", body: "sole task", status: "pending", lineIdx: 0 }],
      "2026-04-23T10:00:00.000Z",
    );
    const row = selectCandidate(db, { repo: "batonq" });
    expect(row).toBeTruthy();

    const first = claimCandidate(
      db,
      row.id,
      "session-A",
      "2026-04-23T10:00:01.000Z",
    );
    const second = claimCandidate(
      db,
      row.id,
      "session-B",
      "2026-04-23T10:00:02.000Z",
    );
    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);

    // Winner must be session-A, not overwritten by B
    const after = db
      .query("SELECT claimed_by FROM tasks WHERE id = ?")
      .get(row.id) as any;
    expect(after.claimed_by).toBe("session-A");
    db.close();
  });
});

// ── 6. sweep: release expired claims, leave active claims alone ───────────────

describe("sweepClaims", () => {
  test("releases expired and leaves active claims untouched", () => {
    const db = memDb();
    const now = "2026-04-23T12:00:00.000Z";
    const past = "2026-04-23T11:00:00.000Z";
    const future = "2026-04-23T13:00:00.000Z";

    // One expired claim, one still-active claim
    db.run(
      `INSERT INTO claims (fingerprint, file_path, session_id, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["fp", "/workdir/stale.ts", "sess-A", past, past],
    );
    db.run(
      `INSERT INTO claims (fingerprint, file_path, session_id, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["fp", "/workdir/live.ts", "sess-B", past, future],
    );

    const res = sweepClaims(db, now);
    expect(res.expired).toBe(1);

    const stale = db
      .query("SELECT released_at FROM claims WHERE file_path = ?")
      .get("/workdir/stale.ts") as any;
    const live = db
      .query("SELECT released_at FROM claims WHERE file_path = ?")
      .get("/workdir/live.ts") as any;
    expect(stale.released_at).toBe(now);
    expect(live.released_at).toBeNull();
    db.close();
  });
});

// ── 7. verify-gate: exit code drives pass/fail ────────────────────────────────

describe("runVerify", () => {
  test("exit 0 = pass, non-zero exit propagates", () => {
    const pass = runVerify("exit 0", workdir, "tid-ok");
    expect(pass.code).toBe(0);

    const fail = runVerify("exit 7", workdir, "tid-bad");
    expect(fail.code).toBe(7);

    // Verify AGENT_COORD_* env is plumbed through to the verify command
    const withEnv = runVerify(
      "echo $AGENT_COORD_TASK_ID:$AGENT_COORD_REPO_ROOT",
      workdir,
      "tid-xyz",
    );
    expect(withEnv.code).toBe(0);
    expect(withEnv.output).toContain("tid-xyz:" + workdir);
  });
});

// ── 8. --skip-verify requires AGENT_COORD_ALLOW_SKIP=1 ────────────────────────

describe("done --skip-verify gate", () => {
  test("fails with exit 2 unless AGENT_COORD_ALLOW_SKIP=1 is set", () => {
    // Isolate in a fresh HOME so we don't touch the real ~/.claude DB.
    const fakeHome = mkdtempSync(join(tmpdir(), "batonq-home-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    try {
      const withoutEnv = spawnSync(
        BATONQ_BIN,
        ["done", "--skip-verify", "nope123456"],
        {
          env: { ...process.env, HOME: fakeHome, PATH: process.env.PATH ?? "" },
          encoding: "utf8",
        },
      );
      expect(withoutEnv.status).toBe(2);
      const stderr = withoutEnv.stderr ?? "";
      expect(stderr).toMatch(/AGENT_COORD_ALLOW_SKIP=1/);

      const withEnv = spawnSync(
        BATONQ_BIN,
        ["done", "--skip-verify", "nope123456"],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            PATH: process.env.PATH ?? "",
            AGENT_COORD_ALLOW_SKIP: "1",
          },
          encoding: "utf8",
        },
      );
      // Gate passed → failure is now "no task with that external_id", not the gate (exit != 2).
      expect(withEnv.status).not.toBe(2);
      expect((withEnv.stderr ?? "") + (withEnv.stdout ?? "")).toMatch(
        /No task with external_id/,
      );
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ── 9. rewriteMdTaskStatus: [ ] → [x], surrounding content preserved ──────────

describe("rewriteMdTaskStatus", () => {
  test("flips single task to done in place, preserves neighboring lines", () => {
    const tasksPath = join(workdir, "TASKS.md");
    const before = [
      "# Queue",
      "",
      "<!-- header comment, must remain -->",
      "- [ ] **batonq** — write the core test",
      "some trailing prose about priorities",
      "- [ ] **other-repo** — unrelated pending task",
      "",
    ].join("\n");
    writeFileSync(tasksPath, before);

    const ok = rewriteMdTaskStatus(
      tasksPath,
      "batonq",
      "write the core test",
      "done",
      "2026-04-23",
    );
    expect(ok).toBe(true);

    const after = readFileSync(tasksPath, "utf8");
    expect(after).toContain(
      "- [x] 2026-04-23 **batonq** — write the core test",
    );
    // Surrounding context intact
    expect(after).toContain("<!-- header comment, must remain -->");
    expect(after).toContain("some trailing prose about priorities");
    // The other pending task must remain [ ]
    expect(after).toContain("- [ ] **other-repo** — unrelated pending task");
  });
});

// ── 10. hashFile: null for missing, partial+size for large files ──────────────

describe("hashFile", () => {
  test("returns null for missing file", () => {
    expect(hashFile(join(workdir, "does-not-exist.txt"))).toBeNull();
  });

  test("small file: hash covers full content; large file: partial + size marker", () => {
    const smallPath = join(workdir, "small.bin");
    writeFileSync(smallPath, "hello batonq");
    const smallHash = hashFile(smallPath);
    expect(smallHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Two files with identical first MAX_HASH_BYTES but different total sizes
    // must hash differently because the large-file branch mixes in `|size=N`.
    const aPath = join(workdir, "exact.bin");
    const bPath = join(workdir, "over.bin");
    const buf = Buffer.alloc(MAX_HASH_BYTES + 1, 0x41); // 1 byte over threshold
    writeFileSync(aPath, buf.subarray(0, MAX_HASH_BYTES)); // exactly at threshold
    writeFileSync(bPath, buf); // one byte larger, same prefix
    const aHash = hashFile(aPath);
    const bHash = hashFile(bPath);
    expect(aHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(aHash).not.toBe(bHash);
  });
});

// ── 11. extractBashPaths: filter flags and command keywords ───────────────────

describe("extractBashPaths", () => {
  test("keeps existing paths, drops flags and bare command keywords", () => {
    const realFile = join(workdir, "target.txt");
    writeFileSync(realFile, "x");
    const cmd = `rm -rf ${realFile} -v --force missing.txt`;
    const out = extractBashPaths(cmd, workdir);
    expect(out).toContain(realFile);
    // Flags (`-rf`, `-v`, `--force`) excluded
    expect(out.some((p) => p.includes("-rf"))).toBe(false);
    expect(out.some((p) => p.endsWith("-v"))).toBe(false);
    expect(out.some((p) => p.includes("--force"))).toBe(false);
    // Bare keyword `rm` excluded
    expect(out.some((p) => p.endsWith("/rm"))).toBe(false);
    // Non-existent `missing.txt` excluded by existsSync filter
    expect(out.some((p) => p.endsWith("missing.txt"))).toBe(false);
  });
});

// ── 12. DESTRUCTIVE regex: quote-aware ────────────────────────────────────────

describe("DESTRUCTIVE regex", () => {
  test("matches real destructive commands but not destructive-looking strings inside quotes", () => {
    // Positives: real destructive commands
    expect(DESTRUCTIVE.test("rm -rf /tmp/scratch")).toBe(true);
    expect(DESTRUCTIVE.test("mv a b")).toBe(true);
    expect(DESTRUCTIVE.test("echo before; rm /tmp/x")).toBe(true);
    expect(DESTRUCTIVE.test("git reset --hard HEAD~1")).toBe(true);
    expect(DESTRUCTIVE.test("dd of=/tmp/out")).toBe(true);

    // Negative: destructive token sits inside a quoted string → must not match
    expect(DESTRUCTIVE.test(`echo "rm -rf" > note.md`)).toBe(false);
    expect(DESTRUCTIVE.test(`echo 'mv a b' > note.md`)).toBe(false);
    // Plain non-destructive commands
    expect(DESTRUCTIVE.test("echo hello world")).toBe(false);
    expect(DESTRUCTIVE.test("ls -la")).toBe(false);
  });
});

// ── 13. runJudge fail-modes (hardened per /tmp/agent-coord-audit.md) ──────────

describe("runJudge fail-modes", () => {
  const fakeSpawn =
    (r: Partial<SpawnResult>): SpawnFn =>
    () => ({
      status: r.status ?? 0,
      signal: r.signal ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      error: r.error ?? null,
    });

  test("ETIMEDOUT returns infra FAIL, never PASS — even if stdout says PASS", () => {
    const err = Object.assign(new Error("etimedout"), { code: "ETIMEDOUT" });
    const res = runJudge(
      "judge",
      "diff",
      "/tmp",
      fakeSpawn({
        status: null,
        signal: "SIGTERM",
        stdout: "PASS ok",
        error: err,
      }),
    );
    expect(res.passed).toBe(false);
    expect(res.output).toContain("[judge infra FAIL]");
    expect(res.output).toContain("timed out");
  });

  test("SIGTERM-by-timeout without explicit error.code is still FAIL", () => {
    const err = Object.assign(new Error("killed"), { code: undefined });
    const res = runJudge(
      "judge",
      "diff",
      "/tmp",
      fakeSpawn({ status: null, signal: "SIGTERM", stdout: "", error: err }),
    );
    expect(res.passed).toBe(false);
    expect(res.output).toContain("[judge infra FAIL]");
  });

  test("ENOENT spawn error returns infra FAIL, not PASS", () => {
    const err = Object.assign(new Error("command not found"), {
      code: "ENOENT",
    });
    const res = runJudge(
      "judge",
      "diff",
      "/tmp",
      fakeSpawn({ status: null, signal: null, stdout: "PASS", error: err }),
    );
    expect(res.passed).toBe(false);
    expect(res.output).toContain("spawn error");
  });

  test("non-zero exit with PASS text in stdout must NOT gate through", () => {
    // This is the canonical false-PASS scenario from the audit HIGH finding.
    const res = runJudge(
      "judge",
      "diff",
      "/tmp",
      fakeSpawn({
        status: 1,
        stdout: "PASS looks fine\nbut really it errored",
        stderr: "rate limit",
      }),
    );
    expect(res.passed).toBe(false);
  });

  test("status=0 + 'PASS' first line → pass", () => {
    const res = runJudge(
      "judge",
      "diff",
      "/tmp",
      fakeSpawn({ status: 0, stdout: "PASS looks good" }),
    );
    expect(res.passed).toBe(true);
  });

  test("status=0 + 'FAIL' first line → fail (normal judge rejection)", () => {
    const res = runJudge(
      "judge",
      "diff",
      "/tmp",
      fakeSpawn({ status: 0, stdout: "FAIL missing tests" }),
    );
    expect(res.passed).toBe(false);
  });
});

// ── 14. getGitDiffSinceClaim throws (never fail-open to empty diff) ───────────

describe("getGitDiffSinceClaim fail-modes", () => {
  const seqSpawn = (results: Partial<SpawnResult>[]): SpawnFn => {
    let i = 0;
    return () => {
      const r = results[i++] ?? {};
      return {
        status: r.status ?? 0,
        signal: r.signal ?? null,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        error: r.error ?? null,
      };
    };
  };

  test("rev-list error throws (does not silently return empty diff)", () => {
    const spawn = seqSpawn([
      { error: Object.assign(new Error("git missing"), { code: "ENOENT" }) },
    ]);
    expect(() => getGitDiffSinceClaim("/tmp", "2026-01-01", spawn)).toThrow(
      /rev-list failed/,
    );
  });

  test("empty base commit falls back to root, throws if root also empty", () => {
    const spawn = seqSpawn([
      { status: 0, stdout: "" }, // rev-list --before → empty
      { status: 0, stdout: "" }, // rev-list --max-parents=0 → empty
    ]);
    expect(() => getGitDiffSinceClaim("/tmp", "2026-01-01", spawn)).toThrow(
      /no diff.*base commit/,
    );
  });

  test("git diff error throws (never returns empty string)", () => {
    const spawn = seqSpawn([
      { status: 0, stdout: "abc123\n" },
      { error: Object.assign(new Error("diff died"), { code: "ENOENT" }) },
    ]);
    expect(() => getGitDiffSinceClaim("/tmp", "2026-01-01", spawn)).toThrow(
      /git diff failed/,
    );
  });

  test("git diff non-zero status throws with stderr detail", () => {
    const spawn = seqSpawn([
      { status: 0, stdout: "abc123\n" },
      { status: 128, stdout: "", stderr: "fatal: bad revision" },
    ]);
    expect(() => getGitDiffSinceClaim("/tmp", "2026-01-01", spawn)).toThrow(
      /git diff exited 128.*bad revision/,
    );
  });

  test("empty diff output throws 'no diff' — never feeds empty prompt to LLM", () => {
    const spawn = seqSpawn([
      { status: 0, stdout: "abc123\n" },
      { status: 0, stdout: "" }, // no diff!
    ]);
    expect(() => getGitDiffSinceClaim("/tmp", "2026-01-01", spawn)).toThrow(
      /no diff.*no committed changes/,
    );
  });

  test("happy path: returns diff content as-is", () => {
    const spawn = seqSpawn([
      { status: 0, stdout: "abc123\n" },
      { status: 0, stdout: "diff --git a/x b/x\n+hello\n" },
    ]);
    expect(getGitDiffSinceClaim("/tmp", "2026-01-01", spawn)).toContain(
      "diff --git",
    );
  });
});

// ── 15. draft lifecycle: pick skips drafts, enrich + promote round-trip ───────

describe("draft lifecycle", () => {
  // parseTasksText must recognise `[?]` as draft, distinct from pending/claimed/done.
  test("parser recognises `[?]` marker as draft", () => {
    const { tasks } = parseTasksText(
      [
        "- [?] **any:infra** — terse draft body",
        "- [ ] **any:infra** — pending body",
        "- [~] **any:infra** — claimed body",
        "- [x] 2026-04-23 **any:infra** — done body",
      ].join("\n"),
    );
    expect(tasks.map((t) => t.status)).toEqual([
      "draft",
      "pending",
      "claimed",
      "done",
    ]);
  });

  // selectCandidate must NOT return drafts. They sit in the queue waiting for
  // enrichment + promote; if `pick` could grab them, autonomous agents would
  // run on undefined intent.
  test("selectCandidate skips drafts (only `pending` is pickable)", () => {
    const db = memDb();
    syncTasks(
      db,
      [
        { repo: "any:infra", body: "draft one", status: "draft", lineIdx: 0 },
        {
          repo: "any:infra",
          body: "pending two",
          status: "pending",
          lineIdx: 1,
        },
      ],
      "2026-04-23T10:00:00.000Z",
    );
    const got = selectCandidate(db, { repo: "any:infra" });
    expect(got.body).toBe("pending two");
    // After pending is claimed, falling back must NOT return the draft —
    // it must return undefined/null.
    db.run("UPDATE tasks SET status = 'claimed' WHERE body = 'pending two'");
    const next = selectCandidate(db, { repo: "any:infra" });
    expect(next).toBeFalsy();
    db.close();
  });

  test("appendTaskToPending with status='draft' writes `[?]` marker to TASKS.md", () => {
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(tasksPath, "# Tasks\n\n## Pending\n\n## Done\n");
    const eid = appendTaskToPending(
      tasksPath,
      { repo: "any:infra", body: "tui-created body" },
      "draft",
    );
    expect(eid).toMatch(/^[0-9a-f]{12}$/);
    const after = readFileSync(tasksPath, "utf8");
    expect(after).toContain("- [?] **any:infra** — tui-created body");
    expect(after).not.toContain("- [ ] **any:infra** — tui-created body");
    // Default still pending — preserves existing call sites.
    appendTaskToPending(tasksPath, { repo: "any:infra", body: "default body" });
    const after2 = readFileSync(tasksPath, "utf8");
    expect(after2).toContain("- [ ] **any:infra** — default body");
  });

  // parseEnrichResponse — pure parser. QUESTIONS: short-circuits, otherwise
  // verify:/judge: are pulled off the tail and the rest is body.
  test("parseEnrichResponse: QUESTIONS path keeps the questions, drops body", () => {
    const r = parseEnrichResponse(
      "QUESTIONS:\n1. Which dir?\n2. Which port?\n",
    );
    expect(r.kind).toBe("questions");
    expect(r.questions).toContain("1. Which dir?");
    expect(r.questions).toContain("2. Which port?");
    expect(r.body).toBeUndefined();
  });

  test("parseEnrichResponse: pulls verify:/judge: off the tail, body keeps the rest", () => {
    const r = parseEnrichResponse(
      [
        "Implement X with acceptance criteria A, B, C.",
        "",
        "verify: bun test foo.test.ts",
        "judge:  Did the diff implement A, B, C? PASS/FAIL.",
      ].join("\n"),
    );
    expect(r.kind).toBe("enriched");
    expect(r.verify).toBe("bun test foo.test.ts");
    expect(r.judge).toBe("Did the diff implement A, B, C? PASS/FAIL.");
    expect(r.body).toContain("acceptance criteria A, B, C");
    expect(r.body).not.toContain("verify:");
    expect(r.body).not.toContain("judge:");
  });

  // Helper: fake spawn returning a canned stdout for the enrichment prompt.
  const enrichSpawn =
    (stdout: string, status = 0): SpawnFn =>
    () => ({ status, signal: null, stdout, stderr: "", error: null });

  function seedDraftRow(
    db: Database,
    repo: string,
    body: string,
    eid: string = externalId(repo, body),
  ): { id: number; eid: string } {
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, created_at) VALUES (?, ?, ?, 'draft', ?)`,
      [eid, repo, body, "2026-04-23T10:00:00.000Z"],
    );
    const row = db
      .query("SELECT id FROM tasks WHERE external_id = ?")
      .get(eid) as any;
    return { id: row.id, eid };
  }

  test("enrich w/ QUESTIONS: keeps draft status + stores enrich_questions", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(
      tasksPath,
      "# Tasks\n\n## Pending\n\n- [?] **any:infra** — terse body\n\n## Done\n",
    );
    const { eid } = seedDraftRow(db, "any:infra", "terse body");

    const result = enrichTaskBody(
      "terse body",
      workdir,
      enrichSpawn("QUESTIONS:\n1. Where?\n2. When?\n"),
    );
    expect(result.kind).toBe("questions");
    const applied = applyEnrichment(db, tasksPath, eid, result);
    expect(applied.kind).toBe("questions");

    const row = db
      .query(
        "SELECT status, enrich_questions, body FROM tasks WHERE external_id = ?",
      )
      .get(eid) as any;
    expect(row.status).toBe("draft");
    expect(row.enrich_questions).toContain("1. Where?");
    expect(row.body).toBe("terse body");
    // TASKS.md untouched (no body rewrite happened on questions path)
    expect(readFileSync(tasksPath, "utf8")).toContain(
      "- [?] **any:infra** — terse body",
    );
    db.close();
  });

  test("enrich w/o questions: rewrites body, sets verify+judge, status stays draft", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "## Pending",
        "",
        "- [?] **any:infra** — add tests",
        "",
        "## Done",
        "",
      ].join("\n"),
    );
    const { eid } = seedDraftRow(db, "any:infra", "add tests");

    const fakeOutput = [
      "Add unit tests for foo() in src/foo.ts. Acceptance:",
      "- happy-path returns 42",
      "- error path throws TypeError",
      "",
      "verify: bun test tests/foo.test.ts",
      "judge: Were both code paths covered with assertions? PASS/FAIL.",
    ].join("\n");
    const result = enrichTaskBody(
      "add tests",
      workdir,
      enrichSpawn(fakeOutput),
    );
    expect(result.kind).toBe("enriched");

    const applied = applyEnrichment(db, tasksPath, eid, result);
    expect(applied.kind).toBe("enriched");
    const after = db
      .query(
        "SELECT status, body, verify_cmd, judge_cmd, enrich_questions FROM tasks WHERE id = (SELECT id FROM tasks WHERE repo = 'any:infra')",
      )
      .get() as any;
    expect(after.status).toBe("draft"); // status untouched until promote
    expect(after.body).toContain("happy-path returns 42");
    expect(after.verify_cmd).toBe("bun test tests/foo.test.ts");
    expect(after.judge_cmd).toBe(
      "Were both code paths covered with assertions? PASS/FAIL.",
    );
    expect(after.enrich_questions).toBeNull();

    const md = readFileSync(tasksPath, "utf8");
    // Old terse body line is gone, replaced with the enriched body line under [?]
    expect(md).not.toContain("- [?] **any:infra** — add tests\n");
    expect(md).toMatch(/- \[\?\] \*\*any:infra\*\* — .*happy-path returns 42/);
    expect(md).toContain("  verify: bun test tests/foo.test.ts");
    expect(md).toContain(
      "  judge: Were both code paths covered with assertions? PASS/FAIL.",
    );
    db.close();
  });

  test("promoteDraftToPending: draft → pending in DB and TASKS.md", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(
      tasksPath,
      "# Tasks\n\n## Pending\n\n- [?] **any:infra** — promotable body\n\n## Done\n",
    );
    const { eid } = seedDraftRow(db, "any:infra", "promotable body");

    const ok = promoteDraftToPending(db, tasksPath, eid);
    expect(ok).toBe(true);

    const row = db
      .query("SELECT status FROM tasks WHERE external_id = ?")
      .get(eid) as any;
    expect(row.status).toBe("pending");
    const after = readFileSync(tasksPath, "utf8");
    expect(after).toContain("- [ ] **any:infra** — promotable body");
    expect(after).not.toContain("- [?] **any:infra** — promotable body");

    // Idempotent / no-op on a non-draft row
    expect(promoteDraftToPending(db, tasksPath, eid)).toBe(false);
    db.close();
  });

  // Regression: rewriteMdTaskStatus is the path `done` and `promote` both
  // mutate TASKS.md through. It must take the same lockfile + atomic-rename
  // pattern as appendTaskToPending so two concurrent flips don't clobber.
  test("rewriteMdTaskStatus is race-safe under concurrent promote/done", async () => {
    const tasksPath = join(workdir, "TASKS.md");
    const N = 5;
    const bodies = Array.from({ length: N }, (_, i) => `race-task-${i}`);
    const seedLines = [
      "# Tasks",
      "",
      "## Pending",
      "",
      ...bodies.map((b) => `- [?] **any:infra** — ${b}`),
      "",
      "## Done",
      "",
    ].join("\n");
    writeFileSync(tasksPath, seedLines);
    const corePath = join(import.meta.dir, "..", "src", "tasks-core.ts");
    const helperPath = join(workdir, "race-promote.ts");
    writeFileSync(
      helperPath,
      `import { rewriteMdTaskStatus } from ${JSON.stringify(corePath)};
const [tasksPath, body] = process.argv.slice(2);
rewriteMdTaskStatus(tasksPath, "any:infra", body, "pending");
`,
    );
    const procs = bodies.map((b) =>
      Bun.spawn(["bun", "run", helperPath, tasksPath, b], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    await Promise.all(procs.map((p) => p.exited));
    const after = readFileSync(tasksPath, "utf8");
    // All N drafts must have flipped to pending — none lost to a clobber.
    for (const b of bodies) {
      expect(after).toContain(`- [ ] **any:infra** — ${b}`);
      expect(after).not.toContain(`- [?] **any:infra** — ${b}`);
    }
    // Lockfile cleaned up.
    expect(after.includes(".lock")).toBe(false);
  });

  // The atomic-rename path must preserve everything outside the rewritten task
  // block — HTML comments, code fences, neighbouring tasks, headings.
  test("enrich rewrite preserves HTML comments, code fences, and neighbouring tasks", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    const before = [
      "# Queue",
      "",
      "<!-- Header note: do NOT delete; humans need this -->",
      "",
      "## Pending",
      "",
      "```md",
      "- [ ] **fence:example** — example task inside a fence — must stay",
      "```",
      "",
      "- [ ] **other** — neighbour pending task that must survive",
      "- [?] **any:infra** — body to enrich",
      "  judge: stale-leftover-judge-should-be-replaced",
      "- [ ] **trailing** — another neighbour after the draft",
      "",
      "## Done",
      "",
    ].join("\n");
    writeFileSync(tasksPath, before);
    const { eid } = seedDraftRow(db, "any:infra", "body to enrich");

    const out = [
      "Elaborated body that explains the work in detail.",
      "",
      "verify: echo ok",
      "judge: Did body get elaborated? PASS/FAIL.",
    ].join("\n");
    applyEnrichment(db, tasksPath, eid, parseEnrichResponse(out));

    const after = readFileSync(tasksPath, "utf8");
    // Preserved bits
    expect(after).toContain(
      "<!-- Header note: do NOT delete; humans need this -->",
    );
    expect(after).toContain("```md");
    expect(after).toContain(
      "- [ ] **fence:example** — example task inside a fence — must stay",
    );
    expect(after).toContain(
      "- [ ] **other** — neighbour pending task that must survive",
    );
    expect(after).toContain(
      "- [ ] **trailing** — another neighbour after the draft",
    );
    expect(after).toContain("## Pending");
    expect(after).toContain("## Done");
    // Rewritten bits
    expect(after).toMatch(/- \[\?\] \*\*any:infra\*\* — .*Elaborated body/);
    expect(after).toContain("  verify: echo ok");
    expect(after).toContain("  judge: Did body get elaborated? PASS/FAIL.");
    // Stale judge directive replaced (not duplicated)
    expect(after).not.toContain("stale-leftover-judge-should-be-replaced");
    // Lockfile cleaned up
    expect(readFileSync(tasksPath, "utf8").includes(".lock")).toBe(false);
    db.close();
  });

  // applyEnrichment must snapshot original_body on the first mutation so the
  // TUI hybrid view can surface the user's terse input alongside the enriched
  // spec. On subsequent enrichments the column is NOT overwritten.
  test("applyEnrichment snapshots original_body on first enriched mutation", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(
      tasksPath,
      "# Tasks\n\n## Pending\n\n- [?] **any:infra** — short terse body\n\n## Done\n",
    );
    const { eid } = seedDraftRow(db, "any:infra", "short terse body");

    applyEnrichment(
      db,
      tasksPath,
      eid,
      parseEnrichResponse(
        "First enriched version with real acceptance criteria.\n\nverify: echo ok\njudge: PASS",
      ),
    );

    const row1 = db
      .query("SELECT body, original_body FROM tasks WHERE repo = ?")
      .get("any:infra") as any;
    expect(row1.original_body).toBe("short terse body");
    expect(row1.body).toContain("First enriched version");

    // Second enrichment against the same row (simulating a re-run after a
    // human tweak) must preserve the ORIGINAL snapshot, not overwrite it
    // with the already-enriched body.
    const currentEid = (
      db
        .query("SELECT external_id FROM tasks WHERE repo = ?")
        .get("any:infra") as any
    ).external_id;
    applyEnrichment(
      db,
      tasksPath,
      currentEid,
      parseEnrichResponse(
        "Second revision of the body.\n\nverify: echo ok2\njudge: PASS2",
      ),
    );
    const row2 = db
      .query("SELECT body, original_body FROM tasks WHERE repo = ?")
      .get("any:infra") as any;
    expect(row2.original_body).toBe("short terse body");
    expect(row2.body).toContain("Second revision");
    db.close();
  });

  test("appendClarifyingAnswers rewrites body, clears questions, snapshots original_body", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(
      tasksPath,
      "# Tasks\n\n## Pending\n\n- [?] **any:infra** — terse body\n\n## Done\n",
    );
    const { eid } = seedDraftRow(db, "any:infra", "terse body");
    // Simulate a prior QUESTIONS response having stored questions.
    db.run(`UPDATE tasks SET enrich_questions = ? WHERE external_id = ?`, [
      "1. Which dir?\n2. Which port?",
      eid,
    ]);

    const out = appendClarifyingAnswers(db, tasksPath, eid, [
      { question: "Which dir?", answer: "src/cli" },
      { question: "Which port?", answer: "3000" },
    ]);
    expect(out.newExternalId).not.toBe(eid);

    const row = db
      .query(
        "SELECT body, enrich_questions, original_body FROM tasks WHERE external_id = ?",
      )
      .get(out.newExternalId) as any;
    expect(row.enrich_questions).toBeNull();
    expect(row.original_body).toBe("terse body");
    expect(row.body).toContain("terse body");
    expect(row.body).toContain("Which dir?");
    expect(row.body).toContain("src/cli");
    expect(row.body).toContain("3000");
    // TASKS.md updated with new body line
    const md = readFileSync(tasksPath, "utf8");
    expect(md).toContain("- [?] **any:infra** — terse body [clarifications");
    db.close();
  });

  test("appendClarifyingAnswers refuses non-draft rows and empty answer lists", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(tasksPath, "# Tasks\n\n## Pending\n\n## Done\n");
    const eid = externalId("any:infra", "pending body");
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
      [eid, "any:infra", "pending body", "2026-04-23T00:00:00.000Z"],
    );
    expect(() =>
      appendClarifyingAnswers(db, tasksPath, eid, [
        { question: "q", answer: "a" },
      ]),
    ).toThrow(/can only answer drafts/);

    const draftEid = externalId("any:infra", "draft body");
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, created_at) VALUES (?, ?, ?, 'draft', ?)`,
      [draftEid, "any:infra", "draft body", "2026-04-23T00:00:00.000Z"],
    );
    expect(() => appendClarifyingAnswers(db, tasksPath, draftEid, [])).toThrow(
      /no clarifying answers/,
    );
    db.close();
  });

  // End-to-end draft lifecycle with a MOCKED opus response: submit (TUI
  // appendTaskToPending with draft) → syncTasks to populate DB → enrichTaskBody
  // with injected spawn → applyEnrichment → promoteDraftToPending. Exercises
  // every state transition the TUI keybinds drive behind the scenes, without
  // shelling out to claude.
  test("end-to-end: submit → draft → enrich (mocked opus) → promote", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(tasksPath, "# Tasks\n\n## Pending\n\n## Done\n");

    // Step 1 — submit via the TUI form path (appendTaskToPending with draft).
    const submittedEid = appendTaskToPending(
      tasksPath,
      { repo: "any:infra", body: "Build CLI migration runner" },
      "draft",
    );

    // Step 2 — syncTasks populates the DB from the MD file.
    const { tasks: parsed } = parseTasksFile(tasksPath);
    syncTasks(db, parsed);
    const afterSync = db
      .query("SELECT status, body FROM tasks WHERE external_id = ?")
      .get(submittedEid) as any;
    expect(afterSync.status).toBe("draft");
    expect(afterSync.body).toBe("Build CLI migration runner");

    // Step 3 — enrich w/ mocked opus response.
    const mocked: SpawnFn = () => ({
      status: 0,
      signal: null,
      stdout: [
        "Implement src/cli/migrate.ts exposing `batonq migrate <file>`.",
        "Acceptance: running with a sample .sql file prints 'applied'.",
        "",
        "verify: bun test tests/migrate.test.ts",
        "judge: Did the diff add a migrate subcommand? PASS/FAIL.",
      ].join("\n"),
      stderr: "",
      error: null,
    });
    const enriched = enrichTaskBody(afterSync.body, workdir, mocked);
    expect(enriched.kind).toBe("enriched");
    const applied = applyEnrichment(db, tasksPath, submittedEid, enriched);
    expect(applied.kind).toBe("enriched");

    // After apply: original_body snapshot, new external_id (body changed),
    // verify/judge captured, status still draft, enrich_questions cleared.
    const enrichedRow = db
      .query(
        "SELECT status, body, original_body, verify_cmd, judge_cmd, enrich_questions FROM tasks WHERE repo = 'any:infra'",
      )
      .get() as any;
    expect(enrichedRow.status).toBe("draft");
    expect(enrichedRow.original_body).toBe("Build CLI migration runner");
    expect(enrichedRow.body).toContain("batonq migrate");
    expect(enrichedRow.verify_cmd).toBe("bun test tests/migrate.test.ts");
    expect(enrichedRow.judge_cmd).toContain("PASS/FAIL");
    expect(enrichedRow.enrich_questions).toBeNull();

    // Step 4 — promote. Status flips to pending in DB AND in TASKS.md.
    const newEid =
      applied.kind === "enriched" ? applied.newExternalId : submittedEid;
    const promoted = promoteDraftToPending(db, tasksPath, newEid);
    expect(promoted).toBe(true);
    const finalRow = db
      .query("SELECT status FROM tasks WHERE external_id = ?")
      .get(newEid) as any;
    expect(finalRow.status).toBe("pending");
    const md = readFileSync(tasksPath, "utf8");
    expect(md).toMatch(/- \[ \] \*\*any:infra\*\* — .*batonq migrate/);
    expect(md).not.toMatch(/- \[\?\] \*\*any:infra\*\*/);

    // selectCandidate now sees it (it was a draft before, invisible to pick).
    const candidate = selectCandidate(db, { repo: "any:infra" }) as any;
    expect(candidate?.external_id).toBe(newEid);
    db.close();
  });

  // End-to-end: QUESTIONS response → answer overlay path → re-enrich. The TUI
  // would drive this via submitClarifyingAnswers; here we go straight to core.
  test("end-to-end questions path: QUESTIONS → answers → successful re-enrich", () => {
    const db = memDb();
    const tasksPath = join(workdir, "TASKS.md");
    writeFileSync(
      tasksPath,
      "# Tasks\n\n## Pending\n\n- [?] **any:infra** — add a helper\n\n## Done\n",
    );
    const { eid } = seedDraftRow(db, "any:infra", "add a helper");

    // 1st opus call → questions.
    const questionsOut = enrichTaskBody("add a helper", workdir, () => ({
      status: 0,
      signal: null,
      stdout:
        "QUESTIONS:\n1. Where should the helper live?\n2. What signature?\n",
      stderr: "",
      error: null,
    }));
    expect(questionsOut.kind).toBe("questions");
    applyEnrichment(db, tasksPath, eid, questionsOut);
    const afterQ = db
      .query(
        "SELECT status, enrich_questions, original_body FROM tasks WHERE external_id = ?",
      )
      .get(eid) as any;
    expect(afterQ.status).toBe("draft");
    expect(afterQ.enrich_questions).toContain("Where should the helper live?");
    expect(afterQ.original_body).toBeNull(); // questions path does NOT snapshot

    // User answers → appendClarifyingAnswers snapshots original_body and
    // rewrites body + external_id.
    const { newExternalId } = appendClarifyingAnswers(db, tasksPath, eid, [
      {
        question: "Where should the helper live?",
        answer: "src/util/helper.ts",
      },
      { question: "What signature?", answer: "(s: string) => number" },
    ]);
    const afterAnswer = db
      .query(
        "SELECT status, body, original_body, enrich_questions FROM tasks WHERE external_id = ?",
      )
      .get(newExternalId) as any;
    expect(afterAnswer.enrich_questions).toBeNull();
    expect(afterAnswer.original_body).toBe("add a helper");
    expect(afterAnswer.body).toContain("src/util/helper.ts");

    // 2nd opus call with answers in body → now enriched, original_body preserved.
    const enrichedOut = enrichTaskBody(afterAnswer.body, workdir, () => ({
      status: 0,
      signal: null,
      stdout: [
        "Write src/util/helper.ts exporting helper(s: string): number.",
        "",
        "verify: bun test tests/util.test.ts",
        "judge: Helper added and typed correctly? PASS/FAIL.",
      ].join("\n"),
      stderr: "",
      error: null,
    }));
    const applied = applyEnrichment(db, tasksPath, newExternalId, enrichedOut);
    expect(applied.kind).toBe("enriched");
    const finalEid =
      applied.kind === "enriched" ? applied.newExternalId : newExternalId;
    const final = db
      .query(
        "SELECT status, body, original_body FROM tasks WHERE external_id = ?",
      )
      .get(finalEid) as any;
    expect(final.status).toBe("draft");
    expect(final.body).toContain("helper(s: string): number");
    // Original snapshot is still the user's very first terse body,
    // NOT the Q&A-augmented intermediate.
    expect(final.original_body).toBe("add a helper");
    db.close();
  });
});

// ── task-claim TTL: lost-state + recovery hook + escalation notify ────────────

describe("sweepTasks (task-claim TTL)", () => {
  // Seed a claimed task whose progress clock predates the TTL. The helper
  // reaches past claimCandidate() so we can pin the timestamps deterministically
  // (real claimCandidate uses Date.now()).
  const seedStaleClaim = (
    db: Database,
    opts: {
      externalIdValue?: string;
      body?: string;
      claimedBy?: string;
      claimedAt: string;
      lastProgressAt?: string | null;
      repo?: string;
    },
  ): number => {
    const eid =
      opts.externalIdValue ??
      externalId("any:infra", opts.body ?? "stale task");
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, claimed_by, claimed_at, last_progress_at, created_at)
       VALUES (?, ?, ?, 'claimed', ?, ?, ?, ?)`,
      [
        eid,
        opts.repo ?? "any:infra",
        opts.body ?? "stale task",
        opts.claimedBy ?? "sess-A",
        opts.claimedAt,
        opts.lastProgressAt ?? null,
        opts.claimedAt,
      ],
    );
    return (
      db.query("SELECT id FROM tasks WHERE external_id = ?").get(eid) as any
    ).id;
  };

  test("TTL-expiry with no live session flips claimed → lost", () => {
    const db = memDb();
    const now = "2026-04-23T13:00:00.000Z";
    // Claimed 45 min ago, no heartbeat refresh; no session row either.
    const claimedAt = new Date(Date.parse(now) - 45 * 60_000).toISOString();
    seedStaleClaim(db, {
      body: "dead-session task",
      claimedBy: "sess-dead",
      claimedAt,
    });

    const captured: string[] = [];
    const res = sweepTasks(db, {
      nowIso: now,
      writeEscalation: (line) => captured.push(line),
    });

    expect(res).toEqual({ scanned: 1, lost: 1, deferred: 0 });
    const row = db
      .query(`SELECT status FROM tasks WHERE body = ?`)
      .get("dead-session task") as any;
    expect(row.status).toBe("lost");
    expect(captured.length).toBe(1);
    db.close();
  });

  test("recovery hook defers when claiming session has fresh heartbeat", () => {
    const db = memDb();
    const now = "2026-04-23T13:00:00.000Z";
    const claimedAt = new Date(Date.parse(now) - 45 * 60_000).toISOString();
    const lastSeen = new Date(Date.parse(now) - 60_000).toISOString(); // 1 min ago — alive
    seedStaleClaim(db, {
      body: "live-session task",
      claimedBy: "sess-alive",
      claimedAt,
    });
    db.run(
      `INSERT INTO sessions (session_id, cwd, started_at, last_seen) VALUES (?, ?, ?, ?)`,
      ["sess-alive", "/tmp/fake", claimedAt, lastSeen],
    );

    // Sanity: default recovery hook must actually see the session (not null).
    let seenSession: any = "sentinel";
    const spy = (ctx: TaskRecoveryContext) => {
      seenSession = ctx.session;
      // Delegate: defer if within 5 min, else mark_lost.
      if (
        ctx.session &&
        typeof ctx.session.last_seen === "string" &&
        ctx.nowMs - Date.parse(ctx.session.last_seen) <
          TASK_RECOVERY_HEARTBEAT_MS
      ) {
        return {
          kind: "defer" as const,
          untilIso: new Date(
            ctx.nowMs + TASK_RECOVERY_HEARTBEAT_MS,
          ).toISOString(),
        };
      }
      return { kind: "mark_lost" as const };
    };

    const captured: string[] = [];
    const res = sweepTasks(db, {
      nowIso: now,
      recover: spy,
      writeEscalation: (line) => captured.push(line),
    });

    expect(seenSession).not.toBeNull();
    expect(seenSession.session_id).toBe("sess-alive");
    expect(res).toEqual({ scanned: 1, lost: 0, deferred: 1 });
    const row = db
      .query(`SELECT status, last_progress_at FROM tasks WHERE body = ?`)
      .get("live-session task") as any;
    // Status must NOT flip to lost — claim is protected.
    expect(row.status).toBe("claimed");
    // last_progress_at got bumped forward, so a second sweep at same `now`
    // would no longer see this task as stale.
    expect(Date.parse(row.last_progress_at)).toBeGreaterThan(Date.parse(now));
    // No escalation log line for the deferred task.
    expect(captured.length).toBe(0);
    db.close();
  });

  test("escalation notification carries timestamp, external_id and body snippet", () => {
    const db = memDb();
    const now = "2026-04-23T14:00:00.000Z";
    const claimedAt = new Date(
      Date.parse(now) - (TASK_CLAIM_TTL_MS + 60_000),
    ).toISOString();
    const longBody =
      "escalate me because I am a very long body that should get truncated to at most 120 characters of useful context in the log";
    const eid = externalId("any:infra", longBody);
    seedStaleClaim(db, {
      externalIdValue: eid,
      body: longBody,
      claimedBy: "sess-gone",
      claimedAt,
    });

    // Use the real file path too, just a tmp copy, to exercise the write path.
    const logPath = join(workdir, "escalations.log");
    const res = sweepTasks(db, {
      nowIso: now,
      escalationLogPath: logPath,
    });
    expect(res.lost).toBe(1);

    const contents = readFileSync(logPath, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.ts).toBe(now);
    expect(rec.external_id).toBe(eid);
    expect(typeof rec.body_snippet).toBe("string");
    expect(rec.body_snippet.length).toBeLessThanOrEqual(120);
    expect(rec.body_snippet).toContain("escalate me");
    // The claiming session's id should be preserved so escalation readers can
    // cross-reference it against sessions/logs.
    expect(rec.claimed_by).toBe("sess-gone");
    db.close();
  });

  test("`batonq pick` auto-invokes sweep-tasks on entry", () => {
    // Drive the real CLI against a temp HOME so the pick command's inline
    // sweepTasksCore() call runs and flips a stale claim to lost.
    const fakeHome = mkdtempSync(join(tmpdir(), "batonq-home-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const tasksPath = join(fakeHome, "DEV", "TASKS.md");
    mkdirSync(join(fakeHome, "DEV"), { recursive: true });
    // Keep TASKS.md minimal so sync-tasks doesn't reshape the claimed row.
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "## Pending",
        "",
        "- [ ] **any:infra** — stale claim placeholder",
        "",
      ].join("\n"),
    );

    const dbPath = join(fakeHome, ".claude", "agent-coord-state.db");
    try {
      // First: sync populates the DB with the pending task, then we mutate
      // it to a stale claimed state and watch `pick` sweep it.
      const seed = spawnSync(BATONQ_BIN, ["sync-tasks"], {
        env: { ...process.env, HOME: fakeHome, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      expect(seed.status).toBe(0);

      const db = new Database(dbPath);
      const claimedAt = new Date(
        Date.now() - (TASK_CLAIM_TTL_MS + 5 * 60_000),
      ).toISOString();
      db.run(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, last_progress_at = NULL
         WHERE body = ?`,
        ["sess-ghost", claimedAt, "stale claim placeholder"],
      );
      db.close();

      // Run pick. It should sweep (flipping the stale row to lost) BEFORE
      // selecting a candidate. The row then transitions to lost, and since
      // there are no other pending tasks, pick outputs NO_TASK.
      const pick = spawnSync(BATONQ_BIN, ["pick", "--any"], {
        env: { ...process.env, HOME: fakeHome, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      expect(pick.status).toBe(0);
      expect(pick.stdout).toContain("NO_TASK");

      // Verify the sweep fired: stale claim → lost.
      const after = new Database(dbPath, { readonly: true });
      const row = after
        .query(`SELECT status FROM tasks WHERE body = ?`)
        .get("stale claim placeholder") as any;
      expect(row.status).toBe("lost");
      after.close();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ── batonq doctor ─────────────────────────────────────────────────────────────
//
// Doctor is a structured 5-category health check. It must (a) print every
// category header so the output is copy-pastable into a bug report, (b) exit 0
// when nothing critical is wrong, (c) exit 1 when something critical is wrong,
// (d) never mutate state — it's diagnostic-only.
//
// We drive the real CLI against an isolated $HOME so the host's actual
// settings.json / state.db / TASKS.md are never touched. Each test seeds
// exactly the conditions it needs.

describe("batonq doctor", () => {
  // Build a $HOME with a complete healthy install: a settings.json with all
  // three install.sh-wired hook matchers, a stub `batonq-hook` binary that
  // they reference, an empty TASKS.md, and a writable measurement dir. No DB
  // (state.db is lazy-created — doctor treats absence as a warn, not a fail).
  function buildHealthyHome(): { home: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), "batonq-doctor-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude", "agent-coord-measurement"), {
      recursive: true,
    });
    mkdirSync(join(home, "DEV"), { recursive: true });
    mkdirSync(join(home, "bin"), { recursive: true });

    // Stub hook binary — doctor only checks that the path exists and is
    // executable; it never executes the hook itself.
    const hookPath = join(home, "bin", "batonq-hook");
    writeFileSync(hookPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // Empty TASKS.md so parseTasksFile succeeds with 0 tasks.
    writeFileSync(join(home, "DEV", "TASKS.md"), "## Pending\n\n");

    // settings.json with the exact 3-matcher layout install.sh produces.
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Read|Edit|Write|MultiEdit",
            hooks: [
              { type: "command", command: `${hookPath} pre`, timeout: 2 },
            ],
          },
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: `${hookPath} bash`, timeout: 2 },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [
              { type: "command", command: `${hookPath} post`, timeout: 2 },
            ],
          },
        ],
      },
    };
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(settings, null, 2),
    );

    return {
      home,
      cleanup: () => rmSync(home, { recursive: true, force: true }),
    };
  }

  // PATH that includes a fake bin dir containing a batonq stub — doctor
  // checks `command -v batonq` so the stub keeps the Installation category
  // green for the happy-path tests.
  function pathWithBatonqStub(home: string): string {
    const stub = join(home, "bin", "batonq");
    if (!existsSync(stub)) {
      writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    return `${join(home, "bin")}:${process.env.PATH ?? ""}`;
  }

  test("exit 0 when all categories are healthy", () => {
    const { home, cleanup } = buildHealthyHome();
    try {
      // cwd inside the fake $HOME/DEV/somerepo so the Scope check passes.
      const repoDir = join(home, "DEV", "fake-repo");
      mkdirSync(repoDir);
      // git init so `git rev-parse --show-toplevel` resolves.
      const init = spawnSync("git", ["init", "-q", repoDir], {
        encoding: "utf8",
      });
      expect(init.status).toBe(0);
      // First commit so repo-fingerprint can be computed.
      spawnSync(
        "git",
        [
          "-C",
          repoDir,
          "commit",
          "--allow-empty",
          "-m",
          "init",
          "--no-gpg-sign",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "test",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "test",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        },
      );

      const res = spawnSync(BATONQ_BIN, ["doctor"], {
        encoding: "utf8",
        cwd: repoDir,
        env: {
          ...process.env,
          HOME: home,
          PATH: pathWithBatonqStub(home),
        },
      });

      const out = (res.stdout ?? "") + (res.stderr ?? "");
      expect(res.status).toBe(0);
      expect(out).toContain("Critical: []");
      expect(out).toMatch(/Summary — batonq doctor: \d+\/\d+ checks passed\./);
    } finally {
      cleanup();
    }
  });

  test("exit 1 when a critical check fails (settings.json malformed)", () => {
    const { home, cleanup } = buildHealthyHome();
    try {
      // Corrupt settings.json — JSON.parse throws → critical fail in
      // Installation category. Other categories may still pass.
      writeFileSync(join(home, ".claude", "settings.json"), "{not json");

      const res = spawnSync(BATONQ_BIN, ["doctor"], {
        encoding: "utf8",
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          PATH: pathWithBatonqStub(home),
        },
      });

      const out = (res.stdout ?? "") + (res.stderr ?? "");
      expect(res.status).toBe(1);
      expect(out).toContain("settings.json parse error");
      expect(out).toMatch(/Critical: \[\d+\]/);
      expect(out).toContain("Installation: settings.json parse error");
    } finally {
      cleanup();
    }
  });

  test("output contains all 5 category headers and pass/warn/fail glyphs", () => {
    const { home, cleanup } = buildHealthyHome();
    try {
      // Run from the temp $HOME (not a git repo) so the Scope category emits
      // a warn line, exercising the `⚠` glyph alongside the `✓` lines from
      // the other healthy categories.
      const res = spawnSync(BATONQ_BIN, ["doctor"], {
        encoding: "utf8",
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          PATH: pathWithBatonqStub(home),
        },
      });

      const out = (res.stdout ?? "") + (res.stderr ?? "");
      // All 5 category headers must be printed verbatim — this is the
      // copy-paste contract for issue reports.
      for (const cat of [
        "Binaries:",
        "Installation:",
        "State:",
        "Scope:",
        "Live:",
      ]) {
        expect(out).toContain(cat);
      }
      // At least the pass and warn glyphs must appear (non-git-repo cwd
      // forces a warn in Scope; healthy install forces passes elsewhere).
      expect(out).toMatch(/✓/);
      expect(out).toMatch(/⚠/);
      expect(out).toMatch(/Summary — batonq doctor: \d+\/\d+ checks passed\./);
      expect(out).toMatch(/Critical: (\[\]|\[\d+\])/);
      expect(out).toMatch(/Warnings: (\[\]|\[\d+\])/);
    } finally {
      cleanup();
    }
  });

  test("each non-pass row carries a `fix:` line", () => {
    const { home, cleanup } = buildHealthyHome();
    try {
      // Force two distinct critical fails: (1) missing settings.json,
      // (2) missing TASKS.md. Each should get its own fix hint.
      rmSync(join(home, ".claude", "settings.json"));
      rmSync(join(home, "DEV", "TASKS.md"));

      const res = spawnSync(BATONQ_BIN, ["doctor"], {
        encoding: "utf8",
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          PATH: pathWithBatonqStub(home),
        },
      });

      const out = (res.stdout ?? "") + (res.stderr ?? "");
      expect(res.status).toBe(1);

      const failLines = (out.match(/^\s*✗ /gm) ?? []).length;
      const fixLines = (out.match(/^\s+fix: /gm) ?? []).length;
      expect(failLines).toBeGreaterThan(0);
      expect(fixLines).toBeGreaterThanOrEqual(failLines);
    } finally {
      cleanup();
    }
  });

  test("doctor never mutates state (idempotent / read-only)", () => {
    const { home, cleanup } = buildHealthyHome();
    try {
      const tasksBefore = readFileSync(join(home, "DEV", "TASKS.md"), "utf8");
      const settingsBefore = readFileSync(
        join(home, ".claude", "settings.json"),
        "utf8",
      );
      const measurementBefore = spawnSync(
        "ls",
        ["-la", join(home, ".claude", "agent-coord-measurement")],
        { encoding: "utf8" },
      ).stdout;

      const env = {
        ...process.env,
        HOME: home,
        PATH: pathWithBatonqStub(home),
      };
      const r1 = spawnSync(BATONQ_BIN, ["doctor"], {
        encoding: "utf8",
        cwd: home,
        env,
      });
      const r2 = spawnSync(BATONQ_BIN, ["doctor"], {
        encoding: "utf8",
        cwd: home,
        env,
      });

      expect(readFileSync(join(home, "DEV", "TASKS.md"), "utf8")).toBe(
        tasksBefore,
      );
      expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
        settingsBefore,
      );

      // The append-probe in the measurement dir must be cleaned up; no
      // .batonq-doctor-probe should linger between runs.
      const measurementAfter = spawnSync(
        "ls",
        ["-la", join(home, ".claude", "agent-coord-measurement")],
        { encoding: "utf8" },
      ).stdout;
      expect(measurementAfter).toBe(measurementBefore);

      // Doctor never lazy-creates state.db — that's the hook's job.
      expect(existsSync(join(home, ".claude", "agent-coord-state.db"))).toBe(
        false,
      );

      expect(r1.status).toBe(r2.status);
    } finally {
      cleanup();
    }
  });
});
