// Drives the harness with a mock claude that physically edits the fixture,
// so we can verify the full pipeline (prepare → spawn → verify → write
// JSONL) without depending on a real agent. Runs in CI via `bun test`.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  appendResult,
  loadTasks,
  resultsFileFor,
  runTask,
  type Judge,
  type SpawnClaude,
  type Task,
} from "./harness";

const here = dirname(fileURLToPath(import.meta.url));

describe("harness", () => {
  test("loadTasks returns all 5 task JSONs sorted", () => {
    const tasks = loadTasks(join(here, "tasks"));
    expect(tasks.length).toBe(5);
    expect(tasks.map((t) => t.id)).toEqual([
      "001-null-deref-remove",
      "002-off-by-one-list",
      "003-missing-validation-add",
      "004-exit-code-unknown",
      "005-async-race-save",
    ]);
    for (const t of tasks) {
      expect(t.repo_fixture_path).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.verify_cmd).toBeTruthy();
      expect(t.judge_prompt).toBeTruthy();
    }
  });

  test("runTask with a mock claude produces a JSONL row that roundtrips", async () => {
    // Mock agent: "fixes" bug 002 by rewriting the loop bound.
    const mockClaude: SpawnClaude = ({ cwd }) => {
      const file = join(cwd, "src", "commands", "list.js");
      const src = readFileSync(file, "utf8");
      writeFileSync(
        file,
        src.replace("i < store.items.length - 1", "i < store.items.length"),
      );
      return { stdout: "mock-ok", exitCode: 0 };
    };

    // Pretend judge: passes iff the diff mentions list.js.
    const mockJudge: Judge = ({ diff }) => ({
      pass: /list\.js/.test(diff),
      reason: "mock judge: diff touches list.js",
    });

    const task: Task = {
      id: "002-off-by-one-list",
      repo_fixture_path: "fixtures/buggy-cli",
      prompt: "fix the off-by-one",
      // Cheap verify: the patched source no longer contains the buggy bound.
      verify_cmd: "! grep -q 'length - 1' src/commands/list.js",
      judge_prompt: "did we fix it?",
    };

    const result = await runTask(task, "baseline", {
      evalsRoot: here,
      spawnClaude: mockClaude,
      judge: mockJudge,
    });

    expect(result.task_id).toBe("002-off-by-one-list");
    expect(result.variant).toBe("baseline");
    expect(result.pass_verify).toBe(true);
    expect(result.pass_judge).toBe(true);
    expect(result.files_edited).toBeGreaterThan(0);
    expect(typeof result.wall_clock_ms).toBe("number");
    expect(result.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // And it serializes as JSONL we can read back.
    const dir = mkdtempSync(join(tmpdir(), "harness-out-"));
    try {
      const file = resultsFileFor(dir, new Date("2026-04-23T12:00:00Z"));
      mkdirSync(dirname(file), { recursive: true });
      appendResult(file, result);
      expect(existsSync(file)).toBe(true);
      const parsed = JSON.parse(readFileSync(file, "utf8").trim());
      expect(parsed.task_id).toBe("002-off-by-one-list");
      expect(parsed.pass_verify).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
