// add-import-export — covers the DB-first input path introduced by
// arch fix 2/2. `batonq add` is validated via the full CLI so flag parsing
// and stdout contract are exercised; `import` and `export` are also run
// end-to-end against a temp $HOME so the deprecation header and import log
// side-effects are part of the test surface.

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
  DuplicateExternalIdError,
  EXPORT_SNAPSHOT_HEADER,
  exportTasksAsMarkdown,
  initClaimsSchema,
  initTaskSchema,
  insertTask,
  parseMarkdownTasksForImport,
  parseYamlTasksText,
  runImport,
  validatedInsertTask,
} from "../src/tasks-core";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const BATONQ_BIN = join(REPO_ROOT, "bin", "batonq");

let fakeHome: string;

function setupFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "batonq-add-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, "DEV"), { recursive: true });
  return home;
}

function dbAt(home: string): Database {
  return new Database(join(home, ".claude", "batonq", "state.db"), {
    readonly: true,
  });
}

function runBatonq(
  args: string[],
  opts: { home: string; input?: string } = { home: "" },
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(BATONQ_BIN, args, {
    env: { ...process.env, HOME: opts.home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    input: opts.input,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function memDb(): Database {
  const db = new Database(":memory:");
  initTaskSchema(db);
  initClaimsSchema(db);
  return db;
}

beforeEach(() => {
  fakeHome = setupFakeHome();
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

// ── `batonq add` — 7 cases ────────────────────────────────────────────────────

describe("batonq add", () => {
  test("--body is required in non-JSON mode (exits 2 with usage)", () => {
    const r = runBatonq(["add", "--repo", "any:infra"], { home: fakeHome });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--body is required/);
  });

  test("schema validation rejects short body (exit 1, Zod message in stderr)", () => {
    const r = runBatonq(["add", "--body", "too short", "--repo", "any:infra"], {
      home: fakeHome,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/schema validation failed/);
    expect(r.stderr).toMatch(/body/);
    const dbPath = join(fakeHome, ".claude", "batonq", "state.db");
    if (existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const n = (db.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
      db.close();
      expect(n).toBe(0);
    }
  });

  test("happy path with every flag round-trips into the DB", () => {
    const r = runBatonq(
      [
        "add",
        "--body",
        "the happy path body that definitely clears twenty chars",
        "--repo",
        "any:infra",
        "--verify",
        "bun test tests/core.test.ts",
        "--judge",
        "did the feature land in the right place?",
        "--priority",
        "high",
        "--at",
        "2026-05-01T09:00:00.000Z",
      ],
      { home: fakeHome },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^task added: [0-9a-f]{12}/);
    const eid = r.stdout.trim().replace(/^task added:\s+/, "");

    const db = dbAt(fakeHome);
    const row = db
      .query("SELECT * FROM tasks WHERE external_id = ?")
      .get(eid) as any;
    db.close();
    expect(row.repo).toBe("any:infra");
    expect(row.priority).toBe("high");
    expect(row.scheduled_for).toBe("2026-05-01T09:00:00.000Z");
    expect(row.verify_cmd).toBe("bun test tests/core.test.ts");
    expect(row.judge_cmd).toBe("did the feature land in the right place?");
    expect(row.status).toBe("pending");
  });

  test("--json reads a JSON object from stdin and inserts the task", () => {
    const payload = JSON.stringify({
      body: "a JSON-mode task body long enough to pass the schema gate",
      repo: "any:json-repo",
      priority: "low",
    });
    const r = runBatonq(["add", "--json"], { home: fakeHome, input: payload });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^task added: [0-9a-f]{12}/);

    const db = dbAt(fakeHome);
    const row = db
      .query("SELECT * FROM tasks WHERE repo = 'any:json-repo'")
      .get() as any;
    db.close();
    expect(row.priority).toBe("low");
    expect(row.body).toMatch(/^a JSON-mode task/);
  });

  test("duplicate external_id — second add exits 1 with a helpful message", () => {
    const body = "first-insert body that exceeds the twenty-char minimum floor";
    const first = runBatonq(["add", "--body", body, "--repo", "dup-repo"], {
      home: fakeHome,
    });
    expect(first.status).toBe(0);

    const second = runBatonq(["add", "--body", body, "--repo", "dup-repo"], {
      home: fakeHome,
    });
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/duplicate external_id/);

    const db = dbAt(fakeHome);
    const n = (
      db
        .query("SELECT COUNT(*) AS n FROM tasks WHERE repo = 'dup-repo'")
        .get() as any
    ).n;
    db.close();
    expect(n).toBe(1);
  });

  test("priority defaults to 'normal' when the flag is omitted", () => {
    const r = runBatonq(
      [
        "add",
        "--body",
        "default priority body that is long enough for the floor",
        "--repo",
        "any:infra",
      ],
      { home: fakeHome },
    );
    expect(r.status).toBe(0);
    const db = dbAt(fakeHome);
    const row = db.query("SELECT priority FROM tasks").get() as any;
    db.close();
    expect(row.priority).toBe("normal");
  });

  test("writes the deprecation header to TASKS.md exactly once (idempotent)", () => {
    const tasksPath = join(fakeHome, "DEV", "TASKS.md");
    writeFileSync(tasksPath, "# Tasks\n\n## Pending\n\n");

    const first = runBatonq(
      [
        "add",
        "--body",
        "first task to trigger the deprecation header append",
        "--repo",
        "any:infra",
      ],
      { home: fakeHome },
    );
    expect(first.status).toBe(0);
    expect(readFileSync(tasksPath, "utf8")).toMatch(
      /DEPRECATED — this file is no longer authoritative/,
    );

    const second = runBatonq(
      [
        "add",
        "--body",
        "second task — header must not be duplicated on this call",
        "--repo",
        "any:infra",
      ],
      { home: fakeHome },
    );
    expect(second.status).toBe(0);
    const matches = readFileSync(tasksPath, "utf8").match(
      /DEPRECATED — this file is no longer authoritative/g,
    );
    expect(matches).toHaveLength(1);
  });
});

// ── `batonq import` — 4 cases ─────────────────────────────────────────────────

describe("batonq import", () => {
  test("YAML array inserts valid entries and skips invalid ones", () => {
    const yaml = [
      "- body: first yaml task with a sufficiently long body here",
      "  repo: any:infra",
      "- body: second yaml task with priority and schedule set right",
      "  repo: test-repo",
      "  priority: high",
      "  scheduled_for: 2026-06-01T00:00:00Z",
      "- body: too short",
      "  repo: any:infra",
      "",
    ].join("\n");
    const file = join(fakeHome, "tasks.yaml");
    writeFileSync(file, yaml);

    const r = runBatonq(["import", file], { home: fakeHome });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/imported 2 tasks \(1 invalid — see .+\.log\)/);

    const db = dbAt(fakeHome);
    const rows = db
      .query("SELECT repo, priority FROM tasks ORDER BY repo")
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows[1].repo).toBe("test-repo");
    expect(rows[1].priority).toBe("high");
  });

  test("markdown file imports non-done tasks and maps claimed→pending", () => {
    const md = [
      "# Tasks",
      "",
      "## Pending",
      "",
      "- [ ] **any:infra** — first markdown task body that is long enough",
      "  verify: bun test tests/core.test.ts",
      "- [~] **other** — claimed-in-md body that is also long enough to pass",
      "",
      "## Done",
      "",
      "- [x] 2026-01-01 **any:infra** — done-in-md should be skipped on import",
      "",
    ].join("\n");
    const file = join(fakeHome, "tasks.md");
    writeFileSync(file, md);

    const r = runBatonq(["import", file], { home: fakeHome });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/imported 2 tasks/);

    const db = dbAt(fakeHome);
    const rows = db
      .query("SELECT repo, status FROM tasks ORDER BY repo")
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  test("mixed valid + invalid: valid inserted, invalid logged in the import log", () => {
    const yaml = [
      "- body: valid entry one — long enough body to clear schema floor",
      "  repo: any:infra",
      "- body: ''",
      "  repo: broken-empty-body",
      "- body: valid entry two — also long enough to clear the floor",
      "  repo: any:infra",
      "- body: this one is fine but the priority is bogus so it fails",
      "  repo: any:infra",
      "  priority: URGENT",
      "",
    ].join("\n");
    const file = join(fakeHome, "mixed.yaml");
    writeFileSync(file, yaml);

    const r = runBatonq(["import", file], { home: fakeHome });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/imported 2 tasks \(2 invalid — see (.+\.log)\)/);
    const logPath = r.stdout.match(/see (\S+\.log)/)?.[1];
    expect(logPath).toBeTruthy();
    expect(existsSync(logPath!)).toBe(true);
    const log = readFileSync(logPath!, "utf8");
    expect(log).toMatch(/body/);
    expect(log).toMatch(/priority/);
  });

  test("duplicate external_ids in one import: first wins, rest skipped (not errors)", () => {
    const yaml = [
      "- body: same body repeated twice should be imported only once",
      "  repo: dup-repo",
      "- body: same body repeated twice should be imported only once",
      "  repo: dup-repo",
      "",
    ].join("\n");
    const file = join(fakeHome, "dup.yaml");
    writeFileSync(file, yaml);

    const r = runBatonq(["import", file], { home: fakeHome });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/imported 1 tasks \(1 duplicate — see .+\.log\)/);

    const db = dbAt(fakeHome);
    const n = (db.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
    db.close();
    expect(n).toBe(1);
  });
});

// ── `batonq export --md` — 2 cases ────────────────────────────────────────────

describe("batonq export --md", () => {
  test("empty DB still emits a valid snapshot with the read-only header", () => {
    const r = runBatonq(["export", "--md"], { home: fakeHome });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /^# Snapshot — read-only, regenerate with 'batonq export'/,
    );
    expect(r.stdout).toMatch(/## Pending/);
  });

  test("add → export roundtrips: every added task appears in the snapshot", () => {
    runBatonq(
      [
        "add",
        "--body",
        "roundtrip task one — body long enough for schema gate",
        "--repo",
        "any:infra",
      ],
      { home: fakeHome },
    );
    runBatonq(
      [
        "add",
        "--body",
        "roundtrip task two — body long enough for schema gate",
        "--repo",
        "test-repo",
        "--priority",
        "high",
      ],
      { home: fakeHome },
    );
    const r = runBatonq(["export", "--md"], { home: fakeHome });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "- [ ] **any:infra** — roundtrip task one — body long enough for schema gate",
    );
    expect(r.stdout).toContain(
      "- [ ] **test-repo** — roundtrip task two — body long enough for schema gate",
    );
    expect(r.stdout).toMatch(/priority: high/);
    const imported = parseMarkdownTasksForImport(r.stdout);
    const bodies = imported.map((t) => t.body).sort();
    expect(bodies[0]).toMatch(/roundtrip task one/);
    expect(bodies[1]).toMatch(/roundtrip task two/);
  });
});

// ── `pick` hot path is DB-only (TASKS.md live sync removed) ───────────────────

describe("pick hot path is DB-only", () => {
  test("a task in TASKS.md is NOT visible to pick without explicit sync-tasks", () => {
    const tasksPath = join(fakeHome, "DEV", "TASKS.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "## Pending",
        "",
        "- [ ] **any:infra** — task written only to TASKS.md, should not leak",
        "",
      ].join("\n"),
    );
    const pick = runBatonq(["pick", "--any"], { home: fakeHome });
    expect(pick.status).toBe(0);
    expect(pick.stdout).toContain("NO_TASK");

    // sync-tasks is still available as an explicit one-way import
    const sync = runBatonq(["sync-tasks"], { home: fakeHome });
    expect(sync.status).toBe(0);
    const pickAfter = runBatonq(["pick", "--any"], { home: fakeHome });
    expect(pickAfter.status).toBe(0);
    expect(pickAfter.stdout).toContain("TASK_CLAIMED");
  });

  test("pick works on DB-only tasks when TASKS.md is moved away", () => {
    // Seed a task directly into the DB via `batonq add`, then remove TASKS.md
    // entirely. pick must still surface the task — proving it reads the DB,
    // not the file. Regression guard against reintroducing a syncTasks() call
    // on the pick hot path (pre-arch-2 behaviour).
    const add = runBatonq(
      [
        "add",
        "--body",
        "db-only task that must survive TASKS.md being moved away",
        "--repo",
        "any:infra",
      ],
      { home: fakeHome },
    );
    expect(add.status).toBe(0);

    const tasksPath = join(fakeHome, "DEV", "TASKS.md");
    if (existsSync(tasksPath)) {
      rmSync(tasksPath);
    }
    expect(existsSync(tasksPath)).toBe(false);

    const pick = runBatonq(["pick", "--any"], { home: fakeHome });
    expect(pick.status).toBe(0);
    expect(pick.stdout).toContain("TASK_CLAIMED");
    expect(pick.stdout).toContain(
      "db-only task that must survive TASKS.md being moved away",
    );
  });
});

// ── tasks-core unit tests (no CLI spawn) ──────────────────────────────────────

describe("tasks-core insertTask / validatedInsertTask", () => {
  test("insertTask rejects duplicates with DuplicateExternalIdError", () => {
    const db = memDb();
    try {
      insertTask(db, {
        repo: "any:infra",
        body: "first-core-insert with a body long enough to be valid",
      });
      expect(() =>
        insertTask(db, {
          repo: "any:infra",
          body: "first-core-insert with a body long enough to be valid",
        }),
      ).toThrow(DuplicateExternalIdError);
    } finally {
      db.close();
    }
  });

  test("validatedInsertTask canonicalises scheduled_for and defaults priority", () => {
    const db = memDb();
    try {
      const eid = validatedInsertTask(db, {
        repo: "any:infra",
        body: "a validated insert through the schema gate definitely",
        scheduled_for: "2026-05-01T09:00:00+02:00",
      });
      const row = db
        .query("SELECT * FROM tasks WHERE external_id = ?")
        .get(eid) as any;
      expect(row.scheduled_for).toBe("2026-05-01T07:00:00.000Z");
      expect(row.priority).toBe("normal");
    } finally {
      db.close();
    }
  });
});

describe("tasks-core parseYamlTasksText", () => {
  test("accepts top-level array AND { tasks: [...] } wrapper", () => {
    const a = parseYamlTasksText("- body: one\n- body: two\n");
    expect(a).toHaveLength(2);
    const b = parseYamlTasksText("tasks:\n  - body: one\n  - body: two\n");
    expect(b).toHaveLength(2);
  });

  test("throws a helpful error on shapes that aren't a task list", () => {
    expect(() => parseYamlTasksText("not: a list\n")).toThrow(/array/);
  });
});

describe("tasks-core runImport report", () => {
  test("counts imported / invalid / duplicate accurately", () => {
    const db = memDb();
    try {
      const report = runImport(db, [
        { repo: "r1", body: "first valid import body that is long enough" },
        { repo: "r1", body: "first valid import body that is long enough" },
        { repo: "r2", body: "too short" },
      ]);
      expect(report.imported).toBe(1);
      expect(report.duplicates).toBe(1);
      expect(report.invalid).toBe(1);
      expect(report.validExternalIds).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("tasks-core exportTasksAsMarkdown", () => {
  test("renders the snapshot header and tasks in pick order", () => {
    const db = memDb();
    try {
      insertTask(db, {
        repo: "any:a",
        body: "normal-priority body long enough to be valid here",
      });
      insertTask(db, {
        repo: "any:b",
        body: "high-priority body long enough to be valid here too",
        priority: "high",
      });
      const md = exportTasksAsMarkdown(db);
      expect(md.startsWith(EXPORT_SNAPSHOT_HEADER)).toBe(true);
      const hIdx = md.indexOf("any:b");
      const nIdx = md.indexOf("any:a");
      expect(hIdx).toBeGreaterThan(0);
      expect(nIdx).toBeGreaterThan(hIdx);
    } finally {
      db.close();
    }
  });
});
