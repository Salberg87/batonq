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
  buildTaskLines,
  claimCandidate,
  DEFAULT_AGENT,
  DEFAULT_PRIORITY,
  detectFragileGitLog,
  enrichTaskBody,
  extractAnnotations,
  externalId,
  getGitDiffSinceClaim,
  initClaimsSchema,
  initTaskSchema,
  insertTask,
  normalizePriority,
  normalizeScheduledFor,
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
  touchTaskProgress,
  validatedInsertTask,
  type ParsedTask,
  type SpawnFn,
  type SpawnResult,
  type TaskRecoveryContext,
} from "../src/tasks-core";
import { AGENTS, parseTaskInput, TaskSchema } from "../src/task-schema";
import { IMPLEMENTED_TOOLS } from "../src/agent-runners/types";
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

  // Multi-agent deadlock guard: verify scripts that assert on commit subjects
  // must tolerate peer commits landing between claim and done. `git log -1`
  // breaks here; `git_commits_since_claim` (backed by BATONQ_CLAIM_TS) survives.
  describe("BATONQ_CLAIM_TS / git_commits_since_claim", () => {
    // Build a throwaway git repo; return the path and a helper that commits
    // with a given subject and optional author date (so we can place a commit
    // before or after the claim timestamp without sleeping).
    function makeRepo(): {
      repo: string;
      commit: (subject: string, whenISO?: string) => void;
    } {
      const repo = mkdtempSync(join(tmpdir(), "batonq-verify-repo-"));
      const gitEnv = {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      };
      const init = spawnSync("git", ["init", "-q", "-b", "main", repo], {
        encoding: "utf8",
      });
      expect(init.status).toBe(0);
      return {
        repo,
        commit(subject, whenISO) {
          const env: Record<string, string> = {
            ...process.env,
            ...gitEnv,
          } as Record<string, string>;
          if (whenISO) {
            env.GIT_AUTHOR_DATE = whenISO;
            env.GIT_COMMITTER_DATE = whenISO;
          }
          const r = spawnSync(
            "git",
            [
              "-C",
              repo,
              "commit",
              "--allow-empty",
              "-m",
              subject,
              "--no-gpg-sign",
            ],
            { encoding: "utf8", env },
          );
          expect(r.status).toBe(0);
        },
      };
    }

    test("passes when the claimed task's commit exists — even with a peer commit after claim", () => {
      const { repo, commit } = makeRepo();

      // Pre-claim history: an unrelated old commit. Claim happens at CLAIM_TS.
      commit("chore: seed", "2026-04-24T00:00:00Z");
      const claimTs = "2026-04-24T01:00:00Z";

      // The agent commits its task delivery, then a peer lands an unrelated
      // commit on top. `git log -1 --pretty=%s` would see the peer commit and
      // (wrongly) FAIL. The helper must still find the task's commit subject.
      commit("fix(verify): deliver SHIP-017", "2026-04-24T01:05:00Z");
      commit("docs: unrelated peer edit", "2026-04-24T01:06:00Z");

      const cmd = `git_commits_since_claim | grep -F "fix(verify): deliver SHIP-017" >/dev/null`;
      const res = runVerify(cmd, repo, "tid-multi", claimTs);
      expect(res.code).toBe(0);
    });

    test("still fails when the task was never delivered (only peer commits since claim)", () => {
      const { repo, commit } = makeRepo();

      commit("chore: seed", "2026-04-24T00:00:00Z");
      const claimTs = "2026-04-24T01:00:00Z";
      // Only a peer commit lands; the claimed task was never delivered.
      commit("docs: unrelated peer edit", "2026-04-24T01:06:00Z");

      const cmd = `git_commits_since_claim | grep -F "fix(verify): deliver SHIP-017" >/dev/null`;
      const res = runVerify(cmd, repo, "tid-missing", claimTs);
      expect(res.code).not.toBe(0);
    });

    test("emits a migration warning when verify uses `git log -1 | grep`", () => {
      // Passive docs alone don't prevent new tasks from using the fragile
      // pattern. runVerify flags it at gate-time so operators see it in the
      // captured verify_output and migrate to git_commits_since_claim.
      expect(
        detectFragileGitLog('git log -1 --pretty=%s | grep "fix(X):"'),
      ).toBe(true);
      expect(
        detectFragileGitLog("git log --since=X --pretty=%s | grep foo"),
      ).toBe(false);
      expect(detectFragileGitLog("git_commits_since_claim | grep foo")).toBe(
        false,
      );

      const { repo, commit } = makeRepo();
      commit("fix(X): delivered", "2026-04-24T01:05:00Z");
      const res = runVerify(
        'git log -1 --pretty=%s | grep -q "fix(X): delivered"',
        repo,
        "tid-warn",
        "2026-04-24T01:00:00Z",
      );
      // Gate still passes — the warning is advisory, not a hard fail.
      expect(res.code).toBe(0);
      expect(res.output).toContain("warning: verify uses `git log -1`");
      expect(res.output).toContain("git_commits_since_claim");
    });

    test("git_commits_since_claim errors cleanly if BATONQ_CLAIM_TS is unset", () => {
      // Defensive: if runVerify is called without a claim timestamp (e.g., a
      // task claimed before this change shipped), the helper should fail fast
      // rather than silently widening the window to "all history".
      const { repo } = makeRepo();
      const res = runVerify("git_commits_since_claim", repo, "tid-nots");
      expect(res.code).not.toBe(0);
      expect(res.output).toContain("BATONQ_CLAIM_TS not set");
    });
  });
});

// ── 7a. touchTaskProgress refreshes last_progress_at on claimed rows ─────────

describe("touchTaskProgress", () => {
  test("updates last_progress_at only for caller's claimed rows", () => {
    const db = memDb();
    const t0 = "2026-04-24T00:00:00.000Z";
    const t1 = "2026-04-24T00:05:00.000Z";

    // Two claims for session A, one for session B, one pending row.
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, claimed_by, claimed_at, last_progress_at, created_at)
       VALUES
         ('a1', 'any:infra', 'A-first',  'claimed', 'sess-A', ?, ?, ?),
         ('a2', 'any:infra', 'A-second', 'claimed', 'sess-A', ?, ?, ?),
         ('b1', 'any:infra', 'B-task',   'claimed', 'sess-B', ?, ?, ?),
         ('p1', 'any:infra', 'pending',  'pending',  NULL,    NULL, NULL, ?)`,
      [t0, t0, t0, t0, t0, t0, t0, t0, t0, t0],
    );

    const res = touchTaskProgress(db, "sess-A", t1);
    expect(res.touched).toBe(2);

    const rows = db
      .query(
        "SELECT external_id, last_progress_at FROM tasks ORDER BY external_id",
      )
      .all() as Array<{ external_id: string; last_progress_at: string | null }>;
    const byId = Object.fromEntries(
      rows.map((r) => [r.external_id, r.last_progress_at]),
    );
    expect(byId.a1).toBe(t1);
    expect(byId.a2).toBe(t1);
    expect(byId.b1).toBe(t0); // peer's claim untouched
    expect(byId.p1).toBeNull(); // pending row untouched

    // No-op on a session holding no claims
    const res2 = touchTaskProgress(db, "sess-nobody", t1);
    expect(res2.touched).toBe(0);

    db.close();
  });
});

// ── 7c. anti-cheat gate: `done` keeps claim open when verify_cmd fails ────────
//
// This is the invariant the README hinges on — the verify gate must prevent a
// `done` call from closing a task when the verify command exits non-zero. We
// drive the real CLI against an isolated $HOME, seed a claimed task with a
// failing verify_cmd, and assert:
//   (a) `done` exits with the verify command's exit code (not 0)
//   (b) the task stays in `claimed` (NOT `done`)
//   (c) verify_output + verify_ran_at are persisted as a receipt
// Then we flip verify_cmd to `exit 0` and assert the same call now closes.

describe("done gate: verify_cmd fail keeps claim open, pass closes", () => {
  test("failing verify blocks done; passing verify lets it through", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "batonq-done-gate-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const tasksPath = join(fakeHome, "DEV", "TASKS.md");
    mkdirSync(join(fakeHome, "DEV"), { recursive: true });
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "## Pending",
        "",
        "- [ ] **any:infra** — gate probe",
        "",
      ].join("\n"),
    );

    const dbPath = join(fakeHome, ".claude", "batonq", "state.db");
    const env = {
      ...process.env,
      HOME: fakeHome,
      PATH: process.env.PATH ?? "",
    };

    try {
      const seed = spawnSync(BATONQ_BIN, ["sync-tasks"], {
        env,
        encoding: "utf8",
      });
      expect(seed.status).toBe(0);

      // Seed a claim on the task and attach a failing verify_cmd.
      const db = new Database(dbPath);
      const now = new Date().toISOString();
      db.run(
        `UPDATE tasks
            SET status = 'claimed',
                claimed_by = 'sess-gate',
                claimed_at = ?,
                last_progress_at = ?,
                verify_cmd = 'echo gate-fired; exit 13'
          WHERE body = 'gate probe'`,
        [now, now],
      );
      const eidRow = db
        .query("SELECT external_id FROM tasks WHERE body = 'gate probe'")
        .get() as { external_id: string };
      const eid = eidRow.external_id;
      db.close();

      // (1) done must fail — verify exits 13 — and claim stays open with receipt.
      const fail = spawnSync(BATONQ_BIN, ["done", eid], {
        env,
        encoding: "utf8",
      });
      expect(fail.status).toBe(13);
      expect(fail.stderr ?? "").toMatch(/verify FAILED \(exit 13\)/);

      const afterFail = new Database(dbPath, { readonly: true });
      const row1 = afterFail
        .query(
          "SELECT status, verify_ran_at, verify_output FROM tasks WHERE external_id = ?",
        )
        .get(eid) as {
        status: string;
        verify_ran_at: string | null;
        verify_output: string | null;
      };
      expect(row1.status).toBe("claimed"); // gate held — NOT 'done'
      expect(row1.verify_ran_at).not.toBeNull(); // receipt exists
      expect(row1.verify_output ?? "").toContain("gate-fired"); // output captured
      afterFail.close();

      // (2) flip verify_cmd to pass; done now closes the task.
      const db2 = new Database(dbPath);
      db2.run("UPDATE tasks SET verify_cmd = 'exit 0' WHERE external_id = ?", [
        eid,
      ]);
      db2.close();

      const pass = spawnSync(BATONQ_BIN, ["done", eid], {
        env,
        encoding: "utf8",
      });
      expect(pass.status).toBe(0);

      const afterPass = new Database(dbPath, { readonly: true });
      const row2 = afterPass
        .query("SELECT status FROM tasks WHERE external_id = ?")
        .get(eid) as { status: string };
      expect(row2.status).toBe("done");
      afterPass.close();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ── 7b. --version / -v / version prints batonq v<semver> (commit <sha>) ──────

describe("batonq --version", () => {
  test("prints 'batonq v<semver> (commit <sha>)' on stdout, exits 0", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "batonq-home-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    try {
      for (const flag of ["--version", "-v", "version"]) {
        const r = spawnSync(BATONQ_BIN, [flag], {
          env: { ...process.env, HOME: fakeHome, PATH: process.env.PATH ?? "" },
          encoding: "utf8",
        });
        expect(r.status).toBe(0);
        const out = (r.stdout ?? "").trim();
        expect(out).toMatch(
          /^batonq v[0-9]+\.[0-9]+\.[0-9]+ \(commit [^)]+\)$/,
        );
        const m = out.match(/^batonq v([0-9]+\.[0-9]+\.[0-9]+)/);
        expect(m?.[1]).toBe(
          JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
            .version,
        );
      }
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ── 8. --skip-verify / --skip-judge are rejected unconditionally ──────────────

describe("done --skip-verify/--skip-judge rejection", () => {
  test("--skip-verify exits 2 even with AGENT_COORD_ALLOW_SKIP=1 set", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "batonq-home-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    try {
      for (const flag of ["--skip-verify", "--skip-judge"] as const) {
        const withoutEnv = spawnSync(BATONQ_BIN, ["done", flag, "nope123456"], {
          env: { ...process.env, HOME: fakeHome, PATH: process.env.PATH ?? "" },
          encoding: "utf8",
        });
        expect(withoutEnv.status).toBe(2);
        expect(withoutEnv.stderr ?? "").toMatch(/no longer accepted/i);

        // Env escape hatch is gone — gate still rejects.
        const withEnv = spawnSync(BATONQ_BIN, ["done", flag, "nope123456"], {
          env: {
            ...process.env,
            HOME: fakeHome,
            PATH: process.env.PATH ?? "",
            AGENT_COORD_ALLOW_SKIP: "1",
          },
          encoding: "utf8",
        });
        expect(withEnv.status).toBe(2);
        expect(withEnv.stderr ?? "").toMatch(/no longer accepted/i);
      }
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

    const dbPath = join(fakeHome, ".claude", "batonq", "state.db");
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
    mkdirSync(join(home, ".claude", "batonq-measurement"), {
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
        ["-la", join(home, ".claude", "batonq-measurement")],
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
        ["-la", join(home, ".claude", "batonq-measurement")],
        { encoding: "utf8" },
      ).stdout;
      expect(measurementAfter).toBe(measurementBefore);

      // Doctor never lazy-creates state.db — that's the hook's job.
      expect(existsSync(join(home, ".claude", "batonq", "state.db"))).toBe(
        false,
      );

      expect(r1.status).toBe(r2.status);
    } finally {
      cleanup();
    }
  });
});

// ── migrate(): legacy agent-coord-* → batonq-* ────────────────────────────────
//
// The rename dropped the `agent-coord` name across the codebase but left a
// trail of pre-existing state in `$HOME/.claude/agent-coord-*` on every
// installed machine. `migrate()` moves that state under the new names without
// data loss and is idempotent so a hook racing the CLI at startup can't
// double-copy or corrupt.

describe("migrate (agent-coord → batonq)", () => {
  test("copies DB + fingerprint + measurement dir and backs up originals", async () => {
    const { migrate } = await import("../src/migrate");
    const home = mkdtempSync(join(tmpdir(), "batonq-migrate-"));
    try {
      const claude = join(home, ".claude");
      mkdirSync(claude, { recursive: true });

      // Seed a realistic legacy layout: a non-empty DB-like file, a WAL/SHM
      // sibling pair, a JSON fingerprint cache, and an events.jsonl inside a
      // measurement dir with a child file.
      const legacyDb = join(claude, "agent-coord-state.db");
      const legacyShm = `${legacyDb}-shm`;
      const legacyWal = `${legacyDb}-wal`;
      const legacyFp = join(claude, "agent-coord-fingerprint.json");
      const legacyDir = join(claude, "agent-coord-measurement");
      const legacyEvents = join(legacyDir, "events.jsonl");

      writeFileSync(legacyDb, "SQLite-blob");
      writeFileSync(legacyShm, "shm");
      writeFileSync(legacyWal, "wal");
      writeFileSync(legacyFp, '{"root": "abc"}');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(legacyEvents, '{"event":"seed"}\n');

      const logs: string[] = [];
      migrate({ home, log: (m) => logs.push(m) });

      // New paths hold the data
      expect(readFileSync(join(claude, "batonq-state.db"), "utf8")).toBe(
        "SQLite-blob",
      );
      expect(readFileSync(join(claude, "batonq-state.db-shm"), "utf8")).toBe(
        "shm",
      );
      expect(readFileSync(join(claude, "batonq-state.db-wal"), "utf8")).toBe(
        "wal",
      );
      expect(
        readFileSync(join(claude, "batonq-fingerprint.json"), "utf8"),
      ).toBe('{"root": "abc"}');
      expect(
        readFileSync(
          join(claude, "batonq-measurement", "events.jsonl"),
          "utf8",
        ),
      ).toBe('{"event":"seed"}\n');

      // Old paths renamed to .bak (no data lost)
      expect(existsSync(legacyDb)).toBe(false);
      expect(existsSync(legacyDb + ".bak")).toBe(true);
      expect(existsSync(legacyFp)).toBe(false);
      expect(existsSync(legacyFp + ".bak")).toBe(true);
      expect(existsSync(legacyDir)).toBe(false);
      expect(existsSync(legacyDir + ".bak")).toBe(true);

      // Success line printed to the provided log sink
      expect(
        logs.some((l) => l.startsWith("Migrated from agent-coord to batonq.")),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("idempotent: second run is a silent no-op", async () => {
    const { migrate } = await import("../src/migrate");
    const home = mkdtempSync(join(tmpdir(), "batonq-migrate-"));
    try {
      const claude = join(home, ".claude");
      mkdirSync(claude, { recursive: true });
      writeFileSync(join(claude, "agent-coord-state.db"), "payload");
      mkdirSync(join(claude, "agent-coord-measurement"), { recursive: true });
      writeFileSync(
        join(claude, "agent-coord-measurement", "events.jsonl"),
        "line\n",
      );

      const firstLogs: string[] = [];
      migrate({ home, log: (m) => firstLogs.push(m) });
      expect(firstLogs.some((l) => l.includes("Migrated"))).toBe(true);

      // Second call: new state exists, no legacy, must not emit any logs and
      // must not touch the new files.
      const newDbBefore = readFileSync(join(claude, "batonq-state.db"), "utf8");
      const secondLogs: string[] = [];
      migrate({ home, log: (m) => secondLogs.push(m) });
      expect(secondLogs.length).toBe(0);
      expect(readFileSync(join(claude, "batonq-state.db"), "utf8")).toBe(
        newDbBefore,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fresh install (no legacy state) is a no-op and emits nothing", async () => {
    const { migrate } = await import("../src/migrate");
    const home = mkdtempSync(join(tmpdir(), "batonq-migrate-"));
    try {
      const claude = join(home, ".claude");
      mkdirSync(claude, { recursive: true });

      const logs: string[] = [];
      migrate({ home, log: (m) => logs.push(m) });
      expect(logs.length).toBe(0);

      // No new-path files were conjured out of thin air.
      expect(existsSync(join(claude, "batonq-state.db"))).toBe(false);
      expect(existsSync(join(claude, "batonq-measurement"))).toBe(false);
      expect(existsSync(join(claude, "batonq-fingerprint.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite existing new-path data", async () => {
    // Defensive: a user could have started a fresh install (creating the new
    // DB via the hook) and *also* still have the legacy DB sitting around.
    // Migration must not clobber the live new-path data.
    const { migrate } = await import("../src/migrate");
    const home = mkdtempSync(join(tmpdir(), "batonq-migrate-"));
    try {
      const claude = join(home, ".claude");
      mkdirSync(claude, { recursive: true });
      writeFileSync(join(claude, "agent-coord-state.db"), "legacy");
      writeFileSync(join(claude, "batonq-state.db"), "fresh");

      const logs: string[] = [];
      migrate({ home, log: (m) => logs.push(m) });

      expect(readFileSync(join(claude, "batonq-state.db"), "utf8")).toBe(
        "fresh",
      );
      // Fast path via alreadyMigrated(): legacy file is untouched (no .bak).
      expect(existsSync(join(claude, "agent-coord-state.db"))).toBe(true);
      expect(existsSync(join(claude, "agent-coord-state.db.bak"))).toBe(false);
      expect(logs.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── uninstall.sh ──────────────────────────────────────────────────────────────
//
// The uninstaller is the exit-plan half of install.sh: removes binaries, strips
// the three batonq hook blocks from settings.json, and optionally removes state
// after an interactive confirm. Default for state is preserve — a reinstall
// picks up where the user left off.

describe("uninstall.sh", () => {
  const UNINSTALL = join(REPO_ROOT, "uninstall.sh");

  test("passes `sh -n` syntax check", () => {
    const r = spawnSync("sh", ["-n", UNINSTALL], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr ?? "").toBe("");
  });

  test("non-interactive stdin defaults to 'keep state' — state files survive", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "batonq-uninstall-"));
    try {
      const claude = join(fakeHome, ".claude");
      mkdirSync(claude, { recursive: true });

      // Seed the three state artefacts install.sh / the hook would create.
      const stateDb = join(claude, "batonq-state.db");
      const measurement = join(claude, "batonq-measurement");
      const fingerprint = join(claude, "batonq-fingerprint.json");
      writeFileSync(stateDb, "fake-db");
      mkdirSync(measurement, { recursive: true });
      writeFileSync(join(measurement, "events.jsonl"), '{"ts":"seed"}\n');
      writeFileSync(fingerprint, "{}");

      // settings.json with one batonq hook AND one unrelated hook. The
      // uninstaller must strip the batonq entry and leave the other alone.
      const settings = join(claude, "settings.json");
      writeFileSync(
        settings,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "Read|Edit|Write|MultiEdit",
                  hooks: [
                    {
                      type: "command",
                      command: "/usr/local/bin/batonq-hook pre",
                      timeout: 2,
                    },
                  ],
                },
                {
                  matcher: "Read",
                  hooks: [
                    {
                      type: "command",
                      command: "/usr/local/bin/my-other-hook",
                      timeout: 2,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      // Mock stdin: pipe empty input, which is also non-TTY → script takes
      // the `[ ! -t 0 ]` branch and defaults to keep without prompting.
      const r = spawnSync("sh", [UNINSTALL], {
        env: { ...process.env, HOME: fakeHome, PATH: process.env.PATH ?? "" },
        input: "",
        encoding: "utf8",
      });
      expect(r.status).toBe(0);

      // 1. State files are still there — the "no" default held.
      expect(existsSync(stateDb)).toBe(true);
      expect(existsSync(measurement)).toBe(true);
      expect(existsSync(fingerprint)).toBe(true);

      // 2. settings.json was rewritten: batonq hook gone, other hook preserved.
      const cfg = JSON.parse(readFileSync(settings, "utf8"));
      const pre = cfg.hooks?.PreToolUse ?? [];
      const hasBatonq = pre.some((b: any) =>
        (b.hooks ?? []).some(
          (h: any) =>
            typeof h.command === "string" &&
            /batonq-hook|agent-coord-hook/.test(h.command),
        ),
      );
      const hasOther = pre.some((b: any) =>
        (b.hooks ?? []).some(
          (h: any) =>
            typeof h.command === "string" &&
            h.command.includes("my-other-hook"),
        ),
      );
      expect(hasBatonq).toBe(false);
      expect(hasOther).toBe(true);

      // 3. The script announced that it kept state (signal to the user).
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      expect(out).toMatch(/keeping state|state preserved/i);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ── priority + scheduled_for feature ──────────────────────────────────────────

describe("priority + scheduled_for", () => {
  test("normalizePriority maps known, defaults unknown to 'normal'", () => {
    expect(normalizePriority("high")).toBe("high");
    expect(normalizePriority(" HIGH ")).toBe("high");
    expect(normalizePriority("Normal")).toBe("normal");
    expect(normalizePriority("low")).toBe("low");
    expect(normalizePriority("urgent")).toBe("normal");
    expect(normalizePriority("")).toBe("normal");
    expect(normalizePriority(null)).toBe("normal");
    expect(normalizePriority(undefined)).toBe("normal");
    expect(DEFAULT_PRIORITY).toBe("normal");
  });

  test("normalizeScheduledFor requires full ISO-8601 with time+tz", () => {
    expect(normalizeScheduledFor("2026-05-01T09:00:00Z")).toBe(
      "2026-05-01T09:00:00.000Z",
    );
    // Offset timezone is canonicalised to UTC Z
    expect(normalizeScheduledFor("2026-05-01T11:00:00+02:00")).toBe(
      "2026-05-01T09:00:00.000Z",
    );
    // Rejected: bare date, missing tz, garbage
    expect(normalizeScheduledFor("2026-05-01")).toBeNull();
    expect(normalizeScheduledFor("2026-05-01T09:00:00")).toBeNull();
    expect(normalizeScheduledFor("tomorrow")).toBeNull();
    expect(normalizeScheduledFor("")).toBeNull();
    expect(normalizeScheduledFor(null)).toBeNull();
  });

  test("parser extracts priority: and scheduled_for: directives", () => {
    const { tasks } = parseTasksText(
      [
        "## Pending",
        "- [ ] **any:infra** — urgent hotfix",
        "  priority: high",
        "  scheduled_for: 2026-05-01T09:00:00Z",
        "  verify: exit 0",
        "",
        "- [ ] **any:infra** — plain task with no metadata",
        "",
        "- [ ] **any:infra** — unknown priority falls back",
        "  priority: URGENT",
      ].join("\n"),
    );
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.priority).toBe("high");
    expect(tasks[0]!.scheduledFor).toBe("2026-05-01T09:00:00.000Z");
    expect(tasks[0]!.verifyCmd).toBe("exit 0");
    expect(tasks[1]!.priority).toBeUndefined();
    expect(tasks[1]!.scheduledFor).toBeUndefined();
    // normalizePriority lower-cases and rejects unknowns → "normal"
    expect(tasks[2]!.priority).toBe("normal");
  });

  test("parser ignores priority: / scheduled_for: inside code fences", () => {
    const { tasks } = parseTasksText(
      [
        "- [ ] **any:infra** — fenced example",
        "  Example markdown:",
        "  ```",
        "  priority: high",
        "  scheduled_for: 2026-05-01T09:00:00Z",
        "  ```",
      ].join("\n"),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.priority).toBeUndefined();
    expect(tasks[0]!.scheduledFor).toBeUndefined();
  });

  test("syncTasks persists priority + scheduled_for and updates on edit", () => {
    const db = memDb();
    const t: ParsedTask = {
      repo: "any:infra",
      body: "scheduled hotfix",
      status: "pending",
      lineIdx: 0,
      priority: "high",
      scheduledFor: "2026-05-01T09:00:00.000Z",
    };
    syncTasks(db, [t], "2026-04-23T10:00:00.000Z");
    let row = db
      .query("SELECT * FROM tasks WHERE repo = ?")
      .get("any:infra") as any;
    expect(row.priority).toBe("high");
    expect(row.scheduled_for).toBe("2026-05-01T09:00:00.000Z");

    // Editing the MD (priority flipped, schedule cleared) must re-rank the row.
    syncTasks(
      db,
      [{ ...t, priority: "low", scheduledFor: undefined }],
      "2026-04-23T10:05:00.000Z",
    );
    row = db
      .query("SELECT * FROM tasks WHERE repo = ?")
      .get("any:infra") as any;
    expect(row.priority).toBe("low");
    expect(row.scheduled_for).toBeNull();
    db.close();
  });

  test("default priority is 'normal' when the directive is absent", () => {
    const db = memDb();
    syncTasks(
      db,
      [{ repo: "any:infra", body: "plain", status: "pending", lineIdx: 0 }],
      "2026-04-23T10:00:00.000Z",
    );
    const row = db
      .query("SELECT priority, scheduled_for FROM tasks WHERE body = ?")
      .get("plain") as any;
    expect(row.priority).toBe("normal");
    expect(row.scheduled_for).toBeNull();
  });

  test("selectCandidate orders high → normal → low, FIFO within a priority", () => {
    const db = memDb();
    const mk = (body: string, priority: string, createdAt: string) =>
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, priority) VALUES (?, ?, ?, 'pending', ?, ?)`,
        [externalId("any:infra", body), "any:infra", body, createdAt, priority],
      );
    // Deliberately out-of-order insertion so the test would fail if the
    // query silently fell back to id/rowid ordering.
    mk("low-1", "low", "2026-04-23T10:00:00.000Z");
    mk("normal-2", "normal", "2026-04-23T10:00:02.000Z");
    mk("high-1", "high", "2026-04-23T10:00:03.000Z");
    mk("normal-1", "normal", "2026-04-23T10:00:01.000Z");
    mk("high-2", "high", "2026-04-23T10:00:04.000Z");

    // Drain the queue and record the order. Use a large "now" so scheduling
    // is a no-op; we only exercise priority + FIFO tiebreakers here.
    const seen: string[] = [];
    for (;;) {
      const c = selectCandidate(db, {
        repo: "any:infra",
        nowIso: "2099-01-01T00:00:00.000Z",
      });
      if (!c) break;
      seen.push(c.body);
      db.run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [c.id]);
    }
    expect(seen).toEqual(["high-1", "high-2", "normal-1", "normal-2", "low-1"]);
    db.close();
  });

  test("selectCandidate hides tasks whose scheduled_for is in the future", () => {
    const db = memDb();
    const mk = (body: string, sched: string | null, priority = "normal") =>
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, priority, scheduled_for) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        [
          externalId("any:infra", body),
          "any:infra",
          body,
          "2026-04-23T10:00:00.000Z",
          priority,
          sched,
        ],
      );
    mk("future-high", "2099-01-01T00:00:00.000Z", "high");
    mk("ripe-low", "2026-04-23T09:00:00.000Z", "low");
    mk("unscheduled-normal", null, "normal");

    const now = "2026-04-23T10:00:00.000Z";
    // At `now`, the high-priority task is still in the future — it MUST NOT
    // win, even though high outranks normal and low. The ripe low-priority
    // task is visible but loses to the unscheduled normal on priority.
    const c1 = selectCandidate(db, { repo: "any:infra", nowIso: now });
    expect(c1.body).toBe("unscheduled-normal");

    // After draining the normal task, pick falls through to the ripe low one
    // — but still skips the future high because its gate is closed.
    db.run(
      `UPDATE tasks SET status = 'done' WHERE body = 'unscheduled-normal'`,
    );
    const c2 = selectCandidate(db, { repo: "any:infra", nowIso: now });
    expect(c2.body).toBe("ripe-low");

    // Advance past the future task's scheduled_for — it now dominates.
    db.run(`UPDATE tasks SET status = 'done' WHERE body = 'ripe-low'`);
    const c3 = selectCandidate(db, {
      repo: "any:infra",
      nowIso: "2099-01-02T00:00:00.000Z",
    });
    expect(c3.body).toBe("future-high");
    db.close();
  });

  test("when two tasks share priority, earlier scheduled_for wins over later", () => {
    const db = memDb();
    const mk = (body: string, sched: string) =>
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, priority, scheduled_for) VALUES (?, ?, ?, 'pending', ?, 'normal', ?)`,
        [
          externalId("any:infra", body),
          "any:infra",
          body,
          // created_at deliberately reversed so FIFO alone would pick "later"
          body === "later"
            ? "2026-04-23T10:00:00.000Z"
            : "2026-04-23T10:00:05.000Z",
          sched,
        ],
      );
    mk("later", "2026-04-23T10:00:00.000Z"); // inserted first but later schedule
    mk("earlier", "2026-04-23T09:00:00.000Z"); // earlier schedule should win

    const c = selectCandidate(db, {
      repo: "any:infra",
      nowIso: "2099-01-01T00:00:00.000Z",
    });
    expect(c.body).toBe("earlier");
    db.close();
  });

  test("scope filters still apply on top of priority + schedule", () => {
    const db = memDb();
    const mk = (repo: string, body: string, priority = "normal") =>
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, priority) VALUES (?, ?, ?, 'pending', ?, ?)`,
        [
          externalId(repo, body),
          repo,
          body,
          "2026-04-23T10:00:00.000Z",
          priority,
        ],
      );
    mk("repo-a", "repo-a high", "high");
    mk("repo-b", "repo-b high", "high"); // must not leak into repo-a picks
    mk("any:infra", "any low", "low");

    const inA = selectCandidate(db, { repo: "repo-a" });
    expect(inA.body).toBe("repo-a high");
    const outOfRepo = selectCandidate(db, { repo: null });
    expect(outOfRepo.body).toBe("any low");
    const anyScope = selectCandidate(db, { repo: null, any: true });
    // With --any, repo-b's high-priority task becomes reachable.
    expect(["repo-a high", "repo-b high"]).toContain(anyScope.body);
    db.close();
  });

  test("buildTaskLines emits priority/scheduled_for only when non-default / set", () => {
    const basic = buildTaskLines({ repo: "any:infra", body: "x" });
    expect(basic).toEqual(["- [ ] **any:infra** — x"]);

    const withHigh = buildTaskLines({
      repo: "any:infra",
      body: "x",
      priority: "high",
      scheduledFor: "2026-05-01T09:00:00.000Z",
    });
    expect(withHigh).toEqual([
      "- [ ] **any:infra** — x",
      "  priority: high",
      "  scheduled_for: 2026-05-01T09:00:00.000Z",
    ]);

    // 'normal' is the default → don't serialise it (keep tasks terse)
    const withNormal = buildTaskLines({
      repo: "any:infra",
      body: "x",
      priority: "normal",
    });
    expect(withNormal).toEqual(["- [ ] **any:infra** — x"]);
  });

  test("initTaskSchema migration adds priority + scheduled_for to pre-existing DB", () => {
    // Simulate a legacy DB that has the "tasks" table WITHOUT the new columns.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE NOT NULL,
        repo TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `);
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, created_at) VALUES (?, 'any:infra', 'legacy', 'pending', ?)`,
      [externalId("any:infra", "legacy"), "2026-04-23T10:00:00.000Z"],
    );

    // Run migration.
    initTaskSchema(db);

    // New columns exist and default correctly for existing rows.
    const row = db
      .query("SELECT priority, scheduled_for FROM tasks WHERE body = 'legacy'")
      .get() as any;
    expect(row.priority).toBe("normal");
    expect(row.scheduled_for).toBeNull();

    // And pick now works against the migrated DB.
    const c = selectCandidate(db, {
      repo: "any:infra",
      nowIso: "2026-04-23T11:00:00.000Z",
    });
    expect(c.body).toBe("legacy");
    db.close();
  });
});

// ── agent field (multi-CLI dispatch) ──────────────────────────────────────────

describe("agent field", () => {
  const MIN_VALID = {
    external_id: "abc123",
    repo: "any:infra",
    body: "a minimally valid task body that clears the 20-char floor",
    priority: "normal",
    status: "pending",
  } as const;

  test("schema accepts each enum value (claude/codex/gemini/opencode/any)", () => {
    for (const agent of AGENTS) {
      const parsed = parseTaskInput({ ...MIN_VALID, agent });
      expect(parsed.agent).toBe(agent);
    }
    // Default fills in 'any' when the field is omitted entirely.
    const defaulted = parseTaskInput({ ...MIN_VALID });
    expect(defaulted.agent).toBe(DEFAULT_AGENT);
    expect(defaulted.agent).toBe("any");
  });

  test("AGENTS is derived from IMPLEMENTED_TOOLS — no hand-edited drift", () => {
    // Every runner registered in agent-runners must be a valid agent value,
    // and the only extra entry is 'any' (the round-robin default).
    for (const tool of IMPLEMENTED_TOOLS) {
      expect(AGENTS).toContain(tool);
    }
    expect(AGENTS).toContain("any");
    expect(Number(AGENTS.length)).toBe(IMPLEMENTED_TOOLS.length + 1);
  });

  test("schema rejects an unknown agent value with ZodError", () => {
    const res = TaskSchema.safeParse({ ...MIN_VALID, agent: "cursor" });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("agent");
    }
  });

  test("CLI --agent persists into the DB row", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "batonq-agent-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, "DEV"), { recursive: true });
    try {
      const r = spawnSync(
        BATONQ_BIN,
        [
          "add",
          "--body",
          "agent flag round-trip body that clears the 20-char floor",
          "--repo",
          "any:infra",
          "--agent",
          "codex",
        ],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            PATH: process.env.PATH ?? "",
          },
          encoding: "utf8",
        },
      );
      expect(r.status).toBe(0);
      const eid = (r.stdout ?? "").trim().replace(/^task added:\s+/, "");

      const db = new Database(join(fakeHome, ".claude", "batonq", "state.db"), {
        readonly: true,
      });
      const row = db
        .query("SELECT agent FROM tasks WHERE external_id = ?")
        .get(eid) as { agent: string };
      db.close();
      expect(row.agent).toBe("codex");

      // Default path: omit --agent, expect 'any' in the row.
      const r2 = spawnSync(
        BATONQ_BIN,
        [
          "add",
          "--body",
          "default agent body that clears the 20-char floor easily",
          "--repo",
          "any:infra",
        ],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            PATH: process.env.PATH ?? "",
          },
          encoding: "utf8",
        },
      );
      expect(r2.status).toBe(0);
      const eid2 = (r2.stdout ?? "").trim().replace(/^task added:\s+/, "");
      const db2 = new Database(
        join(fakeHome, ".claude", "batonq", "state.db"),
        { readonly: true },
      );
      const row2 = db2
        .query("SELECT agent FROM tasks WHERE external_id = ?")
        .get(eid2) as { agent: string };
      db2.close();
      expect(row2.agent).toBe("any");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("initTaskSchema agent migration is idempotent (multiple runs, no agent loss)", () => {
    // Legacy DB without the `agent` column.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE NOT NULL,
        repo TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `);
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, created_at) VALUES (?, 'any:infra', 'legacy-row', 'pending', ?)`,
      [externalId("any:infra", "legacy-row"), "2026-04-23T10:00:00.000Z"],
    );

    // First run: adds the agent column (NULL on existing rows).
    initTaskSchema(db);
    const cols1 = db
      .query("SELECT name FROM pragma_table_info('tasks')")
      .all() as { name: string }[];
    expect(cols1.some((c) => c.name === "agent")).toBe(true);
    const legacyRow1 = db
      .query("SELECT agent FROM tasks WHERE body = 'legacy-row'")
      .get() as { agent: string | null };
    expect(legacyRow1.agent).toBeNull();

    // Insert a fresh task — it should be tagged with the default agent.
    insertTask(db, {
      repo: "any:infra",
      body: "fresh row inserted between the two migration runs to detect data loss",
      agent: "gemini",
    });

    // Second run: no schema change, no data loss.
    expect(() => initTaskSchema(db)).not.toThrow();
    expect(() => initTaskSchema(db)).not.toThrow();

    const cols2 = db
      .query("SELECT name FROM pragma_table_info('tasks')")
      .all() as { name: string }[];
    const agentCount = cols2.filter((c) => c.name === "agent").length;
    expect(agentCount).toBe(1); // not duplicated

    const fresh = db
      .query("SELECT agent FROM tasks WHERE body LIKE 'fresh row inserted%'")
      .get() as { agent: string };
    expect(fresh.agent).toBe("gemini");

    const legacyRow2 = db
      .query("SELECT agent FROM tasks WHERE body = 'legacy-row'")
      .get() as { agent: string | null };
    expect(legacyRow2.agent).toBeNull();

    db.close();
  });
});

describe("@agent: / @model: annotations on TASKS.md task lines", () => {
  test("parser extracts @agent: annotation and strips it from the body", () => {
    const md = [
      "## Pending",
      "",
      "- [ ] **batonq** — fix the parser bug @agent:gemini",
    ].join("\n");
    const { tasks } = parseTasksText(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agent).toBe("gemini");
    expect(tasks[0]!.model).toBeUndefined();
    expect(tasks[0]!.body).toBe("fix the parser bug");
    expect(tasks[0]!.body).not.toContain("@agent");
  });

  test("parser extracts @model: annotation and strips it from the body", () => {
    const md = [
      "## Pending",
      "",
      "- [ ] **batonq** — refactor the loop @model:flash",
    ].join("\n");
    const { tasks } = parseTasksText(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agent).toBeUndefined();
    expect(tasks[0]!.model).toBe("flash");
    expect(tasks[0]!.body).toBe("refactor the loop");
    expect(tasks[0]!.body).not.toContain("@model");
  });

  test("both annotations together: agent + model parsed, body cleaned", () => {
    const md = [
      "## Pending",
      "",
      "- [ ] **batonq** — fix bug @agent:gemini @model:flash",
    ].join("\n");
    const { tasks } = parseTasksText(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agent).toBe("gemini");
    expect(tasks[0]!.model).toBe("flash");
    expect(tasks[0]!.body).toBe("fix bug");
  });

  test("no annotations: agent stays undefined on ParsedTask, defaults to 'any' on insert", () => {
    const md = [
      "## Pending",
      "",
      "- [ ] **batonq** — plain old task body, no annotations here",
    ].join("\n");
    const { tasks } = parseTasksText(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agent).toBeUndefined();
    expect(tasks[0]!.model).toBeUndefined();
    expect(tasks[0]!.body).toBe("plain old task body, no annotations here");

    const db = memDb();
    syncTasks(db, tasks);
    const row = db
      .query("SELECT agent, model FROM tasks WHERE repo = 'batonq'")
      .get() as { agent: string; model: string | null };
    expect(row.agent).toBe("any");
    expect(row.model).toBeNull();
    db.close();
  });

  test("re-parsing a stripped body is idempotent (same agent/model/body)", () => {
    const md = [
      "## Pending",
      "",
      "- [ ] **batonq** — fix bug @agent:codex @model:opus",
    ].join("\n");
    const first = parseTasksText(md).tasks[0]!;

    const cleaned = [
      "## Pending",
      "",
      `- [ ] **${first.repo}** — ${first.body}`,
    ].join("\n");
    const second = parseTasksText(cleaned).tasks[0]!;

    expect(second.body).toBe(first.body);
    // First pass had annotations → first.agent='codex'. Cleaned body has none
    // → second.agent=undefined. The body itself is stable across re-parses,
    // which is the property that matters for external_id stability.
    expect(second.agent).toBeUndefined();
    expect(second.model).toBeUndefined();
  });

  test("unknown agent annotation is stripped from body but agent stays unset", () => {
    // `cursor` isn't in IMPLEMENTED_TOOLS, but the annotation token is still
    // removed so a later sync after the user fixes the typo doesn't get
    // confused by stale `@agent:` cruft in the persisted body.
    const md = [
      "## Pending",
      "",
      "- [ ] **batonq** — explore something @agent:cursor",
    ].join("\n");
    const { tasks } = parseTasksText(md);
    expect(tasks[0]!.agent).toBeUndefined();
    expect(tasks[0]!.body).toBe("explore something");
    expect(tasks[0]!.body).not.toContain("@agent");
  });

  test("hyphenated annotation (`@agent:gemini-flash`) is rejected but stripped — idempotent", () => {
    // Captured value `gemini-flash` is not in IMPLEMENTED_TOOLS+'any', so
    // agent stays unset. Critically, the FULL token (including the
    // `-flash` tail) is stripped so re-parsing the cleaned body yields the
    // same result — no second-pass divergence.
    const first = extractAnnotations("fix bug @agent:gemini-flash extra text");
    expect(first.agent).toBeUndefined();
    expect(first.body).toBe("fix bug extra text");
    expect(first.body).not.toContain("@agent");
    expect(first.body).not.toContain("gemini-flash");

    const second = extractAnnotations(first.body);
    expect(second.agent).toBe(first.agent);
    expect(second.body).toBe(first.body);
  });

  test("empty annotation (`@agent:`) is left in body verbatim — not silently dropped", () => {
    // `[\w-]+` requires ≥1 character after the colon. A bare `@agent:`
    // with no value isn't an annotation — it's almost certainly a typo
    // mid-edit. We leave it untouched so it's visible in the persisted
    // body and the user can spot/fix it.
    const result = extractAnnotations("fix bug @agent: trailing");
    expect(result.agent).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.body).toBe("fix bug @agent: trailing");
  });

  test("@model: accepts hyphenated nicknames (no enum, freeform)", () => {
    // Models are runner-specific freeform nicknames (`gpt-4o`,
    // `claude-3-opus`, `gemini-pro`) so we accept hyphens verbatim.
    const result = extractAnnotations("write something @model:gemini-pro");
    expect(result.model).toBe("gemini-pro");
    expect(result.body).toBe("write something");
  });

  test("syncTasks persists agent + model from annotations onto the row", () => {
    const md = [
      "## Pending",
      "",
      "- [ ] **batonq** — implement routing @agent:gemini @model:flash",
    ].join("\n");
    const { tasks } = parseTasksText(md);
    const db = memDb();
    syncTasks(db, tasks);
    const row = db
      .query("SELECT agent, model, body FROM tasks WHERE repo = 'batonq'")
      .get() as { agent: string; model: string; body: string };
    expect(row.agent).toBe("gemini");
    expect(row.model).toBe("flash");
    expect(row.body).toBe("implement routing");
    db.close();
  });

  test("validatedInsertTask: explicit --agent flag wins over body annotation", () => {
    // Mirrors the CLI flow: caller passes both `--agent claude` and a body
    // that happens to contain `@agent:gemini`. The explicit field wins, but
    // the body is still cleaned of annotation tokens.
    const db = memDb();
    const eid = validatedInsertTask(db, {
      repo: "any:infra",
      body: "fix the broken thing @agent:gemini @model:flash extra padding to clear floor",
      agent: "claude",
    });
    const row = db
      .query("SELECT agent, model, body FROM tasks WHERE external_id = ?")
      .get(eid) as { agent: string; model: string | null; body: string };
    expect(row.agent).toBe("claude");
    // Model came from annotation (no explicit model field) — annotation
    // overrides absent default but loses to explicit fields.
    expect(row.model).toBe("flash");
    expect(row.body).not.toContain("@agent");
    expect(row.body).not.toContain("@model");
    db.close();
  });

  test("validatedInsertTask: annotation overrides 'any' default when no flag given", () => {
    const db = memDb();
    const eid = validatedInsertTask(db, {
      repo: "any:infra",
      body: "ship a feature @agent:codex with enough body to clear the 20-char floor",
    });
    const row = db
      .query("SELECT agent FROM tasks WHERE external_id = ?")
      .get(eid) as { agent: string };
    expect(row.agent).toBe("codex");
    db.close();
  });

  test("initTaskSchema model migration is idempotent", () => {
    // Legacy DB without the model column.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE NOT NULL,
        repo TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `);
    initTaskSchema(db);
    expect(() => initTaskSchema(db)).not.toThrow();
    const cols = db
      .query("SELECT name FROM pragma_table_info('tasks')")
      .all() as { name: string }[];
    expect(cols.filter((c) => c.name === "model").length).toBe(1);
    db.close();
  });
});
