// retry-with-context.test — Phase 1.5 of Track D: when a dispatch dies with
// preserved work on a wip branch, the task transitions to needs-retry
// (not abandon), the next pick re-claims it, and the pick output carries
// the wip branch + last failure reason so the agent can continue from
// where it left off rather than redoing from scratch.
//
// What we ASSERT here:
//   1. The migration adds attempt_count / last_wip_branch / last_failure_reason
//      columns idempotently.
//   2. selectCandidate picks needs-retry rows with the same priority/age
//      semantics as pending (they're not boosted; not starved).
//   3. claimCandidate accepts needs-retry status (not just pending).
//   4. mark-needs-retry increments attempt_count, stores wip branch + reason,
//      transitions to 'needs-retry'.
//   5. After BATONQ_MAX_ATTEMPTS, mark-needs-retry falls through to true
//      abandon and clears the counter.
//   6. abandon clears the retry counter so a fresh attempt starts at 0.
//
// What we do NOT assert here (out of scope for Phase 1.5):
//   - The pickTask CLI's diff-stat printing — that requires a real git repo
//     fixture and is exercised end-to-end in the dispatch loop. Pure-DB
//     assertions are sufficient for the schema + state-machine guarantees.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initTaskSchema,
  selectCandidate,
  claimCandidate,
  validatedInsertTask,
} from "../src/tasks-core";
import { migrateRetryColumns } from "../src/migrate";

function memDb(): Database {
  const db = new Database(":memory:");
  initTaskSchema(db);
  return db;
}

function insert(
  db: Database,
  body: string,
  overrides: { priority?: string; status?: string } = {},
): string {
  // Raw insert — these tests target the dispatch state machine, not the
  // input validator. validatedInsertTask would reject schema-non-allowed
  // statuses (lost, draft) and short bodies; both are legitimate states the
  // retry flow needs to handle.
  const eid = `eid${Math.random().toString(36).slice(2, 14)}`;
  db.run(
    `INSERT INTO tasks (external_id, repo, body, status, priority, created_at)
     VALUES (?, 'any:infra', ?, ?, ?, datetime('now'))`,
    [eid, body, overrides.status ?? "pending", overrides.priority ?? "normal"],
  );
  return eid;
}

describe("migrateRetryColumns", () => {
  test("adds the 3 columns on first run, idempotent on second", () => {
    const db = memDb();
    const have = (col: string) =>
      (
        db.query("SELECT name FROM pragma_table_info('tasks')").all() as {
          name: string;
        }[]
      ).some((r) => r.name === col);
    // initTaskSchema already invokes migrateRetryColumns indirectly, so they
    // should be present after schema init.
    expect(have("attempt_count")).toBe(true);
    expect(have("last_wip_branch")).toBe(true);
    expect(have("last_failure_reason")).toBe(true);
    // Re-running directly must not throw or duplicate.
    expect(() => migrateRetryColumns(db)).not.toThrow();
  });

  test("default attempt_count = 0 on new rows", () => {
    const db = memDb();
    const eid = insert(db, "task one");
    const row = db
      .query("SELECT attempt_count FROM tasks WHERE external_id = ?")
      .get(eid) as { attempt_count: number };
    expect(row.attempt_count).toBe(0);
  });
});

describe("selectCandidate accepts needs-retry like pending", () => {
  test("needs-retry row is pickable", () => {
    const db = memDb();
    insert(db, "the only candidate", { status: "needs-retry" });
    const cand = selectCandidate(db, { repo: null, any: true });
    expect(cand).toBeTruthy();
    expect(cand.status).toBe("needs-retry");
  });

  test("pending of higher priority beats needs-retry of lower priority", () => {
    const db = memDb();
    insert(db, "low retry", { status: "needs-retry", priority: "low" });
    const high = insert(db, "fresh high", { priority: "high" });
    const cand = selectCandidate(db, { repo: null, any: true });
    expect(cand.external_id).toBe(high);
  });

  test("needs-retry of higher priority beats pending of lower", () => {
    const db = memDb();
    insert(db, "low pending", { priority: "low" });
    const eid = insert(db, "high retry", {
      status: "needs-retry",
      priority: "high",
    });
    const cand = selectCandidate(db, { repo: null, any: true });
    expect(cand.external_id).toBe(eid);
  });

  test("at equal priority, older (created_at) wins regardless of status", () => {
    const db = memDb();
    // First inserted = oldest. Make it needs-retry; pending peer is newer.
    const older = insert(db, "older retry", { status: "needs-retry" });
    insert(db, "newer pending");
    const cand = selectCandidate(db, { repo: null, any: true });
    expect(cand.external_id).toBe(older);
  });
});

describe("claimCandidate transitions needs-retry → claimed", () => {
  test("claim succeeds on needs-retry", () => {
    const db = memDb();
    const eid = insert(db, "retryable", { status: "needs-retry" });
    const id = (
      db.query("SELECT id FROM tasks WHERE external_id = ?").get(eid) as {
        id: number;
      }
    ).id;
    const result = claimCandidate(db, id, "session-x");
    expect(result.changes).toBe(1);
    const row = db.query("SELECT status FROM tasks WHERE id = ?").get(id) as {
      status: string;
    };
    expect(row.status).toBe("claimed");
  });

  test("claim refuses other states (done, draft, lost)", () => {
    const db = memDb();
    for (const status of ["done", "draft", "lost"]) {
      const eid = insert(db, `bad-state-${status}`, { status });
      const id = (
        db.query("SELECT id FROM tasks WHERE external_id = ?").get(eid) as {
          id: number;
        }
      ).id;
      const result = claimCandidate(db, id, "session-x");
      expect(result.changes).toBe(0);
    }
  });
});

// markNeedsRetry is tested via the binary because it lives in agent-coord
// (the CLI) and uses the live DB. We exec the source via `bun src/agent-coord`
// so we get real CLI behavior without depending on whatever stale binary is
// at ~/.local/bin/batonq.
describe("batonq mark-needs-retry CLI", () => {
  function runCli(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(
      "bun",
      [join(import.meta.dir, "..", "src", "agent-coord"), ...args],
      {
        encoding: "utf8",
        // Spread caller's env LAST so per-test overrides (HOME,
        // BATONQ_MAX_ATTEMPTS, etc.) actually win over process.env.
        env: { ...process.env, ...env },
      },
    );
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  function makeFixture() {
    const home = require("node:fs").realpathSync(
      mkdtempSync(join(tmpdir(), "retry-cli-")),
    );
    require("node:fs").mkdirSync(join(home, ".claude", "batonq"), {
      recursive: true,
    });
    return {
      home,
      cleanup: () => rmSync(home, { recursive: true, force: true }),
    };
  }

  function seedTask(home: string, eid: string, attemptCount = 0): void {
    const dbPath = join(home, ".claude", "batonq", "state.db");
    const db = new Database(dbPath);
    initTaskSchema(db);
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, claimed_by, claimed_at,
       created_at, attempt_count)
       VALUES (?, 'any:infra', 'test', 'claimed', 'session-x',
       datetime('now'), datetime('now'), ?)`,
      [eid, attemptCount],
    );
    db.close();
  }

  function readTask(home: string, eid: string) {
    const dbPath = join(home, ".claude", "batonq", "state.db");
    const db = new Database(dbPath);
    try {
      return db
        .query("SELECT * FROM tasks WHERE external_id = ?")
        .get(eid) as any;
    } finally {
      db.close();
    }
  }

  test("first call: status → needs-retry, attempt_count = 1, wip + reason stored", () => {
    const fx = makeFixture();
    try {
      const eid = "abcdef0123";
      seedTask(fx.home, eid, 0);
      const r = runCli(
        [
          "mark-needs-retry",
          eid,
          "batonq/wip/abcdef0123/1",
          "exit 143 (SIGTERM)",
        ],
        { HOME: fx.home },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/needs-retry.*attempt 1\/3/);
      const row = readTask(fx.home, eid);
      expect(row.status).toBe("needs-retry");
      expect(row.attempt_count).toBe(1);
      expect(row.last_wip_branch).toBe("batonq/wip/abcdef0123/1");
      expect(row.last_failure_reason).toMatch(/SIGTERM/);
      // Claim cleared so the next pick can re-claim it under a fresh session
      expect(row.claimed_by).toBeNull();
      expect(row.claimed_at).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  test("third call (exceeding default cap of 3): falls through to true abandon, counter cleared", () => {
    const fx = makeFixture();
    try {
      const eid = "feedface0123";
      // Pre-load the row at attempt_count=3 so the next call would be #4 (>cap).
      seedTask(fx.home, eid, 3);
      const r = runCli(
        ["mark-needs-retry", eid, "batonq/wip/feedface0123/4", "exit 143"],
        { HOME: fx.home },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/max-attempts \(3\) reached/);
      const row = readTask(fx.home, eid);
      // Truly abandoned: status pending, counter zeroed, no wip pointer
      expect(row.status).toBe("pending");
      expect(row.attempt_count).toBe(0);
      expect(row.last_wip_branch).toBeNull();
      expect(row.last_failure_reason).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  test("BATONQ_MAX_ATTEMPTS env overrides the default cap", () => {
    const fx = makeFixture();
    try {
      const eid = "cafebabe0123";
      seedTask(fx.home, eid, 1);
      // Set cap=1, current=1, so this call (would-be attempt 2) exceeds.
      const r = runCli(
        ["mark-needs-retry", eid, "batonq/wip/cafebabe0123/2", "exit 124"],
        { HOME: fx.home, BATONQ_MAX_ATTEMPTS: "1" },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/max-attempts \(1\) reached/);
      const row = readTask(fx.home, eid);
      expect(row.status).toBe("pending");
    } finally {
      fx.cleanup();
    }
  });

  test("missing args → usage error, no DB change", () => {
    const fx = makeFixture();
    try {
      const eid = "missing0123";
      seedTask(fx.home, eid, 0);
      const r = runCli(["mark-needs-retry"], { HOME: fx.home });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/usage/);
      const row = readTask(fx.home, eid);
      expect(row.attempt_count).toBe(0);
      expect(row.status).toBe("claimed"); // untouched
    } finally {
      fx.cleanup();
    }
  });
});

describe("abandon clears the retry counter", () => {
  test("abandoning a needs-retry task resets attempt_count, clears wip pointers", () => {
    const fx = (() => {
      const home = require("node:fs").realpathSync(
        mkdtempSync(join(tmpdir(), "retry-abandon-")),
      );
      require("node:fs").mkdirSync(join(home, ".claude", "batonq"), {
        recursive: true,
      });
      return {
        home,
        cleanup: () => rmSync(home, { recursive: true, force: true }),
      };
    })();
    try {
      const eid = "abandonme01";
      const dbPath = join(fx.home, ".claude", "batonq", "state.db");
      const db = new Database(dbPath);
      initTaskSchema(db);
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, claimed_by, claimed_at,
         created_at, attempt_count, last_wip_branch, last_failure_reason)
         VALUES (?, 'any:infra', 'x', 'needs-retry', 'session-x',
         datetime('now'), datetime('now'), 2, 'batonq/wip/abandonme01/2',
         'exit 143')`,
        [eid],
      );
      db.close();

      const r = spawnSync(
        "bun",
        [join(import.meta.dir, "..", "src", "agent-coord"), "abandon", eid],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: fx.home },
        },
      );
      expect(r.status ?? 0).toBe(0);

      const after = (() => {
        const dbA = new Database(dbPath);
        try {
          return dbA
            .query("SELECT * FROM tasks WHERE external_id = ?")
            .get(eid) as any;
        } finally {
          dbA.close();
        }
      })();
      expect(after.status).toBe("pending");
      expect(after.attempt_count).toBe(0);
      expect(after.last_wip_branch).toBeNull();
      expect(after.last_failure_reason).toBeNull();
    } finally {
      fx.cleanup();
    }
  });
});
