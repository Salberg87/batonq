// tui-data — pure data access + formatting helpers for the batonq TUI.
// Kept separate from tui.tsx so it can be unit-tested without rendering ink.

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

export type SessionRow = {
  session_id: string;
  cwd: string | null;
  started_at: string;
  last_seen: string;
};

export type ClaimRow = {
  id: number;
  fingerprint: string;
  file_path: string;
  session_id: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
  holder_cwd?: string | null;
};

export type TaskRow = {
  id: number;
  external_id: string;
  repo: string;
  body: string;
  status: "draft" | "pending" | "claimed" | "done";
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  verify_cmd?: string | null;
  verify_output?: string | null;
  verify_ran_at?: string | null;
  judge_cmd?: string | null;
  judge_output?: string | null;
  judge_ran_at?: string | null;
  enrich_questions?: string | null;
  original_body?: string | null;
  priority?: "high" | "normal" | "low" | null;
};

export type EventRow = {
  event_id?: string;
  ts: string;
  phase: "pre" | "post" | "bash" | string;
  session?: string;
  cwd?: string;
  tool?: string;
  paths?: string[];
  decision?: string;
  reason?: string;
};

export type Snapshot = {
  now: string;
  sessions: SessionRow[];
  claims: ClaimRow[];
  tasks: {
    drafts: TaskRow[];
    pending: TaskRow[];
    claimed: TaskRow[];
    done: TaskRow[];
    latest: TaskRow[];
    counts: {
      drafts: number;
      pending: number;
      claimed: number;
      done: number;
    };
  };
  events: EventRow[];
};

// ── formatters ────────────────────────────────────────────────────────────────

export function formatAge(fromIso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return "?";
  const delta = Math.max(0, nowMs - then);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatExpiresIn(
  expiresIso: string,
  nowMs: number = Date.now(),
): string {
  const then = Date.parse(expiresIso);
  if (!Number.isFinite(then)) return "?";
  const delta = then - nowMs;
  if (delta <= 0) return "expired";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function sessionStatus(
  last_seen: string,
  nowMs: number = Date.now(),
): "live" | "idle" | "stale" {
  const age = nowMs - Date.parse(last_seen);
  if (!Number.isFinite(age)) return "stale";
  if (age < 60_000) return "live";
  if (age < 5 * 60_000) return "idle";
  return "stale";
}

export function shortPath(p: string, max: number = 40): string {
  if (p.length <= max) return p;
  return "…" + p.slice(p.length - (max - 1));
}

export function shortId(id: string, n: number = 8): string {
  return id.length <= n ? id : id.slice(0, n);
}

// ── done badges / priority grouping ───────────────────────────────────────────

// Badge for a done task. Branches, in order:
//   ⚠     — verify_cmd set but never ran (juks — task self-closed without gate)
//   ✓V ✓J — both gates ran
//   ✓V —  — verify ran, judge absent
//   — ✓J  — judge ran, verify absent
//   ⊘     — no gates at all
export type DoneBadge = "⚠" | "✓V ✓J" | "✓V —" | "— ✓J" | "⊘";

export function doneBadge(t: TaskRow): DoneBadge {
  const vRan = !!t.verify_ran_at;
  const jRan = !!t.judge_ran_at;
  const vCmd = !!t.verify_cmd;
  if (vCmd && !vRan) return "⚠";
  if (vRan && jRan) return "✓V ✓J";
  if (vRan && !jRan) return "✓V —";
  if (!vRan && jRan) return "— ✓J";
  return "⊘";
}

export type PriorityBucket = "H" | "N" | "L";

export function priorityBucket(t: TaskRow): PriorityBucket {
  if (t.priority === "high") return "H";
  if (t.priority === "low") return "L";
  return "N";
}

// Group tasks by priority bucket. Within each bucket, original relative order
// is preserved so upstream sort (e.g. pick-order) stays visible to the user.
export function groupByPriority(tasks: TaskRow[]): {
  H: TaskRow[];
  N: TaskRow[];
  L: TaskRow[];
} {
  const out = { H: [] as TaskRow[], N: [] as TaskRow[], L: [] as TaskRow[] };
  for (const t of tasks) out[priorityBucket(t)].push(t);
  return out;
}

// ── git helpers for drill-down ────────────────────────────────────────────────

// Commits reachable from HEAD whose author-date is at/after `sinceIso`, in
// the repo rooted at `cwd`. Used by the drill-down overlay's "Commits since
// claim" section. Failures (not a repo, bad date, git absent) collapse to an
// empty list — the overlay just shows "(none)" in that case.
export function commitsSince(
  sinceIso: string | null | undefined,
  cwd: string,
): { sha: string; subject: string }[] {
  if (!sinceIso) return [];
  const r = require("node:child_process").spawnSync(
    "git",
    [
      "-C",
      cwd,
      "log",
      `--since=${sinceIso}`,
      "--pretty=format:%h %s",
      "-n",
      "20",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return [];
  const out = (r.stdout ?? "").trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((line: string) => {
      const m = line.match(/^(\S+)\s+(.*)$/);
      return m ? { sha: m[1]!, subject: m[2]! } : null;
    })
    .filter(
      (
        x: { sha: string; subject: string } | null,
      ): x is { sha: string; subject: string } => x !== null,
    );
}

// ── drill-down helpers ────────────────────────────────────────────────────────

// Return the last N non-empty lines of a captured output blob. Used by the
// drill-down overlay to show the tail of verify_output (noise at the start of
// a long log is unhelpful; the failing assertion is almost always near the
// end). Null/empty input returns empty array.
export function tailLines(
  text: string | null | undefined,
  n: number,
): string[] {
  if (!text) return [];
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  // Drop trailing blank (common when the captured output ends with "\n").
  while (all.length && all[all.length - 1] === "") all.pop();
  return all.slice(Math.max(0, all.length - n));
}

// First N lines, trimmed of trailing blanks. Used for judge verdict — the
// verdict string starts with PASS/FAIL on line 1 and reason follows, so the
// head is what matters.
export function headLines(
  text: string | null | undefined,
  n: number,
): string[] {
  if (!text) return [];
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  while (all.length && all[all.length - 1] === "") all.pop();
  return all.slice(0, n);
}

// ── filters ───────────────────────────────────────────────────────────────────

export function matchesFilter(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function filterTasks(tasks: TaskRow[], q: string): TaskRow[] {
  if (!q) return tasks;
  return tasks.filter((t) =>
    matchesFilter(`${t.repo} ${t.body} ${t.status} ${t.external_id}`, q),
  );
}

export function filterClaims(claims: ClaimRow[], q: string): ClaimRow[] {
  if (!q) return claims;
  return claims.filter((c) =>
    matchesFilter(`${c.file_path} ${c.session_id} ${c.holder_cwd ?? ""}`, q),
  );
}

export function filterSessions(
  sessions: SessionRow[],
  q: string,
): SessionRow[] {
  if (!q) return sessions;
  return sessions.filter((s) =>
    matchesFilter(`${s.session_id} ${s.cwd ?? ""}`, q),
  );
}

export function filterEvents(events: EventRow[], q: string): EventRow[] {
  if (!q) return events;
  return events.filter((e) => {
    const hay = `${e.tool ?? ""} ${e.phase} ${(e.paths ?? []).join(" ")} ${
      e.session ?? ""
    } ${e.decision ?? ""}`;
    return matchesFilter(hay, q);
  });
}

// ── events tail ───────────────────────────────────────────────────────────────

export function parseEventsJsonl(text: string, limit: number = 20): EventRow[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const start = Math.max(0, lines.length - limit);
  const out: EventRow[] = [];
  for (let i = start; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]!) as EventRow);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function readEventsTail(path: string, limit: number = 20): EventRow[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  // read last ~64KB to avoid pulling huge files into memory
  const maxBytes = 64 * 1024;
  const start = Math.max(0, size - maxBytes);
  const fd = require("node:fs").openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    require("node:fs").readSync(fd, buf, 0, buf.length, start);
    // drop partial first line if we skipped ahead
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return parseEventsJsonl(text, limit);
  } finally {
    require("node:fs").closeSync(fd);
  }
}

// ── DB loader ─────────────────────────────────────────────────────────────────

export function loadSnapshot(
  db: Database,
  opts: { eventsPath?: string; limit?: number; now?: number } = {},
): Snapshot {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();

  const sessions = db
    .query("SELECT * FROM sessions ORDER BY last_seen DESC")
    .all() as SessionRow[];

  const claims = db
    .query(
      `SELECT c.*, s.cwd AS holder_cwd FROM claims c
       LEFT JOIN sessions s ON s.session_id = c.session_id
       WHERE c.released_at IS NULL
       ORDER BY c.acquired_at DESC`,
    )
    .all() as ClaimRow[];

  const drafts = db
    .query("SELECT * FROM tasks WHERE status = 'draft' ORDER BY created_at")
    .all() as TaskRow[];
  const pending = db
    .query("SELECT * FROM tasks WHERE status = 'pending' ORDER BY id")
    .all() as TaskRow[];
  const claimed = db
    .query(
      "SELECT * FROM tasks WHERE status = 'claimed' ORDER BY claimed_at DESC",
    )
    .all() as TaskRow[];
  const done = db
    .query(
      "SELECT * FROM tasks WHERE status = 'done' ORDER BY completed_at DESC LIMIT 20",
    )
    .all() as TaskRow[];

  const latest = latestTasks([...drafts, ...pending, ...claimed, ...done], 6);

  const events = opts.eventsPath
    ? readEventsTail(opts.eventsPath, opts.limit ?? 20)
    : [];

  return {
    now: nowIso,
    sessions,
    claims,
    tasks: {
      drafts,
      pending,
      claimed,
      done,
      latest,
      counts: {
        drafts: drafts.length,
        pending: pending.length,
        claimed: claimed.length,
        done: done.length,
      },
    },
    events,
  };
}

export function latestTasks(tasks: TaskRow[], n: number = 5): TaskRow[] {
  // Latest = most-recently-touched — claimed_at, completed_at, or created_at.
  const stamp = (t: TaskRow): number => {
    const candidates = [t.completed_at, t.claimed_at, t.created_at].filter(
      (x): x is string => !!x,
    );
    const ms = candidates
      .map((s) => Date.parse(s))
      .filter((n) => Number.isFinite(n));
    return ms.length ? Math.max(...ms) : 0;
  };
  return [...tasks].sort((a, b) => stamp(b) - stamp(a)).slice(0, n);
}

// ── paths ─────────────────────────────────────────────────────────────────────

export const DEFAULT_DB_PATH = `${process.env.HOME ?? ""}/.claude/batonq/state.db`;
export const DEFAULT_EVENTS_PATH = `${process.env.HOME ?? ""}/.claude/batonq-measurement/events.jsonl`;

export function openStateDb(path: string = DEFAULT_DB_PATH): Database {
  if (!existsSync(path)) {
    // Create parent dir (canonical path is directory-based) then let
    // bun:sqlite create the file. Minimal schema so the TUI doesn't crash
    // on fresh installs.
    const dir = path.replace(/\/[^/]+$/, "");
    if (dir && !existsSync(dir)) {
      require("node:fs").mkdirSync(dir, { recursive: true });
    }
    const db = new Database(path, { create: true });
    db.exec("PRAGMA busy_timeout=3000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT,
        started_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        file_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        release_hash TEXT
      );
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
        original_body TEXT
      );
    `);
    return db;
  }
  const db = new Database(path, { readwrite: true });
  db.exec("PRAGMA busy_timeout=3000;");
  return db;
}
