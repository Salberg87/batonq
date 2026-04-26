// tui.test — mock-data tests for TUI data pipeline.
// Pure helpers from tui-data.ts exercised against an in-memory SQLite DB
// and synthetic events, so no touching of ~/.claude state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import {
  filterClaims,
  filterEvents,
  filterSessions,
  filterTasks,
  formatAge,
  formatExpiresIn,
  latestTasks,
  loadSnapshot,
  parseEventsJsonl,
  readEventsTail,
  sessionStatus,
  shortId,
  shortPath,
  type Snapshot,
  type TaskRow,
} from "../src/tui-data";
import {
  appendTaskToPending,
  validateNewTask,
  type NewTask,
} from "../src/tasks-core";
import {
  AddTaskForm,
  App,
  findTaskByEid,
  parseQuestions,
  QuestionsOverlay,
  type ParsedQuestion,
} from "../src/tui";
import { LoopStatusFooter, TasksPanel } from "../src/tui-panels";
import {
  EVENTS_CRIT_SEC,
  EVENTS_WARN_SEC,
  eventsAgeColor,
  eventsAgeSec,
  findLoopCurrentTask,
  formatEventsAge,
  loopStateGlyph,
  parsePgrepPids,
  parsePsEtimes,
  taskBodyPreview,
  type LoopStatus,
} from "../src/loop-status";

// ── schema helpers ────────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      cwd TEXT,
      started_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,
      file_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      release_hash TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE NOT NULL,
      repo TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

const NOW = Date.parse("2026-04-22T12:00:00.000Z");
const iso = (offsetSec: number) =>
  new Date(NOW + offsetSec * 1000).toISOString();

function seedSession(
  db: Database,
  id: string,
  cwd: string,
  ageSec: number,
): void {
  db.run(
    `INSERT INTO sessions (session_id, cwd, started_at, last_seen) VALUES (?, ?, ?, ?)`,
    [id, cwd, iso(-3600), iso(-ageSec)],
  );
}

function seedClaim(
  db: Database,
  filePath: string,
  sessionId: string,
  ageSec: number,
  ttlSec: number,
  released = false,
): void {
  db.run(
    `INSERT INTO claims (fingerprint, file_path, session_id, acquired_at, expires_at, released_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      "fp-x",
      filePath,
      sessionId,
      iso(-ageSec),
      iso(ttlSec - ageSec),
      released ? iso(-1) : null,
    ],
  );
}

function seedTask(
  db: Database,
  ext: string,
  repo: string,
  body: string,
  status: "pending" | "claimed" | "done",
  claimedAgo?: number,
  completedAgo?: number,
): void {
  db.run(
    `INSERT INTO tasks (external_id, repo, body, status, claimed_by, claimed_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ext,
      repo,
      body,
      status,
      status === "claimed" ? "sess-A" : null,
      claimedAgo != null ? iso(-claimedAgo) : null,
      completedAgo != null ? iso(-completedAgo) : null,
      iso(-3600),
    ],
  );
}

// ── formatters ────────────────────────────────────────────────────────────────

describe("formatAge", () => {
  test("seconds", () => expect(formatAge(iso(-45), NOW)).toBe("45s"));
  test("minutes", () => expect(formatAge(iso(-125), NOW)).toBe("2m"));
  test("hours", () => expect(formatAge(iso(-3600 * 3), NOW)).toBe("3h"));
  test("days", () => expect(formatAge(iso(-86400 * 3), NOW)).toBe("3d"));
  test("invalid input is ?", () => expect(formatAge("nope", NOW)).toBe("?"));
});

describe("formatExpiresIn", () => {
  test("future seconds", () =>
    expect(formatExpiresIn(iso(30), NOW)).toBe("30s"));
  test("future minutes", () =>
    expect(formatExpiresIn(iso(600), NOW)).toBe("10m"));
  test("past => expired", () =>
    expect(formatExpiresIn(iso(-1), NOW)).toBe("expired"));
});

describe("sessionStatus", () => {
  test("live < 60s", () => expect(sessionStatus(iso(-10), NOW)).toBe("live"));
  test("idle 1–5m", () => expect(sessionStatus(iso(-120), NOW)).toBe("idle"));
  test("stale > 5m", () =>
    expect(sessionStatus(iso(-3600), NOW)).toBe("stale"));
});

describe("shortPath + shortId", () => {
  test("shortPath keeps tail with ellipsis prefix", () => {
    const out = shortPath("/a/very/long/path/to/file.ts", 15);
    expect(out.length).toBe(15);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("file.ts")).toBe(true);
  });
  test("shortPath passthrough", () =>
    expect(shortPath("short", 10)).toBe("short"));
  test("shortId truncates", () =>
    expect(shortId("abcdef12345", 6)).toBe("abcdef"));
  test("shortId passthrough", () => expect(shortId("abc", 6)).toBe("abc"));
});

// ── filters ───────────────────────────────────────────────────────────────────

describe("filterTasks", () => {
  const tasks: TaskRow[] = [
    {
      id: 1,
      external_id: "aaa",
      repo: "repo-a",
      body: "write TUI",
      status: "pending",
      claimed_by: null,
      claimed_at: null,
      completed_at: null,
      created_at: iso(-10),
    },
    {
      id: 2,
      external_id: "bbb",
      repo: "repo-b",
      body: "ship docs",
      status: "claimed",
      claimed_by: "sess",
      claimed_at: iso(-5),
      completed_at: null,
      created_at: iso(-20),
    },
  ];
  test("empty query returns all", () =>
    expect(filterTasks(tasks, "")).toHaveLength(2));
  test("body match", () =>
    expect(filterTasks(tasks, "docs").map((t) => t.external_id)).toEqual([
      "bbb",
    ]));
  test("repo match", () =>
    expect(filterTasks(tasks, "repo-a").map((t) => t.external_id)).toEqual([
      "aaa",
    ]));
  test("status match", () =>
    expect(filterTasks(tasks, "claimed").map((t) => t.external_id)).toEqual([
      "bbb",
    ]));
  test("no match", () => expect(filterTasks(tasks, "xxx")).toHaveLength(0));
});

describe("filterSessions / filterClaims / filterEvents", () => {
  test("sessions filter by cwd", () => {
    const rows = [
      {
        session_id: "a",
        cwd: "/repo-x",
        started_at: iso(0),
        last_seen: iso(0),
      },
      {
        session_id: "b",
        cwd: "/repo-y",
        started_at: iso(0),
        last_seen: iso(0),
      },
    ];
    expect(filterSessions(rows, "repo-x").map((s) => s.session_id)).toEqual([
      "a",
    ]);
  });
  test("claims filter by file path", () => {
    const rows = [
      {
        id: 1,
        fingerprint: "fp",
        file_path: "/src/a.ts",
        session_id: "s",
        acquired_at: iso(0),
        expires_at: iso(60),
        released_at: null,
      },
      {
        id: 2,
        fingerprint: "fp",
        file_path: "/src/b.ts",
        session_id: "s",
        acquired_at: iso(0),
        expires_at: iso(60),
        released_at: null,
      },
    ];
    expect(filterClaims(rows, "a.ts").map((c) => c.id)).toEqual([1]);
  });
  test("events filter by tool", () => {
    const rows = [
      { ts: iso(0), phase: "pre", tool: "Read", paths: ["/x"] },
      { ts: iso(0), phase: "pre", tool: "Write", paths: ["/y"] },
    ];
    expect(filterEvents(rows, "write").map((e) => e.tool)).toEqual(["Write"]);
  });
});

// ── events parsing ────────────────────────────────────────────────────────────

describe("parseEventsJsonl", () => {
  test("limits to last N", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ ts: iso(-i), phase: "pre", tool: `T${i}` }),
    ).join("\n");
    expect(parseEventsJsonl(lines, 5)).toHaveLength(5);
  });
  test("skips malformed lines", () => {
    const lines =
      '{"ts":"2026-04-22T00:00:00.000Z","phase":"pre","tool":"Read"}\n' +
      "not-json\n" +
      '{"ts":"2026-04-22T00:00:01.000Z","phase":"post","tool":"Read"}';
    expect(parseEventsJsonl(lines, 20)).toHaveLength(2);
  });
  test("empty input", () => expect(parseEventsJsonl("", 20)).toEqual([]));
});

describe("readEventsTail", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "batonq-tui-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("returns [] when missing", () => {
    expect(readEventsTail(join(dir, "nope.jsonl"))).toEqual([]);
  });
  test("reads tail of jsonl", () => {
    const p = join(dir, "events.jsonl");
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ ts: iso(-i), phase: "pre", tool: `T${i}` }),
    ).join("\n");
    writeFileSync(p, lines + "\n");
    const tail = readEventsTail(p, 10);
    expect(tail).toHaveLength(10);
    // last line in the file is T29 (i=29 is last from Array.from)
    expect(tail[tail.length - 1]?.tool).toBe("T29");
    expect(tail[0]?.tool).toBe("T20");
  });
});

// ── latestTasks / loadSnapshot ────────────────────────────────────────────────

describe("latestTasks", () => {
  test("sorts by most-recent timestamp", () => {
    const mk = (
      ext: string,
      done?: number,
      claimed?: number,
      created = 3600,
    ): TaskRow => ({
      id: 0,
      external_id: ext,
      repo: "r",
      body: ext,
      status: done != null ? "done" : claimed != null ? "claimed" : "pending",
      claimed_by: null,
      claimed_at: claimed != null ? iso(-claimed) : null,
      completed_at: done != null ? iso(-done) : null,
      created_at: iso(-created),
    });
    const out = latestTasks(
      [
        mk("old", undefined, undefined, 9999),
        mk("new", 5),
        mk("mid", undefined, 30),
      ],
      3,
    );
    expect(out.map((t) => t.external_id)).toEqual(["new", "mid", "old"]);
  });
});

describe("loadSnapshot", () => {
  test("aggregates mock DB into snapshot shape", () => {
    const db = makeDb();

    seedSession(db, "sess-A", "/Users/x/repo-a", 10);
    seedSession(db, "sess-B", "/Users/x/repo-b", 400);

    seedClaim(db, "/repo-a/src/file.ts", "sess-A", 30, 300, false);
    seedClaim(db, "/repo-a/src/other.ts", "sess-A", 60, 300, true); // released, should not appear

    seedTask(db, "t-pending", "repo-a", "write TUI", "pending");
    seedTask(db, "t-claimed", "repo-a", "polish docs", "claimed", 15);
    seedTask(db, "t-done", "repo-b", "ship release", "done", undefined, 5);

    const snap = loadSnapshot(db, { now: NOW });

    expect(snap.sessions).toHaveLength(2);
    expect(snap.sessions[0]?.session_id).toBe("sess-A"); // most recent last_seen first

    expect(snap.claims).toHaveLength(1);
    expect(snap.claims[0]?.file_path).toBe("/repo-a/src/file.ts");

    expect(snap.tasks.counts).toEqual({
      drafts: 0,
      pending: 1,
      claimed: 1,
      done: 1,
    });
    expect(snap.tasks.latest).toHaveLength(3);
    // most recent timestamp = t-done (completed 5s ago), then t-claimed (15s), then t-pending (-3600 created)
    expect(snap.tasks.latest.map((t) => t.external_id)).toEqual([
      "t-done",
      "t-claimed",
      "t-pending",
    ]);
    expect(snap.events).toEqual([]);
    db.close();
  });

  test("reads events when eventsPath provided", () => {
    const db = makeDb();
    const dir = mkdtempSync(join(tmpdir(), "batonq-snap-"));
    try {
      const p = join(dir, "events.jsonl");
      writeFileSync(
        p,
        [
          { ts: iso(-30), phase: "pre", tool: "Read", paths: ["/a"] },
          { ts: iso(-10), phase: "post", tool: "Read", paths: ["/a"] },
        ]
          .map((o) => JSON.stringify(o))
          .join("\n"),
      );
      const snap = loadSnapshot(db, { eventsPath: p, limit: 5, now: NOW });
      expect(snap.events).toHaveLength(2);
      expect(snap.events[0]?.tool).toBe("Read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });

  test("empty DB produces empty snapshot", () => {
    const db = makeDb();
    const snap = loadSnapshot(db, { now: NOW });
    expect(snap.sessions).toEqual([]);
    expect(snap.claims).toEqual([]);
    expect(snap.tasks.counts).toEqual({
      drafts: 0,
      pending: 0,
      claimed: 0,
      done: 0,
    });
    expect(snap.tasks.latest).toEqual([]);
    db.close();
  });
});

// ── add-task form ─────────────────────────────────────────────────────────────

describe("AddTaskForm", () => {
  let dir: string;
  let tasksPath: string;
  const SEED_PENDING =
    "# Tasks\n\n## Pending\n\n- [ ] **repo-a** — existing task\n\n## Done\n\n- [x] old task\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "batonq-form-"));
    tasksPath = join(dir, "TASKS.md");
    writeFileSync(tasksPath, SEED_PENDING);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("validates required Body — pressing Enter with empty body does not call onSubmit", async () => {
    let submitted: NewTask | null = null;
    let invalidReason: string | null = null as string | null;
    const { stdin, unmount } = render(
      React.createElement(AddTaskForm, {
        initialRepo: "any:infra",
        onSubmit: (t: NewTask) => {
          submitted = t;
        },
        onCancel: () => {},
        onInvalidSubmit: (r: string) => {
          invalidReason = r;
        },
      }),
    );
    // Press Enter on a fresh form (body is empty).
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    unmount();

    expect(submitted).toBeNull();
    expect(invalidReason).toBe("body-required");
    // And validator itself agrees:
    expect(validateNewTask({ repo: "any:infra", body: "" }).ok).toBe(false);
    // File on disk is untouched:
    expect(readFileSync(tasksPath, "utf8")).toBe(SEED_PENDING);
  });

  test("submit appends a task line to TASKS.md", () => {
    const before = readFileSync(tasksPath, "utf8");
    expect(before).toBe(SEED_PENDING);

    appendTaskToPending(tasksPath, {
      repo: "any:infra",
      body: "add TUI form",
      verify: "echo ok",
      judge: "did it work?",
    });

    const after = readFileSync(tasksPath, "utf8");
    // New task line is present
    expect(after).toContain("- [ ] **any:infra** — add TUI form");
    // verify and judge are indented and attached
    expect(after).toContain("  verify: echo ok");
    expect(after).toContain("  judge: did it work?");
    // Existing pending task is preserved
    expect(after).toContain("- [ ] **repo-a** — existing task");
    // Inserted above the ## Done heading
    const pendingIdx = after.indexOf("## Pending");
    const doneIdx = after.indexOf("## Done");
    const newTaskIdx = after.indexOf("add TUI form");
    expect(pendingIdx).toBeLessThan(newTaskIdx);
    expect(newTaskIdx).toBeLessThan(doneIdx);
  });

  test("Esc cancels without writing — onCancel fires, onSubmit does not, file untouched", async () => {
    const before = readFileSync(tasksPath, "utf8");
    let submitted: NewTask | null = null;
    let cancelled = false as boolean;
    const { stdin, unmount } = render(
      React.createElement(AddTaskForm, {
        initialRepo: "any:infra",
        onSubmit: (t: NewTask) => {
          submitted = t;
        },
        onCancel: () => {
          cancelled = true;
        },
      }),
    );
    // ESC = \x1B
    stdin.write("\x1B");
    await new Promise((r) => setTimeout(r, 20));
    unmount();

    expect(cancelled).toBe(true);
    expect(submitted).toBeNull();
    expect(readFileSync(tasksPath, "utf8")).toBe(before);
  });

  test("validateNewTask — body required, repo required", () => {
    expect(validateNewTask({ repo: "r", body: "" }).ok).toBe(false);
    expect(validateNewTask({ repo: "r", body: "   " }).reason).toBe(
      "body-required",
    );
    expect(validateNewTask({ repo: "", body: "b" }).reason).toBe(
      "repo-required",
    );
    expect(validateNewTask({ repo: "r", body: "b" }).ok).toBe(true);
  });

  test("appendTaskToPending — omits verify/judge when not supplied", () => {
    appendTaskToPending(tasksPath, { repo: "any:infra", body: "bare body" });
    const after = readFileSync(tasksPath, "utf8");
    expect(after).toContain("- [ ] **any:infra** — bare body");
    // None of the trailing rows should be a verify:/judge: for our task.
    const bareIdx = after.indexOf("bare body");
    const rest = after.slice(bareIdx);
    const nextTwoLines = rest.split("\n").slice(0, 3).join("\n");
    expect(nextTwoLines).not.toContain("verify:");
    expect(nextTwoLines).not.toContain("judge:");
  });

  test("appendTaskToPending — throws when ## Pending section is missing", () => {
    const bad = join(dir, "no-pending.md");
    writeFileSync(bad, "# Tasks\n\njust some text, no headings\n");
    expect(() => appendTaskToPending(bad, { repo: "r", body: "b" })).toThrow(
      /Pending/,
    );
  });

  test("appendTaskToPending — two sequential appends keep both tasks (no lost write)", () => {
    appendTaskToPending(tasksPath, { repo: "any:infra", body: "first" });
    appendTaskToPending(tasksPath, { repo: "any:infra", body: "second" });
    const after = readFileSync(tasksPath, "utf8");
    expect(after).toContain("- [ ] **any:infra** — first");
    expect(after).toContain("- [ ] **any:infra** — second");
    expect(after).toContain("- [ ] **repo-a** — existing task");
    // Lockfile cleaned up after writes.
    expect(existsSync(tasksPath + ".lock")).toBe(false);
  });

  test("appendTaskToPending — N concurrent processes race on the same file; all tasks survive", async () => {
    // Spawn N subprocesses that each call appendTaskToPending in parallel.
    // A pure read-modify-write (no flock / no rename) would lose writes here:
    // whichever process reads last and writes last clobbers earlier writes.
    // With the advisory lockfile + atomic rename, all N tasks must end up
    // in the final TASKS.md.
    const N = 5;
    const bodies = Array.from({ length: N }, (_, i) => `race-body-${i}`);
    const corePath = join(import.meta.dir, "..", "src", "tasks-core.ts");
    const helperPath = join(dir, "race-helper.ts");
    writeFileSync(
      helperPath,
      `import { appendTaskToPending } from ${JSON.stringify(corePath)};
const [tasksPath, body] = process.argv.slice(2);
appendTaskToPending(tasksPath, { repo: "any:infra", body });
`,
    );

    const procs = bodies.map((body) =>
      Bun.spawn(["bun", "run", helperPath, tasksPath, body], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    for (const code of codes) expect(code).toBe(0);

    const after = readFileSync(tasksPath, "utf8");
    for (const body of bodies) {
      expect(after).toContain(`- [ ] **any:infra** — ${body}`);
    }
    // Pre-existing seed task is also preserved.
    expect(after).toContain("- [ ] **repo-a** — existing task");
    // Lockfile cleaned up after all processes finished.
    expect(existsSync(tasksPath + ".lock")).toBe(false);
  });
});

// ── draft workflow: parseQuestions / overlay / hybrid view ────────────────────

describe("parseQuestions", () => {
  test("splits numbered questions, trims whitespace", () => {
    const qs = parseQuestions(
      "1. Which dir should the helper live in?\n2. Any return-type constraints?",
    );
    expect(qs).toHaveLength(2);
    expect(qs[0]?.n).toBe("1");
    expect(qs[0]?.text).toBe("Which dir should the helper live in?");
    expect(qs[1]?.n).toBe("2");
    expect(qs[1]?.text).toBe("Any return-type constraints?");
  });
  test("folds continuation lines into the previous question", () => {
    const qs = parseQuestions(
      "1. A long question\n   that wraps onto the next line?\n2. Short one?",
    );
    expect(qs).toHaveLength(2);
    expect(qs[0]?.text).toContain("wraps onto the next line");
    expect(qs[1]?.text).toBe("Short one?");
  });
  test("empty / null returns empty list", () => {
    expect(parseQuestions("")).toEqual([]);
    expect(parseQuestions(null)).toEqual([]);
    expect(parseQuestions(undefined)).toEqual([]);
  });
  test("supports '1) text' numbering too", () => {
    const qs = parseQuestions("1) first\n2) second");
    expect(qs.map((q) => q.text)).toEqual(["first", "second"]);
  });
});

describe("QuestionsOverlay", () => {
  // Test (a) from task spec: enrich med questions rendrer overlay.
  // We render QuestionsOverlay directly (the TUI opens it on `e` when the
  // selected draft already has enrich_questions stored) and assert the
  // overlay text surfaces the questions the user must answer inline.
  test("renders each question and the help footer", () => {
    const questions: ParsedQuestion[] = [
      { n: "1", text: "Which dir should the helper live in?" },
      { n: "2", text: "Any return-type constraints?" },
    ];
    const { lastFrame, unmount } = render(
      React.createElement(QuestionsOverlay, {
        eid: "deadbeef00ab",
        questions,
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Clarifying questions");
    expect(out).toContain("deadbeef");
    expect(out).toContain("1. Which dir should the helper live in?");
    expect(out).toContain("2. Any return-type constraints?");
    expect(out).toContain("Esc: cancel");
    unmount();
  });

  test("Enter with blank answer does NOT submit; Esc cancels", async () => {
    let submitted = false;
    let cancelled = false;
    const { stdin, unmount } = render(
      React.createElement(QuestionsOverlay, {
        eid: "abc123",
        questions: [{ n: "1", text: "A?" }],
        onSubmit: () => {
          submitted = true;
        },
        onCancel: () => {
          cancelled = true;
        },
      }),
    );
    stdin.write("\r"); // Enter on empty answer — must be rejected
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toBe(false);
    stdin.write("\x1B"); // Esc
    await new Promise((r) => setTimeout(r, 20));
    unmount();
    expect(cancelled).toBe(true);
  });
});

describe("TasksPanel draft display", () => {
  // Test (b) from task spec: enrich uten questions viser hybrid view.
  // A draft with original_body !== body means enrichment already rewrote the
  // body; the panel must surface both — enriched body as main content, a
  // collapsed "Original: …" metadata line (press `o` to expand).
  const mkDraft = (overrides: Partial<TaskRow> = {}): TaskRow => ({
    id: 1,
    external_id: "abcdef012345",
    repo: "any:infra",
    body: "Implement helper(s) returning number; add unit tests",
    status: "draft",
    claimed_by: null,
    claimed_at: null,
    completed_at: null,
    created_at: "2026-04-23T10:00:00.000Z",
    original_body: "add a helper",
    enrich_questions: null,
    ...overrides,
  });

  test("draft badge + collapsed 'Original: …' metadata shown for enriched drafts", () => {
    const draft = mkDraft();
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [draft],
        counts: { drafts: 1, pending: 0, claimed: 0, done: 0 },
        selected: 0,
        focused: true,
      }),
    );
    const out = lastFrame() ?? "";
    // Draft badge with accent marker
    expect(out).toContain("📝draft");
    // Enriched body is the main content
    expect(out).toContain("Implement helper");
    // Original is visible but truncated, and invites `o` to expand
    expect(out).toContain("Original: add a helper");
    expect(out).toContain("o: expand");
    unmount();
  });

  test("draft WITHOUT original_body shows only the draft body, no hybrid line", () => {
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [mkDraft({ original_body: null })],
        counts: { drafts: 1, pending: 0, claimed: 0, done: 0 },
        selected: 0,
        focused: true,
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("📝draft");
    expect(out).not.toContain("Original:");
    unmount();
  });

  test("expandedOriginals toggles 'o: expand' ↔ 'o: collapse' for that eid", () => {
    const draft = mkDraft();
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [draft],
        counts: { drafts: 1, pending: 0, claimed: 0, done: 0 },
        selected: 0,
        focused: true,
        expandedOriginals: new Set([draft.external_id]),
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("o: collapse");
    expect(out).not.toContain("o: expand");
    unmount();
  });

  test("title includes drafts count", () => {
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [mkDraft()],
        counts: { drafts: 3, pending: 2, claimed: 1, done: 0 },
        selected: 0,
        focused: true,
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("drafts 3");
    expect(out).toContain("pending 2");
    unmount();
  });
});

// ── §3: Tasks panel — verify/judge badges + priority grouping ─────────────────
//
// Spec: docs/tui-ux-v2.md §3. Done rows are decorated with a badge derived
// from verify_ran_at / judge_ran_at / verify_cmd columns, so the operator can
// see at a glance whether gates ran. Pending rows are grouped into [H]/[N]/[L]
// buckets so priority is visible in a dense list. Each badge case below maps
// back to the `doneBadge` classifier in tui-data.ts.

describe("TasksPanel §3 — done badges + pending priority grouping", () => {
  const mkDone = (ext: string, overrides: Partial<TaskRow> = {}): TaskRow => ({
    id: 1,
    external_id: ext,
    repo: "any:infra",
    body: `body ${ext}`,
    status: "done",
    claimed_by: null,
    claimed_at: null,
    completed_at: iso(-60),
    created_at: iso(-3600),
    ...overrides,
  });

  const mkPending = (
    ext: string,
    priority: "high" | "normal" | "low" | null = null,
  ): TaskRow => ({
    id: 1,
    external_id: ext,
    repo: "any:infra",
    body: `body ${ext}`,
    status: "pending",
    claimed_by: null,
    claimed_at: null,
    completed_at: null,
    created_at: iso(-60),
    priority,
  });

  test("done row shows ✓V ✓J when both gates ran", () => {
    const done = [
      mkDone("bothgate", {
        verify_cmd: "bun test",
        verify_ran_at: iso(-30),
        judge_cmd: "did it work?",
        judge_ran_at: iso(-25),
      }),
    ];
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [],
        counts: { drafts: 0, pending: 0, claimed: 0, done: 1 },
        selected: 0,
        focused: false,
        done,
        now: NOW,
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Recent done");
    expect(out).toContain("✓V ✓J");
    expect(out).toContain("bothgate");
    // Not a cheat and gates were configured — no editorial extras.
    expect(out).not.toContain("no gates");
    expect(out).not.toContain("DONE WITHOUT VERIFY");
    unmount();
  });

  test("done row shows ✓V — when only verify ran (judge absent)", () => {
    const done = [
      mkDone("verifonly", {
        verify_cmd: "bun test",
        verify_ran_at: iso(-20),
      }),
    ];
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [],
        counts: { drafts: 0, pending: 0, claimed: 0, done: 1 },
        selected: 0,
        focused: false,
        done,
        now: NOW,
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("✓V —");
    expect(out).toContain("verifonly");
    unmount();
  });

  test("done row shows ⊘ (no gates) when verify_cmd and both ran_at are null", () => {
    const done = [mkDone("nogates0")];
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [],
        counts: { drafts: 0, pending: 0, claimed: 0, done: 1 },
        selected: 0,
        focused: false,
        done,
        now: NOW,
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("⊘");
    expect(out).toContain("no gates");
    expect(out).toContain("nogates0");
    unmount();
  });

  test("done row shows ⚠ cheat badge when verify_cmd is set but verify_ran_at is null", () => {
    // verify_cmd present but verify_ran_at NULL = the task was marked done
    // without the gate ever running. That's the cheat signal spec-callout for
    // §3, and it must render with the DONE WITHOUT VERIFY annotation.
    const done = [
      mkDone("cheat001", {
        verify_cmd: "bun test tests/core.test.ts",
        verify_ran_at: null,
        judge_cmd: "did it ship?",
        judge_ran_at: null,
      }),
    ];
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [],
        counts: { drafts: 0, pending: 0, claimed: 0, done: 1 },
        selected: 0,
        focused: false,
        done,
        now: NOW,
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("⚠");
    expect(out).toContain("DONE WITHOUT VERIFY");
    expect(out).toContain("cheat001");
    unmount();
  });

  test("pending section groups by [H] then [N] then [L], preserving input order within each bucket", () => {
    // Interleaved input: if grouping is unstable or sorts within a bucket,
    // this ordering check will fail.
    const pending = [
      mkPending("lowaaaa1", "low"),
      mkPending("highaaa1", "high"),
      mkPending("normaaa1", null), // default → N
      mkPending("highaaa2", "high"),
      mkPending("normaaa2", "normal"),
      mkPending("lowaaaa2", "low"),
    ];
    const { lastFrame, unmount } = render(
      React.createElement(TasksPanel, {
        latest: [],
        counts: {
          drafts: 0,
          pending: pending.length,
          claimed: 0,
          done: 0,
        },
        selected: 0,
        focused: false,
        pending,
        now: NOW,
      }),
    );
    const out = lastFrame() ?? "";
    // All three priority markers rendered.
    expect(out).toContain("[H]");
    expect(out).toContain("[N]");
    expect(out).toContain("[L]");
    // Order assertions: H rows appear before N rows, N before L,
    // and within a bucket the original relative order is preserved.
    const idx = (s: string) => out.indexOf(s);
    expect(idx("highaaa1")).toBeGreaterThanOrEqual(0);
    expect(idx("highaaa1")).toBeLessThan(idx("highaaa2"));
    expect(idx("highaaa2")).toBeLessThan(idx("normaaa1"));
    expect(idx("normaaa1")).toBeLessThan(idx("normaaa2"));
    expect(idx("normaaa2")).toBeLessThan(idx("lowaaaa1"));
    expect(idx("lowaaaa1")).toBeLessThan(idx("lowaaaa2"));
    unmount();
  });
});

// ── test (c): promote flips DB + TASKS.md ─────────────────────────────────────
//
// The TUI's `p` keybind shells out to `batonq promote <id>` via runPromote.
// Rather than mock spawnSync, we drive the actual core function — the same
// one the CLI invokes — and assert the DB + file transition that the TUI
// will then see on its next 2s snapshot. This matches the contract the TUI
// depends on: "pressing p flips status from draft to pending everywhere".

import {
  promoteDraftToPending,
  externalId as coreEid,
  initTaskSchema,
} from "../src/tasks-core";

describe("promote (TUI keybind `p` backing behavior)", () => {
  test("promoteDraftToPending flips DB + MD for the selected draft", () => {
    const dir = mkdtempSync(join(tmpdir(), "batonq-promote-"));
    try {
      const tasksPath = join(dir, "TASKS.md");
      writeFileSync(
        tasksPath,
        "# Tasks\n\n## Pending\n\n- [?] **any:infra** — enriched spec body\n  verify: echo ok\n  judge: PASS/FAIL\n\n## Done\n",
      );
      const db = new Database(":memory:");
      initTaskSchema(db);
      const eid = coreEid("any:infra", "enriched spec body");
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, original_body) VALUES (?, ?, ?, 'draft', ?, ?)`,
        [
          eid,
          "any:infra",
          "enriched spec body",
          "2026-04-23T10:00:00.000Z",
          "terse",
        ],
      );

      expect(promoteDraftToPending(db, tasksPath, eid)).toBe(true);

      const row = db
        .query("SELECT status FROM tasks WHERE external_id = ?")
        .get(eid) as any;
      expect(row.status).toBe("pending");
      const md = readFileSync(tasksPath, "utf8");
      expect(md).toContain("- [ ] **any:infra** — enriched spec body");
      expect(md).not.toContain("- [?] **any:infra** — enriched spec body");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── loop-status footer ────────────────────────────────────────────────────────

describe("loop-status helpers", () => {
  test("parsePgrepPids keeps numeric lines only", () => {
    expect(parsePgrepPids("1234\n5678\n\n  ")).toEqual([1234, 5678]);
    expect(parsePgrepPids("")).toEqual([]);
    expect(parsePgrepPids("nope\n")).toEqual([]);
  });
  test("parsePsEtimes handles padded output", () => {
    expect(parsePsEtimes("   3621\n")).toBe(3621);
    expect(parsePsEtimes("")).toBeNull();
  });
  test("loopStateGlyph covers all states", () => {
    expect(loopStateGlyph("running")).toContain("running");
    expect(loopStateGlyph("idle")).toContain("idle");
    expect(loopStateGlyph("dead")).toContain("dead");
  });
  test("taskBodyPreview truncates to 50 chars with ellipsis", () => {
    const long = "a".repeat(80);
    const out = taskBodyPreview(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });
  test("formatEventsAge handles null/seconds/minutes/hours", () => {
    expect(formatEventsAge(null)).toContain("no events");
    expect(formatEventsAge(30)).toBe("30s ago");
    expect(formatEventsAge(125)).toBe("2m ago");
    expect(formatEventsAge(3600 * 3)).toBe("3h ago");
  });
  test("eventsAgeSec reads file mtime in seconds", () => {
    const dir = mkdtempSync(join(tmpdir(), "batonq-events-"));
    try {
      const p = join(dir, "events.jsonl");
      writeFileSync(p, "{}\n");
      const now = Date.now() + 5000;
      const age = eventsAgeSec(p, now);
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(4);
      // Missing file → null
      expect(eventsAgeSec(join(dir, "nope.jsonl"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LoopStatusFooter rendering", () => {
  const palette = { dim: "grayD", warn: "warnY", err: "errR", ok: "okG" };
  const base: LoopStatus = {
    state: "running",
    loopPid: 999,
    currentTask: {
      externalId: "abcdef1234567890",
      body: "TUI live loop-status footer with everything wired up",
    },
    claude: { pid: 5555, uptimeSec: 42 },
    eventsAgeSec: 3,
  };

  test("renders all four fields: state, task, claude pid+uptime, events age", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LoopStatusFooter, { status: base }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Loop");
    expect(out).toContain("running");
    expect(out).toContain("pid 999");
    expect(out).toContain("abcdef12"); // short external_id
    expect(out).toContain("TUI live loop-status"); // first chars of body
    expect(out).toContain("pid 5555 running 42s");
    expect(out).toContain("3s ago");
    expect(out).toContain("L");
    unmount();
  });

  test("idle state shown when loop pid present but no claude-p", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LoopStatusFooter, {
        status: { ...base, state: "idle", claude: null },
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("idle");
    expect(out).toContain("no claude -p");
    unmount();
  });

  test("dead loop detected when loopPid is null", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LoopStatusFooter, {
        status: {
          state: "dead",
          loopPid: null,
          currentTask: null,
          claude: null,
          eventsAgeSec: null,
        },
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("dead");
    expect(out).toContain("— (idle)");
    expect(out).toContain("no claude -p");
    expect(out).toContain("no events.jsonl");
    unmount();
  });

  test("burn line renders when burn prop has bucketStart, omitted otherwise", () => {
    // Without burn → row absent
    const noBurn = render(
      React.createElement(LoopStatusFooter, { status: base }),
    );
    expect(noBurn.lastFrame() ?? "").not.toContain("burn:");
    noBurn.unmount();

    // With burn → row appears with formatted duration + tokens
    const burn = {
      bucketStart: 1_000_000_000,
      bucketAgeMs: 90 * 60_000, // 1h 30m
      bucketRemainingMs: 3 * 60 * 60_000 + 30 * 60_000, // 3h 30m
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 12_345_000,
      totalTokens: 12_345_000,
      turns: 50,
      burnRatePerMin: 137_000,
      syntheticStops: 0,
    };
    const withBurn = render(
      React.createElement(LoopStatusFooter, { status: base, burn }),
    );
    const out = withBurn.lastFrame() ?? "";
    expect(out).toContain("burn:");
    expect(out).toContain("1h 30m / 5h");
    expect(out).toContain("12.35M"); // fmtTokens uses .toFixed(2) for M
    expect(out).toContain("3h 30m");
    withBurn.unmount();
  });

  test("null burn or null bucketStart skips the row", () => {
    const nullBurn = render(
      React.createElement(LoopStatusFooter, { status: base, burn: null }),
    );
    expect(nullBurn.lastFrame() ?? "").not.toContain("burn:");
    nullBurn.unmount();

    const emptyBurn = render(
      React.createElement(LoopStatusFooter, {
        status: base,
        burn: {
          bucketStart: null,
          bucketAgeMs: 0,
          bucketRemainingMs: 5 * 60 * 60_000,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          turns: 0,
          burnRatePerMin: 0,
          syntheticStops: 0,
        },
      }),
    );
    expect(emptyBurn.lastFrame() ?? "").not.toContain("burn:");
    emptyBurn.unmount();
  });
});

describe("eventsAgeColor threshold", () => {
  const palette = { dim: "D", warn: "W", err: "E", ok: "O" };
  test("<=300s → ok", () => {
    expect(eventsAgeColor(0, palette)).toBe("O");
    expect(eventsAgeColor(EVENTS_WARN_SEC, palette)).toBe("O");
  });
  test(">300s and <=600s → warn", () => {
    expect(eventsAgeColor(EVENTS_WARN_SEC + 1, palette)).toBe("W");
    expect(eventsAgeColor(EVENTS_CRIT_SEC, palette)).toBe("W");
  });
  test(">600s → err", () => {
    expect(eventsAgeColor(EVENTS_CRIT_SEC + 1, palette)).toBe("E");
    expect(eventsAgeColor(99999, palette)).toBe("E");
  });
  test("null → dim", () => {
    expect(eventsAgeColor(null, palette)).toBe("D");
  });
});

describe("findLoopCurrentTask", () => {
  function makeTasksDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE NOT NULL,
        repo TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    return db;
  }
  test("matches claims whose claimed_by ends in _<loopPid>", () => {
    const db = makeTasksDb();
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, claimed_by, claimed_at, created_at)
       VALUES (?, ?, ?, 'claimed', ?, ?, ?)`,
      [
        "t1",
        "any:infra",
        "build footer",
        "term_ttys001_80282",
        "2026-04-23T12:00:00.000Z",
        "2026-04-23T11:00:00.000Z",
      ],
    );
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, claimed_by, claimed_at, created_at)
       VALUES (?, ?, ?, 'claimed', ?, ?, ?)`,
      [
        "t2",
        "any:infra",
        "other session task",
        "pid_11111",
        "2026-04-23T12:05:00.000Z",
        "2026-04-23T11:00:00.000Z",
      ],
    );
    const hit = findLoopCurrentTask(db, 80282);
    expect(hit?.externalId).toBe("t1");
    expect(hit?.body).toContain("build footer");
    db.close();
  });
  test("returns null when nothing claimed", () => {
    const db = makeTasksDb();
    expect(findLoopCurrentTask(db, 42)).toBeNull();
    db.close();
  });
});

// ── alert lane (§1 of docs/tui-ux-v2.md) ──────────────────────────────────────

import {
  computeAlerts,
  looksLikeJudgeFail,
  looksLikeVerifyFail,
  watchdogKillAgeMinutes,
  STALE_CLAIM_SEC,
  EMPTY_QUEUE_SEC,
  type Alert,
} from "../src/alerts";
import { AlertLane, alertSeverityColor } from "../src/alert-lane";

function makeAlertsDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
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
      last_progress_at TEXT
    );
  `);
  return db;
}

function seedDone(
  db: Database,
  ext: string,
  cols: {
    completedAgo?: number;
    verify_cmd?: string | null;
    verify_output?: string | null;
    verify_ran_at?: string | null;
    judge_cmd?: string | null;
    judge_output?: string | null;
    judge_ran_at?: string | null;
  } = {},
): void {
  db.run(
    `INSERT INTO tasks
     (external_id, repo, body, status, completed_at, created_at,
      verify_cmd, verify_output, verify_ran_at,
      judge_cmd, judge_output, judge_ran_at)
     VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ext,
      "any:infra",
      "body " + ext,
      iso(-(cols.completedAgo ?? 60)),
      iso(-3600),
      cols.verify_cmd ?? null,
      cols.verify_output ?? null,
      cols.verify_ran_at ?? null,
      cols.judge_cmd ?? null,
      cols.judge_output ?? null,
      cols.judge_ran_at ?? null,
    ],
  );
}

describe("alerts — pure classifiers", () => {
  test("looksLikeVerifyFail detects FAIL token and non-zero exit codes", () => {
    expect(looksLikeVerifyFail("assertion FAIL in test 3")).toBe(true);
    expect(looksLikeVerifyFail("FAIL: expected 1")).toBe(true);
    expect(looksLikeVerifyFail("command exited with exit 2")).toBe(true);
    // PASS and empty are fine.
    expect(looksLikeVerifyFail("PASS 42 tests")).toBe(false);
    expect(looksLikeVerifyFail("")).toBe(false);
    // Exit 0 is explicitly NOT a failure.
    expect(looksLikeVerifyFail("process exit 0")).toBe(false);
    // FAILSAFE must not match — we only match bare FAIL tokens.
    expect(looksLikeVerifyFail("watchdog FAILSAFE armed")).toBe(false);
  });

  test("looksLikeJudgeFail only matches when first token is FAIL", () => {
    expect(looksLikeJudgeFail("FAIL: missing commits")).toBe(true);
    expect(looksLikeJudgeFail("\n  FAIL reason here\n")).toBe(true);
    expect(looksLikeJudgeFail("PASS verified")).toBe(false);
    // "FAIL" later in the line doesn't count — verdict must come first.
    expect(looksLikeJudgeFail("verdict: FAIL because reasons")).toBe(false);
    expect(looksLikeJudgeFail("")).toBe(false);
  });
});

describe("computeAlerts", () => {
  test("cheat detection fires when done task has verify_cmd but no gates ran", () => {
    const db = makeAlertsDb();
    // Task that had verify_cmd declared, got marked done, but neither
    // verify_ran_at nor judge_ran_at was ever set. Classic self-close cheat.
    seedDone(db, "cheat001", {
      completedAgo: 60,
      verify_cmd: "bun test tests/core.test.ts",
      verify_ran_at: null,
      judge_cmd: "did it work?",
      judge_ran_at: null,
    });

    const alerts = computeAlerts(db, { now: NOW });
    const cheat = alerts.find((a) => a.kind === "cheat-done");
    expect(cheat).toBeDefined();
    expect(cheat!.severity).toBe("red");
    expect(cheat!.text).toContain("cheat001");
    expect(cheat!.text).toContain("without gates");
    expect(cheat!.externalId).toBe("cheat001");

    // A task with verify_cmd but verify_ran_at set does NOT trigger cheat.
    const db2 = makeAlertsDb();
    seedDone(db2, "clean001", {
      verify_cmd: "bun test",
      verify_ran_at: iso(-30),
      judge_ran_at: iso(-25),
    });
    const clean = computeAlerts(db2, { now: NOW });
    expect(clean.find((a) => a.kind === "cheat-done")).toBeUndefined();

    db.close();
    db2.close();
  });

  test("alert lane collapses to 0 lines when there are no alerts", () => {
    const db = makeAlertsDb();
    // Healthy state: one cleanly-gated done task, one young pending task, no
    // claimed rows. Nothing should fire.
    seedDone(db, "good0001", {
      completedAgo: 30,
      verify_cmd: "bun test",
      verify_output: "PASS 10 tests",
      verify_ran_at: iso(-30),
      judge_cmd: "did it work?",
      judge_output: "PASS",
      judge_ran_at: iso(-25),
    });
    db.run(
      `INSERT INTO tasks (external_id, repo, body, status, created_at)
       VALUES ('pend0001', 'any:infra', 'ready to pick', 'pending', ?)`,
      [iso(-60)],
    );

    const alerts = computeAlerts(db, { now: NOW, loopLogPath: null });
    expect(alerts).toHaveLength(0);

    // The component must render nothing — ink's lastFrame returns an empty
    // string when a component tree yields no output.
    const { lastFrame, unmount } = render(
      React.createElement(AlertLane, { alerts: [] }),
    );
    expect((lastFrame() ?? "").trim()).toBe("");
    unmount();
    db.close();
  });

  test("severity → color threshold switches across red, yellow, gray", () => {
    // Direct palette mapping: red for cheat/failed, yellow for stale/watchdog,
    // gray for empty-queue. alertSeverityColor is what AlertLane calls.
    expect(alertSeverityColor("red")).not.toBe(alertSeverityColor("yellow"));
    expect(alertSeverityColor("yellow")).not.toBe(alertSeverityColor("gray"));
    expect(alertSeverityColor("red")).not.toBe(alertSeverityColor("gray"));

    // And the end-to-end switch: three scenarios, three different severities.
    // Red — cheat done.
    const dbRed = makeAlertsDb();
    seedDone(dbRed, "red00001", {
      verify_cmd: "bun test",
      verify_ran_at: null,
      judge_ran_at: null,
    });
    const red = computeAlerts(dbRed, { now: NOW });
    expect(red[0]?.severity).toBe("red");
    dbRed.close();

    // Yellow — stale claim (>30m claim + >10m since progress).
    const dbYellow = makeAlertsDb();
    dbYellow.run(
      `INSERT INTO tasks
       (external_id, repo, body, status, claimed_at, last_progress_at, created_at)
       VALUES ('stale001', 'any:infra', 'stuck forever', 'claimed', ?, ?, ?)`,
      [iso(-(STALE_CLAIM_SEC + 60)), iso(-(STALE_CLAIM_SEC + 60)), iso(-3600)],
    );
    const yellow = computeAlerts(dbYellow, { now: NOW });
    expect(yellow[0]?.kind).toBe("stale-claim");
    expect(yellow[0]?.severity).toBe("yellow");
    dbYellow.close();

    // Gray — empty queue (pending=0, nothing has happened for >15 min).
    const dbGray = makeAlertsDb();
    dbGray.run(
      `INSERT INTO tasks (external_id, repo, body, status, completed_at, created_at)
       VALUES ('old00001', 'any:infra', 'shipped long ago', 'done', ?, ?)`,
      [iso(-(EMPTY_QUEUE_SEC + 120)), iso(-(EMPTY_QUEUE_SEC + 600))],
    );
    const gray = computeAlerts(dbGray, { now: NOW });
    expect(gray[0]?.kind).toBe("empty-queue");
    expect(gray[0]?.severity).toBe("gray");
    dbGray.close();
  });

  test("maxAlerts caps the lane at 2 rows, highest severity first", () => {
    const db = makeAlertsDb();
    // Fire three distinct alerts at once: verify-failed, cheat, stale-claim.
    seedDone(db, "failverify", {
      completedAgo: 5,
      verify_cmd: "bun test",
      verify_output: "FAIL: 2 assertions failed",
      verify_ran_at: iso(-10),
    });
    // Different cheat task so the cheat query picks a separate row.
    seedDone(db, "cheatalso", {
      completedAgo: 120,
      verify_cmd: "bun test",
      verify_ran_at: null,
      judge_ran_at: null,
    });
    db.run(
      `INSERT INTO tasks
       (external_id, repo, body, status, claimed_at, last_progress_at, created_at)
       VALUES ('stale002', 'any:infra', 'stuck', 'claimed', ?, ?, ?)`,
      [iso(-(STALE_CLAIM_SEC + 60)), iso(-(STALE_CLAIM_SEC + 60)), iso(-3600)],
    );

    const alerts = computeAlerts(db, { now: NOW });
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.kind).toBe("verify-failed"); // highest priority
    expect(alerts[1]?.kind).toBe("cheat-done"); // next
    db.close();
  });

  test("watchdog-kill alert fires when loop-log has '[watchdog] … killing'", () => {
    const dir = mkdtempSync(join(tmpdir(), "batonq-alerts-"));
    try {
      const logPath = join(dir, "loop.log");
      writeFileSync(
        logPath,
        "some loop output\n" +
          "[watchdog] events.jsonl stale 612s (>600s) — killing claude tree\n" +
          "post-kill trailing line\n",
      );
      const mins = watchdogKillAgeMinutes(logPath, Date.now());
      expect(mins).not.toBeNull();
      expect(mins!).toBeGreaterThanOrEqual(0);

      const db = makeAlertsDb();
      // Seed one pending task so empty-queue alert doesn't also fire.
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at)
         VALUES ('pend0002', 'any:infra', 'queued', 'pending', ?)`,
        [iso(-60)],
      );
      const alerts = computeAlerts(db, {
        now: Date.now(),
        loopLogPath: logPath,
      });
      const wd = alerts.find((a) => a.kind === "watchdog-kill");
      expect(wd).toBeDefined();
      expect(wd!.severity).toBe("yellow");
      expect(wd!.text).toContain("watchdog");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("watchdogKillAgeMinutes returns null when log is missing or clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "batonq-alerts-"));
    try {
      expect(watchdogKillAgeMinutes(join(dir, "no.log"))).toBeNull();
      const clean = join(dir, "clean.log");
      writeFileSync(clean, "loop started\nloop idle\nloop idle\n");
      expect(watchdogKillAgeMinutes(clean)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TUI L-keybind opens restart confirm overlay", () => {
  test("pressing L shows the restart-loop confirm prompt", async () => {
    const { stdin, lastFrame, unmount } = render(React.createElement(App));
    // Let the initial tick settle so App renders snapshot + footer.
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("L");
    await new Promise((r) => setTimeout(r, 50));
    const out = lastFrame() ?? "";
    expect(out).toContain("restart batonq-loop");
    expect(out).toContain("(y/n)");
    // Esc should dismiss without actually restarting anything.
    stdin.write("\x1B");
    await new Promise((r) => setTimeout(r, 20));
    const cleared = lastFrame() ?? "";
    expect(cleared).not.toContain("restart batonq-loop");
    unmount();
  });
});

// ── §5: Drill-down overlay ───────────────────────────────────────────────────
//
// Spec: docs/tui-ux-v2.md §5. Enter on a task row opens a full-screen modal
// with the full body, verify_cmd + tailed output, judge_cmd + headed verdict,
// and commits since claim. Esc closes; `a`/`r`/`e` mirror the main-panel
// keybinds so the operator can act on what they see without backing out.

import {
  buildDrillDownView,
  clampOffset,
  DrillDownOverlay,
  type DrillDownView,
} from "../src/drill-down";

describe("DrillDownOverlay (§5)", () => {
  const baseView: DrillDownView = {
    externalId: "63da83f9ef7c",
    status: "done",
    badge: "✓V ✓J",
    body: "Implement TUI §5 (Drill-down overlay) — Enter opens full-screen modal with verify+judge+commits",
    verifyCmd: "bun test tests/tui.test.ts",
    verifyTail: [
      "PASS tests/tui.test.ts",
      "  ✓ renders drill-down overlay",
      "  ✓ Esc closes overlay",
      "",
      "3 pass, 0 fail",
    ],
    judgeCmd: "did the overlay render correctly?",
    judgeHead: [
      "PASS",
      "overlay shows body, verify, judge, commits",
      "all keybinds wired",
    ],
    commits: [
      { sha: "a1b2c3d", subject: "feat(tui): drill-down overlay §5" },
      { sha: "d4e5f6a", subject: "test(tui): drill-down overlay tests" },
    ],
  };

  test("renders full body, verify cmd + tail, judge cmd + head, commits, and footer keybinds", () => {
    const { lastFrame, unmount } = render(
      React.createElement(DrillDownOverlay, {
        view: baseView,
        onClose: () => {},
        onAbandon: () => {},
        onRelease: () => {},
        onEnrich: () => {},
      }),
    );
    const out = lastFrame() ?? "";
    // Header: full external id, status, badge.
    expect(out).toContain("Task 63da83f9ef7c");
    expect(out).toContain("[done]");
    expect(out).toContain("✓V ✓J");
    // Full body — not truncated to 60/80 chars like the Tasks panel.
    expect(out).toContain("Implement TUI §5");
    expect(out).toContain("verify+judge+commits");
    // Verify cmd + a few tail lines (the helper clips to 30 lines; here we
    // asserted presence of the assertion + summary).
    expect(out).toContain("Verify cmd:");
    expect(out).toContain("bun test tests/tui.test.ts");
    expect(out).toContain("Verify output (last 30 lines):");
    expect(out).toContain("PASS tests/tui.test.ts");
    expect(out).toContain("3 pass, 0 fail");
    // Judge cmd + head.
    expect(out).toContain("Judge cmd:");
    expect(out).toContain("did the overlay render correctly?");
    expect(out).toContain("Judge verdict:");
    expect(out).toContain("PASS");
    expect(out).toContain("all keybinds wired");
    // Commits — count in header, rows show sha + subject.
    expect(out).toContain("Commits since claim (2):");
    expect(out).toContain("a1b2c3d");
    expect(out).toContain("drill-down overlay §5");
    expect(out).toContain("d4e5f6a");
    // Footer keybinds.
    expect(out).toContain("Esc");
    expect(out).toContain("close");
    expect(out).toContain("abandon");
    expect(out).toContain("release-claim");
    expect(out).toContain("enrich");
    unmount();
  });

  test("Esc triggers onClose without firing any action callback", async () => {
    let closed = false;
    let abandoned = false;
    let released = false;
    let enriched = false;
    const { stdin, unmount } = render(
      React.createElement(DrillDownOverlay, {
        view: baseView,
        onClose: () => {
          closed = true;
        },
        onAbandon: () => {
          abandoned = true;
        },
        onRelease: () => {
          released = true;
        },
        onEnrich: () => {
          enriched = true;
        },
      }),
    );
    stdin.write("\x1B"); // ESC
    await new Promise((r) => setTimeout(r, 20));
    unmount();

    expect(closed).toBe(true);
    expect(abandoned).toBe(false);
    expect(released).toBe(false);
    expect(enriched).toBe(false);
  });

  test("a/r/e keybinds route to their respective callbacks inside the overlay", async () => {
    const fired: string[] = [];
    const make = (label: string) => () => {
      fired.push(label);
    };
    const { stdin, unmount } = render(
      React.createElement(DrillDownOverlay, {
        view: baseView,
        onClose: make("close"),
        onAbandon: make("abandon"),
        onRelease: make("release"),
        onEnrich: make("enrich"),
      }),
    );
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("r");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 10));
    unmount();

    expect(fired).toEqual(["abandon", "release", "enrich"]);
  });

  test("empty outputs show '(none)' placeholders instead of blank gaps", () => {
    const { lastFrame, unmount } = render(
      React.createElement(DrillDownOverlay, {
        view: {
          ...baseView,
          verifyCmd: null,
          verifyTail: [],
          judgeCmd: null,
          judgeHead: [],
          commits: [],
        },
        onClose: () => {},
        onAbandon: () => {},
        onRelease: () => {},
        onEnrich: () => {},
      }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("— none —"); // verify + judge cmd placeholder
    // Three sections with (none): verify output, judge verdict, commits.
    const noneCount = (out.match(/\(none\)/g) ?? []).length;
    expect(noneCount).toBeGreaterThanOrEqual(3);
    expect(out).toContain("Commits since claim (0):");
    unmount();
  });
});

describe("buildDrillDownView (pure)", () => {
  const task: TaskRow = {
    id: 42,
    external_id: "abcdef0123",
    repo: "any:infra",
    body: "body text",
    status: "done",
    claimed_by: null,
    claimed_at: null,
    completed_at: null,
    created_at: "2026-04-23T10:00:00.000Z",
    verify_cmd: "bun test",
    // 35 lines — tailLines must clip to 30.
    verify_output: Array.from({ length: 35 }, (_, i) => `v-line-${i}`).join(
      "\n",
    ),
    verify_ran_at: "2026-04-23T10:30:00.000Z",
    judge_cmd: "ok?",
    // 20 lines — headLines must clip to 15.
    judge_output: Array.from({ length: 20 }, (_, i) => `j-line-${i}`).join(
      "\n",
    ),
    judge_ran_at: "2026-04-23T10:31:00.000Z",
  };

  test("tail clips verify to 30 lines (keeps the end) and head clips judge to 15 (keeps the start)", () => {
    const view = buildDrillDownView(task, null);
    expect(view.verifyTail.length).toBe(30);
    // First surviving verify line is v-line-5 (35 − 30 = 5).
    expect(view.verifyTail[0]).toBe("v-line-5");
    expect(view.verifyTail[view.verifyTail.length - 1]).toBe("v-line-34");

    expect(view.judgeHead.length).toBe(15);
    expect(view.judgeHead[0]).toBe("j-line-0");
    expect(view.judgeHead[view.judgeHead.length - 1]).toBe("j-line-14");
  });

  test("done status surfaces the doneBadge in the view header", () => {
    const view = buildDrillDownView(task, null);
    // Task has verify_ran_at + judge_ran_at → ✓V ✓J badge.
    expect(view.badge).toBe("✓V ✓J");
  });

  test("non-done status has no badge (badge is null)", () => {
    const view = buildDrillDownView({ ...task, status: "claimed" }, null);
    expect(view.badge).toBeNull();
  });

  test("null repoCwd yields empty commit list (no git spawn)", () => {
    const view = buildDrillDownView(task, null);
    expect(view.commits).toEqual([]);
  });
});

describe("DrillDownOverlay — scroll + input isolation", () => {
  const longTail = Array.from({ length: 30 }, (_, i) => `v-line-${i}`);
  const makeView = (): DrillDownView => ({
    externalId: "eeeeeeee",
    status: "done",
    badge: "✓V ✓J",
    body: "body",
    verifyCmd: "bun test",
    verifyTail: longTail,
    judgeCmd: "ok?",
    judgeHead: ["PASS", "reason"],
    commits: [],
  });

  test("long verify output is clipped to viewport with '↓ N more' marker", () => {
    const { lastFrame, unmount } = render(
      React.createElement(DrillDownOverlay, {
        view: makeView(),
        viewportLines: 5,
        onClose: () => {},
        onAbandon: () => {},
        onRelease: () => {},
        onEnrich: () => {},
      }),
    );
    const out = lastFrame() ?? "";
    // At offset 0, first 5 lines shown, "↓ 25 more" below them.
    expect(out).toContain("v-line-0");
    expect(out).toContain("v-line-4");
    expect(out).not.toContain("v-line-5");
    expect(out).toContain("↓ 25 more");
    // No "↑ earlier" marker at offset 0.
    expect(out).not.toContain("earlier");
    unmount();
  });

  test("j scrolls verify output forward, showing '↑ N earlier' + '↓ N more'", async () => {
    const { stdin, lastFrame, unmount } = render(
      React.createElement(DrillDownOverlay, {
        view: makeView(),
        viewportLines: 5,
        onClose: () => {},
        onAbandon: () => {},
        onRelease: () => {},
        onEnrich: () => {},
      }),
    );
    // Press j three times to advance the offset by 3.
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 10));
    const out = lastFrame() ?? "";
    expect(out).toContain("↑ 3 earlier");
    expect(out).toContain("v-line-3");
    expect(out).toContain("v-line-7");
    expect(out).toContain("↓ 22 more");
    unmount();
  });

  test("unhandled keys are swallowed — no callback fires for Tab or random chars", async () => {
    const fired: string[] = [];
    const { stdin, unmount } = render(
      React.createElement(DrillDownOverlay, {
        view: makeView(),
        onClose: () => fired.push("close"),
        onAbandon: () => fired.push("abandon"),
        onRelease: () => fired.push("release"),
        onEnrich: () => fired.push("enrich"),
      }),
    );
    // Tab, n, p, L, q — none of these should fire a drill-down callback.
    stdin.write("\t");
    stdin.write("n");
    stdin.write("p");
    stdin.write("L");
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 20));
    unmount();
    expect(fired).toEqual([]);
  });
});

describe("clampOffset", () => {
  test("negative offsets clamp to 0", () => {
    expect(clampOffset(-5, 20, 10)).toBe(0);
  });
  test("offset past max clamps to (total - viewport)", () => {
    expect(clampOffset(100, 20, 10)).toBe(10);
    expect(clampOffset(100, 5, 10)).toBe(0); // total < viewport → no scroll
  });
  test("in-range offset is preserved", () => {
    expect(clampOffset(3, 20, 10)).toBe(3);
  });
});

describe("findTaskByEid (drill-down refresh mechanism)", () => {
  // Guarantees the drill-down overlay picks up live DB updates: the TUI
  // stores only the external_id, and this function re-resolves the row
  // across drafts/pending/claimed/done on every tick.
  const mkSnap = (tasks: Partial<TaskRow>[]): Snapshot =>
    ({
      now: iso(0),
      sessions: [],
      claims: [],
      events: [],
      tasks: {
        drafts: tasks.filter((t) => t.status === "draft") as TaskRow[],
        pending: tasks.filter((t) => t.status === "pending") as TaskRow[],
        claimed: tasks.filter((t) => t.status === "claimed") as TaskRow[],
        done: tasks.filter((t) => t.status === "done") as TaskRow[],
        latest: [],
        counts: { drafts: 0, pending: 0, claimed: 0, done: 0 },
      },
    }) as Snapshot;

  const baseTask = (overrides: Partial<TaskRow>): TaskRow => ({
    id: 1,
    external_id: "abc",
    repo: "any:infra",
    body: "",
    status: "pending",
    claimed_by: null,
    claimed_at: null,
    completed_at: null,
    created_at: iso(0),
    ...overrides,
  });

  test("returns the current row after a status transition", () => {
    const snapT0 = mkSnap([
      baseTask({ external_id: "xyz", status: "claimed", body: "working…" }),
    ]);
    const snapT1 = mkSnap([
      baseTask({
        external_id: "xyz",
        status: "done",
        body: "working…",
        verify_cmd: "bun test",
        verify_output: "PASS",
        verify_ran_at: iso(10),
      }),
    ]);
    expect(findTaskByEid(snapT0, "xyz")?.status).toBe("claimed");
    expect(findTaskByEid(snapT1, "xyz")?.status).toBe("done");
    // And the fresh snap surfaces the newly-captured verify_output.
    expect(findTaskByEid(snapT1, "xyz")?.verify_output).toBe("PASS");
  });

  test("returns null when the eid is gone from the snapshot", () => {
    const snap = mkSnap([baseTask({ external_id: "still-here" })]);
    expect(findTaskByEid(snap, "vanished")).toBeNull();
  });

  test("finds rows across all four buckets", () => {
    const snap = mkSnap([
      baseTask({ external_id: "d1", status: "draft" }),
      baseTask({ external_id: "p1", status: "pending" }),
      baseTask({ external_id: "c1", status: "claimed" }),
      baseTask({ external_id: "x1", status: "done" }),
    ]);
    expect(findTaskByEid(snap, "d1")?.status).toBe("draft");
    expect(findTaskByEid(snap, "p1")?.status).toBe("pending");
    expect(findTaskByEid(snap, "c1")?.status).toBe("claimed");
    expect(findTaskByEid(snap, "x1")?.status).toBe("done");
  });
});
