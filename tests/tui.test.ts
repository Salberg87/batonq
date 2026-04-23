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
