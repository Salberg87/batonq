// tasks-core — pure functions for TASKS.md parsing, syncing, picking, and verifying.
// Extracted from agent-coord so they can be exercised by tests against an in-memory DB
// and a fixture TASKS.md, with no dependency on ~/.claude state.

import { Database } from "bun:sqlite";
import {
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

export type TaskStatus = "draft" | "pending" | "claimed" | "done";

export interface ParsedTask {
  repo: string;
  body: string;
  status: TaskStatus;
  lineIdx: number;
  verifyCmd?: string;
  judgeCmd?: string;
}

// `?` marks a draft task — TUI-created tasks land here until enrichment +
// `batonq promote` flips them to pending so `pick` will see them.
const TASK_RE =
  /^- \[([ x~?])\] (?:\d{4}-\d{2}-\d{2} )?\*\*([^*]+)\*\*\s*[—–-]+\s*(.+?)(?:\s*\([^)]*\))?$/;
const VERIFY_RE = /^\s+verify:\s*(.+?)\s*$/;
const JUDGE_RE = /^\s+judge:\s*(.+?)\s*$/;

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
      current = {
        repo: m[2]!.trim(),
        body: m[3]!.trim(),
        status,
        lineIdx: i,
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
      if (jm) current.judgeCmd = jm[1];
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
      enrich_questions TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_repo_status ON tasks(repo, status);
  `);
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
    // Map MD status → DB status. `claimed` in MD is treated as pending on
    // insert (DB owns claim state); draft and done pass through verbatim.
    const insertStatus =
      t.status === "done" ? "done" : t.status === "draft" ? "draft" : "pending";
    if (!existing) {
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, verify_cmd, judge_cmd) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [eid, t.repo, t.body, insertStatus, nowIso, verify, judge],
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
    }
  }
  return { added, completed, parsed: parsed.length };
}

export interface PickOptions {
  repo: string | null;
  any?: boolean;
}

// Pickable status is `pending` only — drafts (status='draft') are intentionally
// excluded so an autonomous agent never claims a task whose intent has not
// been enriched and human-approved via `batonq promote`. Do NOT broaden this
// filter to `status != 'done'` or similar — that would silently re-open the
// queue to drafts. See test "selectCandidate skips drafts" in core.test.ts.
export function selectCandidate(db: Database, opts: PickOptions): any {
  const { repo, any } = opts;
  if (any) {
    return db
      .query(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY id LIMIT 1`)
      .get();
  }
  if (repo) {
    return db
      .query(
        `SELECT * FROM tasks WHERE status = 'pending' AND (repo = ? OR repo LIKE 'any:%') ORDER BY id LIMIT 1`,
      )
      .get(repo);
  }
  return db
    .query(
      `SELECT * FROM tasks WHERE status = 'pending' AND repo LIKE 'any:%' ORDER BY id LIMIT 1`,
    )
    .get();
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

export interface VerifyResult {
  code: number;
  output: string;
}

export function runVerify(
  cmd: string,
  cwd: string,
  taskId: string,
): VerifyResult {
  const MAX_OUTPUT = 1024 * 1024 * 4;
  const result = spawnSync("/bin/sh", ["-c", cmd], {
    cwd,
    env: {
      ...process.env,
      AGENT_COORD_REPO_ROOT: cwd,
      AGENT_COORD_TASK_ID: taskId,
    },
    timeout: 300_000,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
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

  // Update DB row first (in a transaction). external_id may shift because
  // body changed; UNIQUE collisions throw and we surface them clearly.
  db.exec("BEGIN");
  try {
    db.run(
      `UPDATE tasks SET body = ?, external_id = ?, verify_cmd = ?, judge_cmd = ?, enrich_questions = NULL WHERE id = ?`,
      [newBody, newEid, verify, judge, row.id],
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
