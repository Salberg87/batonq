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
  claimCandidate,
  externalId,
  getGitDiffSinceClaim,
  initClaimsSchema,
  initTaskSchema,
  parseTasksFile,
  parseTasksText,
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
