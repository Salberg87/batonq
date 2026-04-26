// tasks-core — pure functions for TASKS.md parsing, syncing, picking, and verifying.
// Extracted from agent-coord so they can be exercised by tests against an in-memory DB
// and a fixture TASKS.md, with no dependency on ~/.claude state.

import { Database } from "bun:sqlite";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { IMPLEMENTED_TOOLS } from "./agent-runners/types";
import { routeTask, type RoutingDecision } from "./agent-runners/routing";
import { AGENT_ROLES, type AgentRole } from "./agent-runners/role-skills";

// OpenClaw-inspired claim TTL: claimed tasks must show progress (PostToolUse
// touches `last_progress_at`) within this window or they're candidates for
// recovery. A separate heartbeat gate protects sessions that are alive but
// between tool calls; only sessions that also miss their heartbeat transition
// to `lost` and land in the escalation log.
export const TASK_CLAIM_TTL_MS = 30 * 60 * 1000;
export const TASK_RECOVERY_HEARTBEAT_MS = 5 * 60 * 1000;
export const DEFAULT_ESCALATION_LOG_PATH = "/tmp/batonq-escalations.log";

export type TaskStatus = "draft" | "pending" | "claimed" | "done" | "lost";

export type TaskPriority = "high" | "normal" | "low";
export const DEFAULT_PRIORITY: TaskPriority = "normal";

export interface ParsedTask {
  repo: string;
  body: string;
  status: TaskStatus;
  lineIdx: number;
  verifyCmd?: string;
  judgeCmd?: string;
  priority?: TaskPriority;
  // ISO-8601 UTC. A task with scheduled_for > now() is not pickable.
  scheduledFor?: string;
  // Multi-CLI dispatch annotations parsed from `@agent:` / `@model:` tokens
  // in the task body. Both are stripped from `body` before persisting so the
  // DB row holds clean prose. `agent` is populated only when the parsed
  // value is in IMPLEMENTED_TOOLS+'any' — unknown agents are stripped from
  // the body but not assigned (Zod validation would reject them anyway).
  agent?: string;
  model?: string;
  // `@role:<name>` annotation. Same strip-but-validate semantics as @agent:
  // — the token is always removed from the body, but the field is only set
  // when the captured value is a known AGENT_ROLES member (worker / judge /
  // pr-runner / explorer / reviewer).
  role?: AgentRole;
}

// Pattern from oxo's orchestrator. Annotations are written inline in the
// task body to pin a specific runner / model for that task:
//   - [ ] **batonq** — fix bug @agent:gemini @model:flash
//
// Capture vs strip: the value regex captures `[\w-]+` (a strict superset of
// `\w+` that also accepts hyphens). The body is stripped of the SAME range
// regardless of whether we honour the captured value. That keeps parsing
// idempotent — re-running on the cleaned body yields the same result.
//
// Edge cases (documented choices):
//   - `@agent:gemini` → agent='gemini' (valid IMPLEMENTED_TOOLS member).
//   - `@agent:gemini-flash` → captured value 'gemini-flash' is NOT in
//     IMPLEMENTED_TOOLS+'any', so the agent field stays undefined. The
//     annotation is still removed from the body so the operation is
//     idempotent (parse 2x of the same body gives the same result). The
//     user almost certainly meant `@agent:gemini @model:flash`.
//   - `@agent:` (empty value) doesn't match `[\w-]+` at all (needs ≥1
//     char) — left in body verbatim. Treated as a typo, not an annotation.
//   - Unknown agent like `@agent:cursor`: parsed and stripped, but agent
//     stays undefined so downstream defaulting picks 'any'.
//   - Multiple `@agent:` tokens: first match wins; later occurrences are
//     also stripped so the persisted body never contains annotation tokens.
//   - `@model:` has no enum (models are freeform nicknames per runner) so
//     `@model:gemini-pro` parses model='gemini-pro' verbatim.
//   - `@role:` accepts only AGENT_ROLES members (worker, judge, pr-runner,
//     explorer, reviewer). Unknown roles are stripped but not assigned —
//     same shape as @agent: above. Hyphenated values like `pr-runner` work
//     because the value regex captures `[\w-]+`.
const ANNOTATION_AGENT_RE = /@agent:([\w-]+)/g;
const ANNOTATION_MODEL_RE = /@model:([\w-]+)/g;
const ANNOTATION_ROLE_RE = /@role:([\w-]+)/g;
const VALID_ANNOTATION_AGENTS = new Set<string>([...IMPLEMENTED_TOOLS, "any"]);
const VALID_ANNOTATION_ROLES = new Set<string>(AGENT_ROLES);

export interface AnnotationParseResult {
  body: string;
  agent?: string;
  model?: string;
  role?: AgentRole;
}

export function extractAnnotations(rawBody: string): AnnotationParseResult {
  const agentMatch = rawBody.match(/@agent:([\w-]+)/);
  const modelMatch = rawBody.match(/@model:([\w-]+)/);
  const roleMatch = rawBody.match(/@role:([\w-]+)/);
  let agent: string | undefined;
  let model: string | undefined;
  let role: AgentRole | undefined;
  if (agentMatch && VALID_ANNOTATION_AGENTS.has(agentMatch[1]!)) {
    agent = agentMatch[1];
  }
  if (modelMatch) model = modelMatch[1];
  if (roleMatch && VALID_ANNOTATION_ROLES.has(roleMatch[1]!)) {
    role = roleMatch[1] as AgentRole;
  }
  const body = rawBody
    .replace(ANNOTATION_AGENT_RE, "")
    .replace(ANNOTATION_MODEL_RE, "")
    .replace(ANNOTATION_ROLE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return { body, agent, model, role };
}

// Normalise whatever the user typed into one of the three priority tokens.
// Unknown input (including the empty string, garbage, or wrong case) falls
// back to "normal" so a typo in TASKS.md never silently promotes work.
export function normalizePriority(
  raw: string | null | undefined,
): TaskPriority {
  if (!raw) return DEFAULT_PRIORITY;
  const s = raw.trim().toLowerCase();
  if (s === "high" || s === "normal" || s === "low") return s;
  return DEFAULT_PRIORITY;
}

// Accept only strict ISO-8601 UTC with a Z/±HH:MM offset. We need lexicographic
// comparison to match chronological order in the SQL pick query, which only
// holds when every stored timestamp has the same shape. Returns the
// canonicalised ISO string (ms-precision, Z-suffixed) or null if unparseable.
export function normalizeScheduledFor(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Require a date AND a time component with timezone info. A bare date
  // ("2026-05-01") parses as midnight-local on some platforms and midnight-UTC
  // on others — refuse it rather than guess.
  if (
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(
      s,
    )
  ) {
    return null;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// `?` marks a draft task — TUI-created tasks land here until enrichment +
// `batonq promote` flips them to pending so `pick` will see them.
const TASK_RE =
  /^- \[([ x~?])\] (?:\d{4}-\d{2}-\d{2} )?\*\*([^*]+)\*\*\s*[—–-]+\s*(.+?)(?:\s*\([^)]*\))?$/;
const VERIFY_RE = /^\s+verify:\s*(.+?)\s*$/;
const JUDGE_RE = /^\s+judge:\s*(.+?)\s*$/;
const PRIORITY_RE = /^\s+priority:\s*(.+?)\s*$/i;
const SCHEDULED_RE = /^\s+scheduled_for:\s*(.+?)\s*$/i;

export function parseTasksFile(tasksPath: string): {
  lines: string[];
  tasks: ParsedTask[];
} {
  if (!existsSync(tasksPath)) return { lines: [], tasks: [] };
  const text = readFileSync(tasksPath, "utf8");
  return parseTasksText(text);
}

export function parseTasksText(text: string): {
  lines: string[];
  tasks: ParsedTask[];
} {
  // Single pass: iterate every line with HTML-comment / code-fence state
  // tracked continuously. The current "owning" task accumulates verify: and
  // judge: directives that appear anywhere in its block (prose paragraphs,
  // blank lines, indented continuations) until the next task line starts.
  // Directives inside ```fences``` or <!-- comments --> are skipped because
  // those branches `continue` before the verify/judge match runs.
  // First occurrence of each directive wins — a task with two verify: lines
  // keeps the first one.
  const lines = text.split("\n");
  const tasks: ParsedTask[] = [];
  let inHtmlComment = false;
  let inCodeFence = false;
  let current: ParsedTask | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inHtmlComment && /^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!inHtmlComment && line.includes("<!--")) {
      if (line.includes("-->")) continue;
      inHtmlComment = true;
      continue;
    }
    if (inHtmlComment) {
      if (line.includes("-->")) inHtmlComment = false;
      continue;
    }
    const m = line.match(TASK_RE);
    if (m) {
      const status: ParsedTask["status"] =
        m[1] === " "
          ? "pending"
          : m[1] === "~"
            ? "claimed"
            : m[1] === "?"
              ? "draft"
              : "done";
      const annotated = extractAnnotations(m[3]!.trim());
      current = {
        repo: m[2]!.trim(),
        body: annotated.body,
        status,
        lineIdx: i,
        agent: annotated.agent,
        model: annotated.model,
        role: annotated.role,
      };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    if (current.verifyCmd === undefined) {
      const vm = line.match(VERIFY_RE);
      if (vm) {
        current.verifyCmd = vm[1];
        continue;
      }
    }
    if (current.judgeCmd === undefined) {
      const jm = line.match(JUDGE_RE);
      if (jm) {
        current.judgeCmd = jm[1];
        continue;
      }
    }
    if (current.priority === undefined) {
      const pm = line.match(PRIORITY_RE);
      if (pm) {
        current.priority = normalizePriority(pm[1]);
        continue;
      }
    }
    if (current.scheduledFor === undefined) {
      const sm = line.match(SCHEDULED_RE);
      if (sm) {
        const iso = normalizeScheduledFor(sm[1]);
        if (iso) current.scheduledFor = iso;
      }
    }
  }
  return { lines, tasks };
}

export function externalId(repo: string, body: string): string {
  return createHash("sha256")
    .update(`${repo}|${body}`)
    .digest("hex")
    .slice(0, 12);
}

export function initTaskSchema(db: Database): void {
  db.exec(`
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
      original_body TEXT,
      last_progress_at TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      scheduled_for TEXT,
      agent TEXT,
      model TEXT,
      session_id TEXT,
      reuse_session INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'worker'
    );
    CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_repo_status ON tasks(repo, status);
  `);
  // idx_task_pick is created below, AFTER the ALTER TABLEs — on a legacy DB
  // the priority / scheduled_for columns don't exist yet when this exec runs.
  // Migration for pre-existing DBs that lack verify_*, judge_*, enrich_* columns
  const cols = db
    .query("SELECT name FROM pragma_table_info('tasks')")
    .all() as {
    name: string;
  }[];
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("verify_cmd"))
    db.exec("ALTER TABLE tasks ADD COLUMN verify_cmd TEXT");
  if (!has("verify_output"))
    db.exec("ALTER TABLE tasks ADD COLUMN verify_output TEXT");
  if (!has("verify_ran_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN verify_ran_at TEXT");
  if (!has("judge_cmd")) db.exec("ALTER TABLE tasks ADD COLUMN judge_cmd TEXT");
  if (!has("judge_output"))
    db.exec("ALTER TABLE tasks ADD COLUMN judge_output TEXT");
  if (!has("judge_ran_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN judge_ran_at TEXT");
  if (!has("enrich_questions"))
    db.exec("ALTER TABLE tasks ADD COLUMN enrich_questions TEXT");
  if (!has("original_body"))
    db.exec("ALTER TABLE tasks ADD COLUMN original_body TEXT");
  if (!has("last_progress_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN last_progress_at TEXT");
  // SQLite ALTER TABLE cannot add a NOT NULL column without a default on an
  // existing table, but a DEFAULT clause is fine — existing rows inherit it.
  if (!has("priority"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
    );
  if (!has("scheduled_for"))
    db.exec("ALTER TABLE tasks ADD COLUMN scheduled_for TEXT");
  // Multi-CLI dispatch target. Nullable at the DB layer; the schema layer
  // (task-schema.ts) defaults missing values to 'any'. NULL on legacy rows
  // is interpreted the same as 'any' by the dispatcher. Migration helper
  // lives in migrate.ts alongside the other one-shot rename migrations.
  const {
    migrateAgentColumn,
    migrateModelColumn,
    migrateSessionIdColumn,
    migrateReuseSessionColumn,
    migrateRoleColumn,
  } = require("./migrate");
  migrateAgentColumn(db);
  migrateModelColumn(db);
  migrateSessionIdColumn(db);
  migrateReuseSessionColumn(db);
  migrateRoleColumn(db);
  // The pick index is created after ALTERs so migrating DBs get it too.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_task_pick ON tasks(status, priority, scheduled_for, created_at)`,
  );
}

export function initClaimsSchema(db: Database): void {
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_claim
      ON claims(fingerprint, file_path)
      WHERE released_at IS NULL;
  `);
}

export interface SyncResult {
  added: number;
  completed: number;
  parsed: number;
}

export function syncTasks(
  db: Database,
  parsed: ParsedTask[],
  nowIso: string = new Date().toISOString(),
): SyncResult {
  let added = 0;
  let completed = 0;
  for (const t of parsed) {
    const eid = externalId(t.repo, t.body);
    const existing = db
      .query("SELECT * FROM tasks WHERE external_id = ?")
      .get(eid) as any;
    const verify = t.verifyCmd ?? null;
    const judge = t.judgeCmd ?? null;
    const priority = t.priority ?? DEFAULT_PRIORITY;
    const scheduledFor = t.scheduledFor ?? null;
    // Annotation-derived agent overrides the 'any' default; missing → 'any'.
    // Model is freeform and only persisted when present.
    const agent = t.agent ?? "any";
    const model = t.model ?? null;
    // Role defaults to 'worker' — same default semantics as the schema layer.
    const role = t.role ?? "worker";
    // Map MD status → DB status. `claimed` in MD is treated as pending on
    // insert (DB owns claim state); draft and done pass through verbatim.
    const insertStatus =
      t.status === "done" ? "done" : t.status === "draft" ? "draft" : "pending";
    if (!existing) {
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, verify_cmd, judge_cmd, priority, scheduled_for, agent, model, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eid,
          t.repo,
          t.body,
          insertStatus,
          nowIso,
          verify,
          judge,
          priority,
          scheduledFor,
          agent,
          model,
          role,
        ],
      );
      if (t.status !== "done") added++;
    } else {
      if (t.status === "done" && existing.status !== "done") {
        db.run(
          `UPDATE tasks SET status = 'done', completed_at = ? WHERE external_id = ?`,
          [nowIso, eid],
        );
        completed++;
      }
      // MD-driven promote: if a human flips `[?]` to `[ ]` directly in
      // TASKS.md, sync should reflect that. Don't touch claimed/done rows.
      if (t.status === "pending" && existing.status === "draft") {
        db.run(`UPDATE tasks SET status = 'pending' WHERE external_id = ?`, [
          eid,
        ]);
      }
      if (verify !== existing.verify_cmd) {
        db.run(`UPDATE tasks SET verify_cmd = ? WHERE external_id = ?`, [
          verify,
          eid,
        ]);
      }
      if (judge !== existing.judge_cmd) {
        db.run(`UPDATE tasks SET judge_cmd = ? WHERE external_id = ?`, [
          judge,
          eid,
        ]);
      }
      // Priority and scheduled_for are editable in-place: flipping `priority: high`
      // in TASKS.md on an already-synced pending task must actually re-rank it.
      // Only touches pending and draft rows — claimed/done are frozen so an
      // active agent's run state can't be disturbed mid-flight.
      if (existing.status === "pending" || existing.status === "draft") {
        if (priority !== existing.priority) {
          db.run(`UPDATE tasks SET priority = ? WHERE external_id = ?`, [
            priority,
            eid,
          ]);
        }
        if (scheduledFor !== existing.scheduled_for) {
          db.run(`UPDATE tasks SET scheduled_for = ? WHERE external_id = ?`, [
            scheduledFor,
            eid,
          ]);
        }
        // Agent/model annotations are editable in-place too: a user adding
        // `@agent:gemini` to a previously-synced pending task on disk must
        // re-route that task on the next pick.
        if (agent !== (existing.agent ?? "any")) {
          db.run(`UPDATE tasks SET agent = ? WHERE external_id = ?`, [
            agent,
            eid,
          ]);
        }
        if (model !== (existing.model ?? null)) {
          db.run(`UPDATE tasks SET model = ? WHERE external_id = ?`, [
            model,
            eid,
          ]);
        }
        if (role !== (existing.role ?? "worker")) {
          db.run(`UPDATE tasks SET role = ? WHERE external_id = ?`, [
            role,
            eid,
          ]);
        }
      }
    }
  }
  return { added, completed, parsed: parsed.length };
}

export interface PickOptions {
  repo: string | null;
  any?: boolean;
  // ISO-8601 UTC; defaults to new Date().toISOString() at call time. Passed
  // in so tests can pin "now" and exercise the scheduled_for gate
  // deterministically.
  nowIso?: string;
}

// Pickable status is `pending` only — drafts (status='draft') are intentionally
// excluded so an autonomous agent never claims a task whose intent has not
// been enriched and human-approved via `batonq promote`. Do NOT broaden this
// filter to `status != 'done'` or similar — that would silently re-open the
// queue to drafts. See test "selectCandidate skips drafts" in core.test.ts.
//
// Ordering (shared across all scope branches — keep in sync):
//   1. priority: high (0) < normal (1) < low (2). Explicit CASE so adding a
//      fourth bucket later doesn't silently fall through to the default.
//   2. COALESCE(scheduled_for, created_at) ASC — fire scheduled work as soon
//      as it's ripe; otherwise FIFO by creation.
//   3. created_at ASC — final tiebreaker so identical-priority / identical-
//      schedule rows still pick deterministically instead of depending on
//      SQLite's rowid quirks.
//
// Gate: scheduled_for IS NULL OR scheduled_for <= :now — tasks whose
// scheduled_for is in the future are invisible to pick. String comparison is
// safe because normalizeScheduledFor canonicalises everything to the same
// ISO-8601 Z-suffixed shape on the way in.
const PICK_ORDER_BY = `
  CASE priority
    WHEN 'high' THEN 0
    WHEN 'normal' THEN 1
    ELSE 2
  END ASC,
  COALESCE(scheduled_for, created_at) ASC,
  created_at ASC
`;

export function selectCandidate(db: Database, opts: PickOptions): any {
  const { repo, any } = opts;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const scheduleGate = `(scheduled_for IS NULL OR scheduled_for <= ?)`;

  if (any) {
    return db
      .query(
        `SELECT * FROM tasks
         WHERE status = 'pending' AND ${scheduleGate}
         ORDER BY ${PICK_ORDER_BY}
         LIMIT 1`,
      )
      .get(nowIso);
  }
  if (repo) {
    return db
      .query(
        `SELECT * FROM tasks
         WHERE status = 'pending' AND ${scheduleGate}
           AND (repo = ? OR repo LIKE 'any:%')
         ORDER BY ${PICK_ORDER_BY}
         LIMIT 1`,
      )
      .get(nowIso, repo);
  }
  return db
    .query(
      `SELECT * FROM tasks
       WHERE status = 'pending' AND ${scheduleGate}
         AND repo LIKE 'any:%'
       ORDER BY ${PICK_ORDER_BY}
       LIMIT 1`,
    )
    .get(nowIso);
}

/**
 * Resolve the (agent, model) routing for a candidate task row. Wraps
 * `routeTask` so the pick command can announce the dispatch target without
 * importing the routing module directly. Accepts any object with a body
 * and an optional agent field — matches the shape returned by
 * `selectCandidate` (raw DB row).
 */
export function resolveCandidateRouting(row: {
  body: string;
  agent?: string | null;
}): RoutingDecision {
  return routeTask(row.body, row.agent ?? null);
}

export function claimCandidate(
  db: Database,
  id: number,
  session: string,
  nowIso: string = new Date().toISOString(),
): { changes: number } {
  const result = db.run(
    `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?
     WHERE id = ? AND status = 'pending'`,
    [session, nowIso, id],
  );
  return { changes: result.changes };
}

export function sweepClaims(
  db: Database,
  nowIso: string = new Date().toISOString(),
): { expired: number } {
  const r = db.run(
    `UPDATE claims SET released_at = ? WHERE released_at IS NULL AND expires_at < ?`,
    [nowIso, nowIso],
  );
  return { expired: r.changes };
}

// ── task-claim TTL + lost-state + escalation (OpenClaw-inspired) ──────────────
//
// touchTaskProgress refreshes `last_progress_at` on every claimed task owned by
// a session. Called by the PostToolUse hook so that an agent actively doing
// work (tool calls) resets the TTL clock. Returns the number of rows touched
// (0 if the session holds no claims — the common case).
export function touchTaskProgress(
  db: Database,
  sessionId: string,
  nowIso: string = new Date().toISOString(),
): { touched: number } {
  const r = db.run(
    `UPDATE tasks SET last_progress_at = ?
     WHERE status = 'claimed' AND claimed_by = ?`,
    [nowIso, sessionId],
  );
  return { touched: r.changes };
}

export interface TaskRecoveryContext {
  task: any;
  session: any | null;
  nowMs: number;
}

export type TaskRecoveryDecision =
  | { kind: "defer"; untilIso: string }
  | { kind: "mark_lost" };

export type TaskRecoveryHook = (
  ctx: TaskRecoveryContext,
) => TaskRecoveryDecision;

// Default recovery gate: if the claiming session shows a heartbeat within
// TASK_RECOVERY_HEARTBEAT_MS (5 min) we defer another 5 min — the agent is
// alive but between tool calls. Otherwise mark_lost so sweepTasks can flip
// status and log an escalation.
export function tryRecoverTaskBeforeMarkLost(
  ctx: TaskRecoveryContext,
): TaskRecoveryDecision {
  const { session, nowMs } = ctx;
  const lastSeen = session?.last_seen;
  if (typeof lastSeen === "string" && lastSeen) {
    const lastSeenMs = Date.parse(lastSeen);
    if (
      Number.isFinite(lastSeenMs) &&
      nowMs - lastSeenMs < TASK_RECOVERY_HEARTBEAT_MS
    ) {
      return {
        kind: "defer",
        untilIso: new Date(nowMs + TASK_RECOVERY_HEARTBEAT_MS).toISOString(),
      };
    }
  }
  return { kind: "mark_lost" };
}

export interface SweepTasksOptions {
  nowIso?: string;
  ttlMs?: number;
  recover?: TaskRecoveryHook;
  escalationLogPath?: string;
  writeEscalation?: (line: string) => void;
}

export interface SweepTasksResult {
  scanned: number;
  lost: number;
  deferred: number;
}

// sweepTasks scans claimed tasks whose last progress (or claim time when the
// task has never been touched) predates now-TTL, runs the recovery hook on
// each, and either defers (bumps last_progress_at into the future) or marks
// the task `lost` and appends a line to the escalation log.
//
// The escalation log is JSONL with one record per lost task so downstream
// watchers (humans, Slack bots, …) can tail it without parsing prose.
export function sweepTasks(
  db: Database,
  opts: SweepTasksOptions = {},
): SweepTasksResult {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const ttlMs = opts.ttlMs ?? TASK_CLAIM_TTL_MS;
  const recover = opts.recover ?? tryRecoverTaskBeforeMarkLost;
  const cutoffIso = new Date(nowMs - ttlMs).toISOString();

  const stale = db
    .query(
      `SELECT * FROM tasks
       WHERE status = 'claimed'
         AND COALESCE(last_progress_at, claimed_at) < ?`,
    )
    .all(cutoffIso) as any[];

  let lost = 0;
  let deferred = 0;

  for (const task of stale) {
    const session = task.claimed_by
      ? ((db
          .query(`SELECT * FROM sessions WHERE session_id = ?`)
          .get(task.claimed_by) as any) ?? null)
      : null;
    const decision = recover({ task, session, nowMs });
    if (decision.kind === "defer") {
      db.run(`UPDATE tasks SET last_progress_at = ? WHERE id = ?`, [
        decision.untilIso,
        task.id,
      ]);
      deferred++;
      continue;
    }
    db.run(`UPDATE tasks SET status = 'lost' WHERE id = ?`, [task.id]);
    lost++;
    const bodySnippet = (task.body ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const line =
      JSON.stringify({
        ts: nowIso,
        external_id: task.external_id,
        repo: task.repo,
        claimed_by: task.claimed_by,
        claimed_at: task.claimed_at,
        last_progress_at: task.last_progress_at,
        body_snippet: bodySnippet,
      }) + "\n";
    if (opts.writeEscalation) {
      opts.writeEscalation(line);
    } else {
      const path = opts.escalationLogPath ?? DEFAULT_ESCALATION_LOG_PATH;
      try {
        appendFileSync(path, line, { mode: 0o600 });
      } catch {
        // non-fatal — sweep is best-effort; next run re-scans anyway
      }
    }
  }

  return { scanned: stale.length, lost, deferred };
}

export interface VerifyResult {
  code: number;
  output: string;
}

// Shell preamble prepended to every verify command. Exposes
// `git_commits_since_claim` so verify scripts can assert against commits made
// after the task was claimed, rather than `git log -1` (which breaks in
// multi-agent setups when a peer commits between claim and done).
const VERIFY_PREAMBLE = [
  "git_commits_since_claim() {",
  '  if [ -z "${BATONQ_CLAIM_TS:-}" ]; then',
  '    echo "git_commits_since_claim: BATONQ_CLAIM_TS not set" >&2',
  "    return 2",
  "  fi",
  '  git log --since="$BATONQ_CLAIM_TS" --pretty=%s "$@"',
  "}",
].join("\n");

// Detect the fragile commit-subject pattern that BATONQ_CLAIM_TS replaces:
// `git log -1 --pretty=%s | grep ...` breaks when a peer loop commits between
// the task's done and the gate running. Exported for tests.
export function detectFragileGitLog(cmd: string): boolean {
  return /git\s+log\s+-1\b/.test(cmd) && /\|\s*grep\b/.test(cmd);
}

export function runVerify(
  cmd: string,
  cwd: string,
  taskId: string,
  claimedAt?: string | null,
): VerifyResult {
  const MAX_OUTPUT = 1024 * 1024 * 4;
  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENT_COORD_REPO_ROOT: cwd,
    AGENT_COORD_TASK_ID: taskId,
  };
  if (claimedAt) env.BATONQ_CLAIM_TS = claimedAt;
  const wrapped = `${VERIFY_PREAMBLE}\n${cmd}`;
  const warning = detectFragileGitLog(cmd)
    ? "[batonq] warning: verify uses `git log -1` — fragile under parallel loops. " +
      "Switch to `git_commits_since_claim` (BATONQ_CLAIM_TS) to avoid deadlocks. " +
      "See docs/faq.md.\n"
    : "";
  const result = spawnSync("/bin/sh", ["-c", wrapped], {
    cwd,
    env,
    timeout: 300_000,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = warning + stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
  let code: number;
  if (result.error && (result.error as any).code === "ETIMEDOUT") code = 124;
  else if (result.signal)
    code =
      128 +
      (result.signal === "SIGKILL" ? 9 : result.signal === "SIGTERM" ? 15 : 1);
  else code = result.status ?? 1;
  return { code, output };
}

// ── judge gate ────────────────────────────────────────────────────────────────

export interface JudgeResult {
  passed: boolean;
  output: string;
}

// Spawn shape we actually depend on — a narrow subset of spawnSync's return,
// so tests can inject a fake without pulling the whole child_process surface.
export interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | null;
}
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; input?: string; timeout?: number; maxBuffer?: number },
) => SpawnResult;

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; input?: string; timeout?: number; maxBuffer?: number },
): SpawnResult {
  const r = spawnSync(cmd, args, { ...opts, encoding: "utf8" });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: (r.error ?? null) as any,
  };
}

export function runJudge(
  judgePrompt: string,
  gitDiff: string,
  cwd: string,
  spawn: SpawnFn = defaultSpawn,
): JudgeResult {
  // Invariant: PASS requires result.status === 0 && !result.error FIRST — never
  // trust stdout alone (a non-zero exit whose stdout contains "PASS" must NOT gate through).
  const MAX_OUTPUT = 1024 * 1024 * 4; // 4 MB
  const prompt = `${judgePrompt}\n\n---\nGit diff:\n\`\`\`\n${gitDiff}\n\`\`\`\n\nRespond with PASS or FAIL on the first line, followed by a brief explanation.`;

  const result = spawn("claude", ["-p", "--model", "haiku"], {
    cwd,
    input: prompt,
    timeout: 120_000, // 2 min
    maxBuffer: MAX_OUTPUT,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const errCode = result.error?.code;

  if (
    errCode === "ETIMEDOUT" ||
    (result.error && result.signal === "SIGTERM")
  ) {
    return {
      passed: false,
      output:
        `[judge infra FAIL] claude timed out after 120s (ETIMEDOUT). ` +
        `stdout=${stdout.length}b stderr=${stderr.length}b\n${stderr}`,
    };
  }
  if (result.error) {
    return {
      passed: false,
      output: `[judge infra FAIL] claude spawn error: ${result.error.message}\n${stderr}`,
    };
  }

  const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
  const firstLine = stdout.trim().split("\n")[0]?.toUpperCase() ?? "";
  const passed =
    result.status === 0 && !result.error && firstLine.startsWith("PASS");
  return { passed, output };
}

export function getGitDiffSinceClaim(
  cwd: string,
  claimedAt: string,
  spawn: SpawnFn = defaultSpawn,
): string {
  // Throws on any failure. doneTask catches and surfaces a judge FAIL with
  // a clear message — we must NEVER feed an empty diff to the LLM (it will
  // typically answer PASS on empty input, silently opening the gate).
  const revList = spawn(
    "git",
    ["rev-list", "-n", "1", `--before=${claimedAt}`, "HEAD"],
    { cwd, timeout: 10_000 },
  );
  if (revList.error)
    throw new Error(`git rev-list failed: ${revList.error.message}`);

  let baseCommit = (revList.stdout ?? "").trim();
  if (!baseCommit) {
    const root = spawn("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd,
      timeout: 10_000,
    });
    if (root.error)
      throw new Error(
        `git rev-list --max-parents=0 failed: ${root.error.message}`,
      );
    baseCommit = (root.stdout ?? "").trim();
    if (!baseCommit) {
      throw new Error("no diff: could not resolve a base commit (empty repo?)");
    }
  }

  const diff = spawn("git", ["diff", baseCommit, "HEAD"], {
    cwd,
    maxBuffer: 1024 * 1024 * 2,
    timeout: 30_000,
  });
  if (diff.error) throw new Error(`git diff failed: ${diff.error.message}`);
  if (typeof diff.status === "number" && diff.status !== 0) {
    throw new Error(
      `git diff exited ${diff.status}: ${(diff.stderr ?? "").trim()}`,
    );
  }

  const out = diff.stdout ?? "";
  if (!out.trim()) {
    throw new Error(
      "no diff: no committed changes since claim (did you forget to commit?)",
    );
  }
  return out;
}

export function rewriteMdTaskStatus(
  tasksPath: string,
  repo: string,
  body: string,
  newStatus: "done" | "pending" | "draft",
  today: string = new Date().toISOString().slice(0, 10),
): boolean {
  // Race-safety: read-modify-write inside the same lockfile + atomic rename
  // pattern used by appendTaskToPending and rewriteMdTaskBody. Without this,
  // two concurrent done/promote calls could each read stale lines and the
  // last writer would silently clobber the other's status flip.
  return withFileLock(tasksPath, () => {
    if (!existsSync(tasksPath)) return false;
    const text = readFileSync(tasksPath, "utf8");
    const { lines, tasks } = parseTasksText(text);
    if (lines.length === 0) return false;
    const target = tasks.find((t) => t.repo === repo && t.body === body);
    if (!target) return false;
    if (newStatus === "done") {
      lines[target.lineIdx] = `- [x] ${today} **${repo}** — ${body}`;
    } else if (newStatus === "draft") {
      lines[target.lineIdx] = `- [?] **${repo}** — ${body}`;
    } else {
      lines[target.lineIdx] = `- [ ] **${repo}** — ${body}`;
    }
    atomicWrite(tasksPath, lines.join("\n"));
    return true;
  });
}

export interface NewTask {
  repo: string;
  body: string;
  verify?: string;
  judge?: string;
  priority?: TaskPriority;
  // ISO-8601 UTC. Must be a canonicalised string (see normalizeScheduledFor).
  scheduledFor?: string;
}

export function buildTaskLines(
  t: NewTask,
  status: "pending" | "draft" = "pending",
): string[] {
  const body = t.body.replace(/\s+/g, " ").trim();
  const mark = status === "draft" ? "?" : " ";
  const out = [`- [${mark}] **${t.repo.trim()}** — ${body}`];
  const verify = t.verify?.trim();
  const judge = t.judge?.trim();
  if (verify) out.push(`  verify: ${verify}`);
  if (judge) out.push(`  judge: ${judge}`);
  // Only emit priority when it's a meaningful deviation from the default, so
  // routine tasks stay one-liners. `scheduled_for` is emitted verbatim if
  // provided — it's a caller promise that the value is already normalised.
  if (t.priority && t.priority !== DEFAULT_PRIORITY) {
    out.push(`  priority: ${t.priority}`);
  }
  if (t.scheduledFor) out.push(`  scheduled_for: ${t.scheduledFor}`);
  return out;
}

export function validateNewTask(t: NewTask): {
  ok: boolean;
  reason?: "body-required" | "repo-required";
} {
  if (!t.repo.trim()) return { ok: false, reason: "repo-required" };
  if (!t.body.trim()) return { ok: false, reason: "body-required" };
  return { ok: true };
}

// Append a new task to the `## Pending` section of TASKS.md.
// Returns the external_id of the new task, or throws if the file has no
// `## Pending` section or validation fails.
//
// Concurrency: guards the read-modify-write with an advisory lockfile
// (O_EXCL create, retry-on-EEXIST) and finalises with a same-fs rename so
// two TUI instances clicking `n` at the same time can't lose a task.
export function appendTaskToPending(
  tasksPath: string,
  t: NewTask,
  status: "pending" | "draft" = "pending",
): string {
  const v = validateNewTask(t);
  if (!v.ok) throw new Error(`invalid task: ${v.reason}`);

  return withFileLock(tasksPath, () => {
    const text = existsSync(tasksPath) ? readFileSync(tasksPath, "utf8") : "";
    const lines = text.split("\n");

    const pendingIdx = lines.findIndex((l) => /^##\s+Pending\s*$/.test(l));
    if (pendingIdx < 0) {
      throw new Error(`could not find "## Pending" section in ${tasksPath}`);
    }

    // Insert point: end of the Pending section (right before the next `## `
    // heading, or end of file).
    let insertAt = lines.length;
    for (let i = pendingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]!)) {
        insertAt = i;
        break;
      }
    }

    // Trim trailing empty lines inside the section so we leave exactly one
    // blank line between existing content and the new entry.
    let tail = insertAt;
    while (tail > pendingIdx + 1 && lines[tail - 1]!.trim() === "") tail--;

    const newLines = buildTaskLines(t, status);
    const block = ["", ...newLines, ""];
    const before = lines.slice(0, tail);
    const after = lines.slice(insertAt);
    const next = [...before, ...block, ...after].join("\n");

    atomicWrite(tasksPath, next);
    return externalId(t.repo.trim(), t.body.replace(/\s+/g, " ").trim());
  });
}

function withFileLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = targetPath + ".lock";
  const deadline = Date.now() + 3000;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        throw new Error(
          `could not acquire lock on ${targetPath}: stale lockfile at ${lockPath}?`,
        );
      }
      // Short busy-wait; this is a UI-driven path, not a hot loop.
      const end = Date.now() + 25;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* lockfile already gone — fine */
    }
  }
}

function atomicWrite(targetPath: string, contents: string): void {
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, targetPath);
}

// ── enrichment ────────────────────────────────────────────────────────────────
//
// enrichTaskBody spawns `claude -p --model opus --dangerously-skip-permissions`
// with the prompt below. The model returns either a clarifying-questions
// response (status stays draft, questions are stored on the task row) or an
// elaborated spec with `verify:` and `judge:` lines (the task body is rewritten
// in TASKS.md and DB, but status stays draft until the user runs `promote`).

export const ENRICH_PROMPT_HEADER = [
  "You are enriching a terse task description into a concrete spec for an autonomous coding agent.",
  "An agent will pick this task with NO chance to ask follow-up questions, so any ambiguity",
  "you paper over with a default WILL produce wrong work. Default-bias is the failure mode.",
  "",
  "DECISION (do this first, before writing anything):",
  "- If the task underspecifies WHERE (which file/repo/dir), WHAT shape (function signature,",
  "  CLI flag, schema, return type), or HOW success is measured — you MUST ask. Ambiguity",
  "  about scope, library choice, naming, or output format also MUST trigger questions.",
  "- Only skip questions if every concrete detail an agent needs to start coding is already",
  "  in the body. When in doubt, ASK — clarifying questions are cheap; wrong work is not.",
  "",
  "FORMAT — exactly one of the two:",
  "",
  "(A) QUESTIONS mode — when ambiguous. Output MUST start with the literal token",
  "    'QUESTIONS:' on the very first line, followed by up to 3 short questions, one per",
  "    line. NO spec, NO verify:, NO judge:, NO prose preamble. Example:",
  "      QUESTIONS:",
  "      1. Which package should host the new helper — `core` or `cli`?",
  "      2. Should errors be thrown, or returned as a Result type?",
  "",
  "(B) SPEC mode — when fully specified. Write a concrete body with acceptance criteria,",
  "    then on the LAST two non-empty lines write EXACTLY (lowercase keys, single space):",
  "      verify: <one mechanical shell command that returns non-zero on failure>",
  "      judge: <semantic PASS/FAIL prompt for an LLM judge that will read the git diff>",
  "    Body goes ABOVE those two lines. Do NOT wrap in markdown fences. Do NOT prepend",
  "    'QUESTIONS:' in this mode.",
  "",
  "TASK BODY (terse, to enrich):",
  "",
].join("\n");

export interface EnrichResult {
  kind: "questions" | "enriched";
  questions?: string;
  body?: string;
  verify?: string;
  judge?: string;
  raw: string;
}

export function parseEnrichResponse(raw: string): EnrichResult {
  const trimmed = raw.trim();
  if (/^QUESTIONS:/i.test(trimmed)) {
    const questions = trimmed.replace(/^QUESTIONS:\s*/i, "").trim();
    return { kind: "questions", questions, raw };
  }
  // Walk lines from the end and pick up the LAST verify: and judge: directives
  // before the first non-directive non-blank line. This tolerates trailing
  // whitespace and lets the body include hyphens / colons safely.
  const lines = trimmed.split("\n");
  let verify: string | undefined;
  let judge: string | undefined;
  let bodyEnd = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (/^\s*$/.test(l)) {
      if (bodyEnd === i + 1) bodyEnd = i;
      continue;
    }
    const vm = l.match(/^\s*verify:\s*(.+?)\s*$/i);
    const jm = l.match(/^\s*judge:\s*(.+?)\s*$/i);
    if (vm && verify === undefined) {
      verify = vm[1];
      if (bodyEnd === i + 1) bodyEnd = i;
      continue;
    }
    if (jm && judge === undefined) {
      judge = jm[1];
      if (bodyEnd === i + 1) bodyEnd = i;
      continue;
    }
    break;
  }
  const body = lines.slice(0, bodyEnd).join("\n").replace(/\s+/g, " ").trim();
  return { kind: "enriched", body, verify, judge, raw };
}

export function enrichTaskBody(
  taskBody: string,
  cwd: string,
  spawn: SpawnFn = defaultSpawn,
): EnrichResult {
  const MAX_OUTPUT = 1024 * 1024 * 4;
  const prompt = `${ENRICH_PROMPT_HEADER}${taskBody}\n`;
  const result = spawn(
    "claude",
    ["-p", "--model", "opus", "--dangerously-skip-permissions"],
    {
      cwd,
      input: prompt,
      timeout: 300_000,
      maxBuffer: MAX_OUTPUT,
    },
  );
  if (result.error) {
    throw new Error(`enrich spawn error: ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `enrich claude exited ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  }
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    throw new Error("enrich produced empty response");
  }
  return parseEnrichResponse(stdout);
}

// Rewrite a single task line in TASKS.md, replacing its body and inserting
// fresh `verify:`/`judge:` directives directly below it. Surrounding lines —
// HTML comments, code fences, neighbouring tasks — are preserved verbatim.
// Atomic: same lockfile + tmp+rename pattern used by appendTaskToPending.
export function rewriteMdTaskBody(
  tasksPath: string,
  repo: string,
  oldBody: string,
  newBody: string,
  newVerify: string | undefined,
  newJudge: string | undefined,
  status: "pending" | "draft" = "draft",
): boolean {
  return withFileLock(tasksPath, () => {
    if (!existsSync(tasksPath)) return false;
    const text = readFileSync(tasksPath, "utf8");
    const { lines, tasks } = parseTasksText(text);
    const target = tasks.find((t) => t.repo === repo && t.body === oldBody);
    if (!target) return false;

    const mark = status === "draft" ? "?" : " ";
    const cleanBody = newBody.replace(/\s+/g, " ").trim();
    const replacement = [`- [${mark}] **${repo}** — ${cleanBody}`];
    if (newVerify?.trim()) replacement.push(`  verify: ${newVerify.trim()}`);
    if (newJudge?.trim()) replacement.push(`  judge: ${newJudge.trim()}`);

    // Replace the existing task line plus any contiguous indented `verify:`
    // / `judge:` directives that immediately follow. Stop at the first line
    // that is not blank-or-directive (so prose paragraphs in a long task
    // body are NOT clobbered).
    let endIdx = target.lineIdx + 1;
    while (endIdx < lines.length) {
      const l = lines[endIdx]!;
      if (/^\s+(verify|judge):/i.test(l)) {
        endIdx++;
        continue;
      }
      break;
    }

    const next = [
      ...lines.slice(0, target.lineIdx),
      ...replacement,
      ...lines.slice(endIdx),
    ].join("\n");
    atomicWrite(tasksPath, next);
    return true;
  });
}

export type EnrichApplyResult =
  | { kind: "questions"; questions: string }
  | { kind: "enriched"; oldExternalId: string; newExternalId: string };

// applyEnrichment is the DB-side half of `batonq enrich <id>`. It looks up the
// draft task by external_id and either records clarifying questions (status
// stays draft) or rewrites body + verify_cmd + judge_cmd in BOTH the DB and
// TASKS.md. Status stays draft in both cases — promote is a separate step.
export function applyEnrichment(
  db: Database,
  tasksPath: string,
  externalIdLookup: string,
  result: EnrichResult,
  nowIso: string = new Date().toISOString(),
): EnrichApplyResult {
  const row = db
    .query("SELECT * FROM tasks WHERE external_id = ?")
    .get(externalIdLookup) as any;
  if (!row) throw new Error(`no task with external_id ${externalIdLookup}`);
  if (row.status !== "draft") {
    throw new Error(
      `task ${externalIdLookup} is ${row.status}, can only enrich drafts`,
    );
  }

  if (result.kind === "questions") {
    db.run(`UPDATE tasks SET enrich_questions = ? WHERE external_id = ?`, [
      result.questions ?? "",
      externalIdLookup,
    ]);
    return { kind: "questions", questions: result.questions ?? "" };
  }

  const newBody = (result.body ?? "").trim();
  if (!newBody) {
    throw new Error("enrichment returned empty body");
  }
  const newEid = externalId(row.repo, newBody);
  const verify = result.verify?.trim() || null;
  const judge = result.judge?.trim() || null;
  // Snapshot original_body on the first mutation so the TUI hybrid view can
  // still surface the user's initial terse description alongside the enriched
  // spec. If it's already set (e.g. via appendClarifyingAnswers earlier), we
  // keep that one — that's the truly-original user input, not the Q&A-appended
  // intermediate.
  const originalBody = row.original_body ?? row.body;

  // Update DB row first (in a transaction). external_id may shift because
  // body changed; UNIQUE collisions throw and we surface them clearly.
  db.exec("BEGIN");
  try {
    db.run(
      `UPDATE tasks SET body = ?, external_id = ?, verify_cmd = ?, judge_cmd = ?, enrich_questions = NULL, original_body = ? WHERE id = ?`,
      [newBody, newEid, verify, judge, originalBody, row.id],
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // Then rewrite TASKS.md (atomic rename) so the on-disk source-of-truth
  // matches the DB. If this fails the DB row already moved — caller should
  // surface and let the user re-run enrich or fix by hand.
  rewriteMdTaskBody(
    tasksPath,
    row.repo,
    row.body,
    newBody,
    verify ?? undefined,
    judge ?? undefined,
    "draft",
  );
  void nowIso;
  return {
    kind: "enriched",
    oldExternalId: externalIdLookup,
    newExternalId: newEid,
  };
}

export interface ClarifyingAnswer {
  question: string;
  answer: string;
}

// Append the clarifying Q&A pairs the user typed in the TUI overlay to the
// draft body, clear enrich_questions, and snapshot original_body on first
// mutation. Used by the TUI after the user answers a QUESTIONS: response —
// the caller then re-runs `batonq enrich <newEid>` so opus can re-try with
// the extra context.
//
// Returns the new external_id (body changed, so the id is rederived).
export function appendClarifyingAnswers(
  db: Database,
  tasksPath: string,
  externalIdLookup: string,
  qa: ClarifyingAnswer[],
): { oldExternalId: string; newExternalId: string } {
  const row = db
    .query("SELECT * FROM tasks WHERE external_id = ?")
    .get(externalIdLookup) as any;
  if (!row) throw new Error(`no task with external_id ${externalIdLookup}`);
  if (row.status !== "draft") {
    throw new Error(
      `task ${externalIdLookup} is ${row.status}, can only answer drafts`,
    );
  }
  if (qa.length === 0) {
    throw new Error("no clarifying answers supplied");
  }

  const originalBody = row.original_body ?? row.body;
  const block = qa
    .map(({ question, answer }) => `- ${question.trim()}\n  ${answer.trim()}`)
    .join("\n");
  const newBody = `${row.body} [clarifications: ${block.replace(/\n+/g, " ")}]`;
  const newEid = externalId(row.repo, newBody);

  db.exec("BEGIN");
  try {
    db.run(
      `UPDATE tasks SET body = ?, external_id = ?, enrich_questions = NULL, original_body = ? WHERE id = ?`,
      [newBody, newEid, originalBody, row.id],
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  rewriteMdTaskBody(
    tasksPath,
    row.repo,
    row.body,
    newBody,
    row.verify_cmd ?? undefined,
    row.judge_cmd ?? undefined,
    "draft",
  );

  return { oldExternalId: externalIdLookup, newExternalId: newEid };
}

// Flip a draft to pending in BOTH DB and TASKS.md. Returns false (no-op) if
// the task is not draft (already pending / claimed / done) — pick will then
// see it on the next sync.
export function promoteDraftToPending(
  db: Database,
  tasksPath: string,
  externalIdLookup: string,
): boolean {
  const row = db
    .query("SELECT * FROM tasks WHERE external_id = ?")
    .get(externalIdLookup) as any;
  if (!row) throw new Error(`no task with external_id ${externalIdLookup}`);
  if (row.status !== "draft") return false;
  db.run(`UPDATE tasks SET status = 'pending' WHERE external_id = ?`, [
    externalIdLookup,
  ]);
  rewriteMdTaskStatus(tasksPath, row.repo, row.body, "pending");
  return true;
}

// ── DB-first task input ───────────────────────────────────────────────────────
//
// Everything below this line treats the DB as the single source of truth for
// tasks. TASKS.md is reduced to an optional one-way input (via `batonq import`
// or the legacy `batonq sync-tasks`) and an optional read-only snapshot (via
// `batonq export --md`). These helpers power `batonq add`, `batonq import`,
// and `batonq export`.

export type TaskAgent = "claude" | "codex" | "gemini" | "opencode" | "any";
export const DEFAULT_AGENT: TaskAgent = "any";

export interface TaskInput {
  repo: string;
  body: string;
  priority?: TaskPriority;
  scheduledFor?: string;
  verify?: string;
  judge?: string;
  status?: TaskStatus;
  agent?: TaskAgent;
  // Freeform model nickname (`opus`, `haiku`, `flash`, …) parsed from
  // `@model:` annotations or set explicitly via JSON import. Resolved by
  // the runner at dispatch time.
  model?: string;
  // Per-task role identity. Selects which SKILL.md the runner injects.
  role?: AgentRole;
}

// Raised from insertTask when the computed external_id already exists. Carries
// the offending id so callers (import, add) can surface a helpful message.
export class DuplicateExternalIdError extends Error {
  readonly code = "DUPLICATE_EID";
  constructor(public readonly externalId: string) {
    super(`duplicate external_id: ${externalId}`);
  }
}

// Direct DB insert. Whitespace-normalises body, derives external_id, and
// rejects duplicates with DuplicateExternalIdError. Callers that want Zod
// validation should use validatedInsertTask.
export function insertTask(
  db: Database,
  t: TaskInput,
  nowIso: string = new Date().toISOString(),
): string {
  const body = t.body.replace(/\s+/g, " ").trim();
  const repo = t.repo.trim();
  const eid = externalId(repo, body);
  const existing = db
    .query("SELECT external_id FROM tasks WHERE external_id = ?")
    .get(eid);
  if (existing) throw new DuplicateExternalIdError(eid);
  const status = t.status ?? "pending";
  const priority = t.priority ?? DEFAULT_PRIORITY;
  const scheduledFor = t.scheduledFor ?? null;
  const agent = t.agent ?? DEFAULT_AGENT;
  const model = t.model ?? null;
  const role: AgentRole = t.role ?? "worker";
  db.run(
    `INSERT INTO tasks (external_id, repo, body, status, created_at, verify_cmd, judge_cmd, priority, scheduled_for, agent, model, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eid,
      repo,
      body,
      status,
      nowIso,
      t.verify ?? null,
      t.judge ?? null,
      priority,
      scheduledFor,
      agent,
      model,
      role,
    ],
  );
  return eid;
}

// Import an arbitrary plain object, fill in derivable defaults (external_id,
// priority, status), validate via the strict Zod schema in task-schema.ts,
// then insert. Throws ZodError on validation failure, DuplicateExternalIdError
// on id collision. Caller is expected to convert those into exit codes /
// log lines.
export function validatedInsertTask(
  db: Database,
  raw: unknown,
  nowIso: string = new Date().toISOString(),
): string {
  // Lazy require so tasks-core doesn't create a hard dep cycle at module
  // parse time; task-schema already imports `zod`, and we only need these
  // symbols inside the function body.
  const { parseTaskInput } = require("./task-schema");

  const input: Record<string, unknown> = {
    ...(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}),
  };
  const repo =
    typeof input.repo === "string" ? (input.repo as string).trim() : "";
  const rawBody =
    typeof input.body === "string"
      ? (input.body as string).replace(/\s+/g, " ").trim()
      : "";

  // Extract `@agent:` / `@model:` annotations from the body so a user typing
  // `batonq add --body "fix bug @agent:gemini"` sees the same routing as if
  // they'd written it on a TASKS.md line. Explicit fields beat annotations:
  // `--agent claude` on a body containing `@agent:gemini` wins for claude
  // (the body is still cleaned).
  const annotated = extractAnnotations(rawBody);
  const body = annotated.body;
  if (!input.agent && annotated.agent) input.agent = annotated.agent;
  if (!input.model && annotated.model) input.model = annotated.model;
  if (!input.role && annotated.role) input.role = annotated.role;

  input.repo = repo;
  input.body = body;
  if (!input.external_id) input.external_id = externalId(repo, body);
  if (!input.status) input.status = "pending";
  if (!input.priority) input.priority = DEFAULT_PRIORITY;
  if (!input.agent) input.agent = DEFAULT_AGENT;
  if (!input.role) input.role = "worker";

  // Canonicalise scheduled_for so lexicographic comparison in pick works.
  // If normaliser returns null we leave the raw value alone — Zod will
  // reject it with a clean error, which is what we want.
  if (typeof input.scheduled_for === "string") {
    const norm = normalizeScheduledFor(input.scheduled_for as string);
    if (norm) input.scheduled_for = norm;
  }

  parseTaskInput(input);

  return insertTask(
    db,
    {
      repo,
      body,
      priority: input.priority as TaskPriority,
      scheduledFor:
        typeof input.scheduled_for === "string"
          ? (input.scheduled_for as string)
          : undefined,
      verify:
        typeof input.verify === "string" ? (input.verify as string) : undefined,
      judge:
        typeof input.judge === "string" ? (input.judge as string) : undefined,
      status: input.status as TaskStatus,
      agent: input.agent as TaskAgent,
      model: typeof input.model === "string" ? input.model : undefined,
      role: input.role as AgentRole,
    },
    nowIso,
  );
}

// ── TASKS.md deprecation header ───────────────────────────────────────────────

export const TASKS_MD_DEPRECATION_MARKER =
  "DEPRECATED — this file is no longer authoritative";

export const TASKS_MD_DEPRECATION_HEADER = `> ⚠️ ${TASKS_MD_DEPRECATION_MARKER}. Use 'batonq add' or 'batonq import <file>'. May drift from DB.`;

// Prepend the deprecation notice to TASKS.md once. Idempotent: a second call
// is a no-op once the marker is present. Does nothing if the file doesn't
// exist (the queue works fine without it now that the DB is authoritative).
export function ensureTasksMdDeprecationHeader(tasksPath: string): boolean {
  if (!existsSync(tasksPath)) return false;
  const text = readFileSync(tasksPath, "utf8");
  if (text.includes(TASKS_MD_DEPRECATION_MARKER)) return false;
  return withFileLock(tasksPath, () => {
    const latest = readFileSync(tasksPath, "utf8");
    if (latest.includes(TASKS_MD_DEPRECATION_MARKER)) return false;
    const next = `${TASKS_MD_DEPRECATION_HEADER}\n\n${latest}`;
    atomicWrite(tasksPath, next);
    return true;
  });
}

// ── import ────────────────────────────────────────────────────────────────────

export interface ImportParseResult {
  tasks: unknown[];
  format: "yaml" | "markdown";
}

// Parse a YAML payload into a bare array of task objects. Accepts either a
// top-level array or a `{ tasks: [...] }` wrapper.
export function parseYamlTasksText(text: string): unknown[] {
  // Bun.YAML.parse is the built-in parser; it throws SyntaxError on bad input.
  const parsed = (globalThis as any).Bun?.YAML?.parse
    ? (globalThis as any).Bun.YAML.parse(text)
    : null;
  if (parsed == null) {
    throw new Error("YAML parser unavailable (Bun.YAML.parse is required)");
  }
  if (Array.isArray(parsed)) return parsed as unknown[];
  if (parsed && typeof parsed === "object") {
    const tasks = (parsed as Record<string, unknown>).tasks;
    if (Array.isArray(tasks)) return tasks as unknown[];
  }
  throw new Error(
    "YAML must be an array of tasks or an object with a top-level `tasks:` array",
  );
}

// Convert the existing markdown parser output into TaskInput-shaped objects
// suitable for validatedInsertTask. Skips `done` rows (no point re-inserting
// them) and maps `claimed` back to `pending` so the import doesn't resurrect
// another session's claim state.
export function parseMarkdownTasksForImport(text: string): TaskInput[] {
  const { tasks } = parseTasksText(text);
  const out: TaskInput[] = [];
  for (const t of tasks) {
    if (t.status === "done") continue;
    const status: TaskStatus = t.status === "claimed" ? "pending" : t.status;
    out.push({
      repo: t.repo,
      body: t.body,
      verify: t.verifyCmd,
      judge: t.judgeCmd,
      priority: t.priority,
      scheduledFor: t.scheduledFor,
      status,
      agent: t.agent as TaskAgent | undefined,
      model: t.model,
      role: t.role,
    });
  }
  return out;
}

// Shallow sniff of file contents: YAML files typically start with `-` (array)
// or `key:`. Markdown tasks start with a `- [ ]` / `- [x]` / `## ` block.
// Falls back to the file extension when the content is ambiguous.
export function detectImportFormat(
  path: string,
  text: string,
): "yaml" | "markdown" {
  if (/\.ya?ml$/i.test(path)) return "yaml";
  if (/\.md$/i.test(path)) return "markdown";
  // Markdown headers or task checklists win over YAML.
  if (/^\s*#{1,6}\s/m.test(text)) return "markdown";
  if (/^\s*-\s+\[[ x~?]\]\s/m.test(text)) return "markdown";
  return "yaml";
}

export interface ImportReport {
  imported: number;
  invalid: number;
  duplicates: number;
  logLines: string[];
  validExternalIds: string[];
}

// Run a full import over pre-parsed raw task objects. Pure function — no FS
// writes, caller persists the log. Used by `batonq import` and exercised
// directly in tests without spawning the CLI.
export function runImport(
  db: Database,
  raws: unknown[],
  nowIso: string = new Date().toISOString(),
): ImportReport {
  const { ZodError } = require("zod") as typeof import("zod");
  const report: ImportReport = {
    imported: 0,
    invalid: 0,
    duplicates: 0,
    logLines: [],
    validExternalIds: [],
  };
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    try {
      const eid = validatedInsertTask(db, raw, nowIso);
      report.imported++;
      report.validExternalIds.push(eid);
    } catch (e) {
      if (e instanceof DuplicateExternalIdError) {
        report.duplicates++;
        report.logLines.push(
          `entry ${i}: duplicate external_id=${e.externalId}; skipped`,
        );
        continue;
      }
      if (e instanceof ZodError) {
        report.invalid++;
        const issues = e.issues
          .map(
            (iss: any) => `${iss.path.join(".") || "(root)"}: ${iss.message}`,
          )
          .join("; ");
        report.logLines.push(
          `entry ${i}: schema invalid — ${issues}\n  raw: ${safeJson(raw)}`,
        );
        continue;
      }
      report.invalid++;
      const msg = (e as any)?.message ?? String(e);
      report.logLines.push(`entry ${i}: ${msg}\n  raw: ${safeJson(raw)}`);
    }
  }
  return report;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── export ────────────────────────────────────────────────────────────────────

export const EXPORT_SNAPSHOT_HEADER =
  "# Snapshot — read-only, regenerate with 'batonq export'";

interface ExportRow {
  external_id: string;
  repo: string;
  body: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  scheduled_for: string | null;
  verify_cmd: string | null;
  judge_cmd: string | null;
  completed_at: string | null;
}

function renderExportTask(r: ExportRow): string {
  const mark =
    r.status === "done"
      ? "x"
      : r.status === "draft"
        ? "?"
        : r.status === "claimed"
          ? "~"
          : " ";
  const datePrefix =
    r.status === "done" && r.completed_at
      ? `${r.completed_at.slice(0, 10)} `
      : "";
  const body = r.body.replace(/\s+/g, " ").trim();
  const lines = [`- [${mark}] ${datePrefix}**${r.repo}** — ${body}`];
  if (r.verify_cmd) lines.push(`  verify: ${r.verify_cmd}`);
  if (r.judge_cmd) lines.push(`  judge: ${r.judge_cmd}`);
  if (r.priority && r.priority !== DEFAULT_PRIORITY) {
    lines.push(`  priority: ${r.priority}`);
  }
  if (r.scheduled_for) lines.push(`  scheduled_for: ${r.scheduled_for}`);
  return lines.join("\n");
}

// Snapshot every task in the DB as markdown. Produces a header that warns
// readers the file is read-only, then one section per status bucket in pick
// order so the file is useful as documentation + a regeneration target.
export function exportTasksAsMarkdown(
  db: Database,
  nowIso: string = new Date().toISOString(),
): string {
  const sections: string[] = [
    EXPORT_SNAPSHOT_HEADER,
    "",
    `Generated: ${nowIso}`,
    "",
  ];
  const buckets: Array<[TaskStatus, string, string]> = [
    [
      "pending",
      "Pending",
      `SELECT external_id, repo, body, status, priority, scheduled_for, verify_cmd, judge_cmd, completed_at
       FROM tasks WHERE status = 'pending'
       ORDER BY
         CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC,
         COALESCE(scheduled_for, created_at) ASC,
         created_at ASC`,
    ],
    [
      "draft",
      "Drafts",
      `SELECT external_id, repo, body, status, priority, scheduled_for, verify_cmd, judge_cmd, completed_at
       FROM tasks WHERE status = 'draft' ORDER BY created_at ASC`,
    ],
    [
      "claimed",
      "Claimed",
      `SELECT external_id, repo, body, status, priority, scheduled_for, verify_cmd, judge_cmd, completed_at
       FROM tasks WHERE status = 'claimed' ORDER BY claimed_at ASC`,
    ],
    [
      "done",
      "Done",
      `SELECT external_id, repo, body, status, priority, scheduled_for, verify_cmd, judge_cmd, completed_at
       FROM tasks WHERE status = 'done' ORDER BY completed_at DESC`,
    ],
    [
      "lost",
      "Lost",
      `SELECT external_id, repo, body, status, priority, scheduled_for, verify_cmd, judge_cmd, completed_at
       FROM tasks WHERE status = 'lost' ORDER BY created_at DESC`,
    ],
  ];
  let wroteAny = false;
  for (const [, label, sql] of buckets) {
    const rows = db.query(sql).all() as ExportRow[];
    if (rows.length === 0) continue;
    wroteAny = true;
    sections.push(`## ${label}`, "");
    for (const r of rows) sections.push(renderExportTask(r));
    sections.push("");
  }
  // Empty DB: still emit a Pending section so downstream sync-tasks doesn't
  // choke on a file without headings.
  if (!wroteAny) sections.push("## Pending", "");
  return sections.join("\n") + "\n";
}
