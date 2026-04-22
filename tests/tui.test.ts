// tui.test — mock-data tests for TUI data pipeline.
// Pure helpers from tui-data.ts exercised against an in-memory SQLite DB
// and synthetic events, so no touching of ~/.claude state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

    expect(snap.tasks.counts).toEqual({ pending: 1, claimed: 1, done: 1 });
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
    expect(snap.tasks.counts).toEqual({ pending: 0, claimed: 0, done: 0 });
    expect(snap.tasks.latest).toEqual([]);
    db.close();
  });
});
