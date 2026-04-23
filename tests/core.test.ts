// core.test — exercises the pure task and hook cores against an in-memory SQLite
// DB and tmpdir fixtures. No touching of ~/.claude state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
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
  syncTasks,
  type ParsedTask,
  type SpawnFn,
  type SpawnResult,
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
});
