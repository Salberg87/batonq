// tasks-core — pure functions for TASKS.md parsing, syncing, picking, and verifying.
// Extracted from agent-coord so they can be exercised by tests against an in-memory DB
// and a fixture TASKS.md, with no dependency on ~/.claude state.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface ParsedTask {
  repo: string;
  body: string;
  status: "pending" | "claimed" | "done";
  lineIdx: number;
  verifyCmd?: string;
  judgeCmd?: string;
}

const TASK_RE =
  /^- \[([ x~])\] (?:\d{4}-\d{2}-\d{2} )?\*\*([^*]+)\*\*\s*[—–-]+\s*(.+?)(?:\s*\([^)]*\))?$/;
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
  const lines = text.split("\n");
  const tasks: ParsedTask[] = [];
  let inHtmlComment = false;
  let inCodeFence = false;
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
    if (!m) continue;
    const status: ParsedTask["status"] =
      m[1] === " " ? "pending" : m[1] === "~" ? "claimed" : "done";
    let verifyCmd: string | undefined;
    let judgeCmd: string | undefined;
    const nextIdx = i + 1;
    if (nextIdx < lines.length) {
      const vm = lines[nextIdx]!.match(VERIFY_RE);
      if (vm) verifyCmd = vm[1];
      else {
        const jm = lines[nextIdx]!.match(JUDGE_RE);
        if (jm) judgeCmd = jm[1];
      }
    }
    if (nextIdx + 1 < lines.length && verifyCmd) {
      const jm = lines[nextIdx + 1]!.match(JUDGE_RE);
      if (jm) judgeCmd = jm[1];
    }
    tasks.push({
      repo: m[2]!.trim(),
      body: m[3]!.trim(),
      status,
      lineIdx: i,
      verifyCmd,
      judgeCmd,
    });
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
      judge_ran_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_repo_status ON tasks(repo, status);
  `);
  // Migration for pre-existing DBs that lack verify_* and judge_* columns
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
    if (!existing) {
      db.run(
        `INSERT INTO tasks (external_id, repo, body, status, created_at, verify_cmd, judge_cmd) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          eid,
          t.repo,
          t.body,
          t.status === "done" ? "done" : "pending",
          nowIso,
          verify,
          judge,
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
  newStatus: "done" | "pending",
  today: string = new Date().toISOString().slice(0, 10),
): boolean {
  const { lines, tasks } = parseTasksFile(tasksPath);
  if (lines.length === 0) return false;
  const target = tasks.find((t) => t.repo === repo && t.body === body);
  if (!target) return false;
  if (newStatus === "done") {
    lines[target.lineIdx] = `- [x] ${today} **${repo}** — ${body}`;
  } else {
    lines[target.lineIdx] = `- [ ] **${repo}** — ${body}`;
  }
  writeFileSync(tasksPath, lines.join("\n"));
  return true;
}

export interface NewTask {
  repo: string;
  body: string;
  verify?: string;
  judge?: string;
}

export function buildTaskLines(t: NewTask): string[] {
  const body = t.body.replace(/\s+/g, " ").trim();
  const out = [`- [ ] **${t.repo.trim()}** — ${body}`];
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
export function appendTaskToPending(tasksPath: string, t: NewTask): string {
  const v = validateNewTask(t);
  if (!v.ok) throw new Error(`invalid task: ${v.reason}`);

  const text = existsSync(tasksPath) ? readFileSync(tasksPath, "utf8") : "";
  const lines = text.split("\n");

  // Locate "## Pending" header.
  const pendingIdx = lines.findIndex((l) => /^##\s+Pending\s*$/.test(l));
  if (pendingIdx < 0) {
    throw new Error(`could not find "## Pending" section in ${tasksPath}`);
  }

  // Insert point: end of the Pending section (right before the next `## `
  // heading, or end of file). Walk forward from pendingIdx+1.
  let insertAt = lines.length;
  for (let i = pendingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      insertAt = i;
      break;
    }
  }

  // Trim trailing empty lines inside the section, then ensure exactly one
  // blank line separates existing content from the new entry.
  let tail = insertAt;
  while (tail > pendingIdx + 1 && lines[tail - 1]!.trim() === "") tail--;

  const newLines = buildTaskLines(t);
  const block = ["", ...newLines, ""];
  const before = lines.slice(0, tail);
  const after = lines.slice(insertAt);
  writeFileSync(tasksPath, [...before, ...block, ...after].join("\n"));

  return externalId(t.repo.trim(), t.body.replace(/\s+/g, " ").trim());
}
