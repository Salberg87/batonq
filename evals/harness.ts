// Micro-eval harness for batonq.
//
// For each task JSON under `tasks/`, copy the referenced fixture into a
// tmpdir, run `claude -p` once as baseline and once with batonq gates (if
// configured), then run verify_cmd + judge, and append a JSONL row to
// results/<timestamp>.jsonl. This file exports pure helpers so the test
// suite can drive it with a mock claude. Running it end-to-end against a
// real claude binary is intentionally out of scope for CI — invoke it
// manually via `bun run evals/harness.ts`.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type Task = {
  id: string;
  repo_fixture_path: string;
  prompt: string;
  verify_cmd: string;
  judge_prompt: string;
};

export type Variant = "baseline" | "batonq";

export type RunResult = {
  task_id: string;
  variant: Variant;
  pass_verify: boolean;
  pass_judge: boolean;
  wall_clock_ms: number;
  files_edited: number;
  commits: number;
  ts: string;
};

export type SpawnClaudeInput = {
  cwd: string;
  prompt: string;
  variant: Variant;
};

export type SpawnClaudeResult = {
  // The agent's stdout, used only for debugging — we do not parse it.
  stdout: string;
  exitCode: number;
  // File paths (relative to cwd) the agent claims to have edited. The
  // default real spawner leaves this empty and the harness falls back to
  // `git status --porcelain` to count edits.
  edited?: string[];
};

export type SpawnClaude = (input: SpawnClaudeInput) => SpawnClaudeResult;

export type JudgeInput = {
  cwd: string;
  prompt: string;
  diff: string;
};

export type JudgeResult = { pass: boolean; reason: string };

export type Judge = (input: JudgeInput) => JudgeResult;

export function loadTasks(tasksDir: string): Task[] {
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(tasksDir, f), "utf8")) as Task);
}

export function prepareWorkspace(fixtureDir: string): string {
  if (!existsSync(fixtureDir)) {
    throw new Error(`fixture not found: ${fixtureDir}`);
  }
  const workdir = mkdtempSync(join(tmpdir(), "batonq-eval-"));
  cpSync(fixtureDir, workdir, { recursive: true });
  // Initialize a throwaway git repo so we can count commits/diffs.
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: workdir });
  spawnSync("git", ["add", "-A"], { cwd: workdir });
  spawnSync(
    "git",
    [
      "-c",
      "user.email=eval@batonq",
      "-c",
      "user.name=eval",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: workdir },
  );
  return workdir;
}

export function countEditedFiles(cwd: string): number {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.trim().length > 0).length;
}

export function countNewCommits(cwd: string): number {
  // We committed the fixture once; anything beyond HEAD~1 is the agent's.
  const r = spawnSync("git", ["rev-list", "--count", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return 0;
  const n = parseInt(r.stdout.trim(), 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, n - 1);
}

export function collectDiff(cwd: string): string {
  const r = spawnSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

export function runVerify(cwd: string, cmd: string): boolean {
  const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  return r.status === 0;
}

export async function runTask(
  task: Task,
  variant: Variant,
  opts: {
    evalsRoot: string;
    spawnClaude: SpawnClaude;
    judge: Judge;
    keepWorkdir?: boolean;
  },
): Promise<RunResult> {
  const fixtureDir = resolve(opts.evalsRoot, task.repo_fixture_path);
  const cwd = prepareWorkspace(fixtureDir);
  const start = Date.now();
  try {
    opts.spawnClaude({ cwd, prompt: task.prompt, variant });
    const wall_clock_ms = Date.now() - start;
    const pass_verify = runVerify(cwd, task.verify_cmd);
    const diff = collectDiff(cwd);
    const judged = opts.judge({ cwd, prompt: task.judge_prompt, diff });
    return {
      task_id: task.id,
      variant,
      pass_verify,
      pass_judge: judged.pass,
      wall_clock_ms,
      files_edited: countEditedFiles(cwd),
      commits: countNewCommits(cwd),
      ts: new Date().toISOString(),
    };
  } finally {
    if (!opts.keepWorkdir) rmSync(cwd, { recursive: true, force: true });
  }
}

export function appendResult(resultsFile: string, result: RunResult): void {
  mkdirSync(dirname(resultsFile), { recursive: true });
  appendFileSync(resultsFile, JSON.stringify(result) + "\n");
}

export function resultsFileFor(resultsDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(resultsDir, `${stamp}.jsonl`);
}

// --- Default real-world spawners (only used when harness is run directly) ---

const defaultSpawnClaude: SpawnClaude = ({ cwd, prompt, variant }) => {
  // Real invocation is intentionally minimal — gates come from the user's
  // shell env when `variant === "batonq"`. We don't try to orchestrate
  // batonq from here.
  const env = { ...process.env };
  if (variant === "baseline") env.BATONQ_DISABLE = "1";
  const r = spawnSync("claude", ["-p", prompt], { cwd, encoding: "utf8", env });
  return {
    stdout: r.stdout ?? "",
    exitCode: r.status ?? 1,
  };
};

const defaultJudge: Judge = ({ diff }) => {
  // No real LLM here — if the diff is non-empty we let verify decide.
  // Replace with an actual judge call when integrating upstream.
  return {
    pass: diff.trim().length > 0,
    reason: "default judge: non-empty diff",
  };
};

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const tasksDir = join(here, "tasks");
  const resultsDir = join(here, "results");
  const tasks = loadTasks(tasksDir);
  const file = resultsFileFor(resultsDir);
  const onlyVariant = (
    argv.find((a) => a.startsWith("--variant=")) ?? ""
  ).split("=")[1];
  const variants: Variant[] = onlyVariant
    ? [onlyVariant as Variant]
    : ["baseline", "batonq"];
  for (const task of tasks) {
    for (const variant of variants) {
      const result = await runTask(task, variant, {
        evalsRoot: here,
        spawnClaude: defaultSpawnClaude,
        judge: defaultJudge,
      });
      appendResult(file, result);
      console.log(
        `${task.id} [${variant}] verify=${result.pass_verify} judge=${result.pass_judge} ${result.wall_clock_ms}ms`,
      );
    }
  }
  console.log(`\nwrote ${file}`);
}

if (import.meta.main) {
  await main();
}
