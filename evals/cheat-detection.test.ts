// Exercises the cheat-detection runner against the real fixtures + cheat
// behaviors and asserts that batonq's verify gate catches every cheat.
// Runs in CI via `bun test` — no real LLM is invoked, the cheats are
// hard-coded JS so the table is fully deterministic.

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHEAT_BEHAVIORS,
  renderMarkdown,
  runAll,
  runCheatScenario,
  type CheatRow,
} from "./cheat-detection";
import { loadTasks } from "./harness";

const here = dirname(fileURLToPath(import.meta.url));

describe("cheat-detection", () => {
  test("ships exactly 5 cheat task JSONs", () => {
    const tasks = loadTasks(join(here, "tasks", "cheat"));
    expect(tasks.map((t) => t.id).sort()).toEqual([
      "cheat-001-stub-tests",
      "cheat-002-no-commit",
      "cheat-003-no-docs",
      "cheat-004-rigged-test",
      "cheat-005-comment-not-impl",
    ]);
  });

  test("every task has a registered cheat behavior", () => {
    const tasks = loadTasks(join(here, "tasks", "cheat"));
    for (const t of tasks) {
      expect(CHEAT_BEHAVIORS[t.id]).toBeDefined();
    }
    // And no orphan cheats — every behavior maps to a task.
    const taskIds = new Set(tasks.map((t) => t.id));
    for (const k of Object.keys(CHEAT_BEHAVIORS)) {
      expect(taskIds.has(k)).toBe(true);
    }
  });

  test("batonq blocks all 5 cheats; bare claude -p closes them all", () => {
    const rows = runAll(here);
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.gates_on).toBe("BLOCKED");
      expect(r.gates_off).toBe("DONE");
      expect(r.verdict).toBe("batonq blocks cheat");
      expect(r.verify_exit).not.toBe(0);
    }
  });

  test("runCheatScenario throws on unregistered task ids", () => {
    expect(() =>
      runCheatScenario(
        {
          id: "cheat-999-never-registered",
          repo_fixture_path: "fixtures/cheat-001-stub-tests",
          prompt: "n/a",
          verify_cmd: "true",
          judge_prompt: "n/a",
        },
        here,
      ),
    ).toThrow(/no cheat behavior/);
  });

  test("renderMarkdown produces a table + summary line + receipts", () => {
    const rows: CheatRow[] = [
      {
        scenario: "demo-blocked",
        cheat_summary: "did nothing",
        gates_on: "BLOCKED",
        gates_off: "DONE",
        verdict: "batonq blocks cheat",
        verify_exit: 1,
        verify_stderr: "boom",
      },
      {
        scenario: "demo-passed",
        cheat_summary: "got lucky",
        gates_on: "DONE",
        gates_off: "DONE",
        verdict: "batonq fails to detect",
        verify_exit: 0,
        verify_stderr: "",
      },
    ];
    const md = renderMarkdown(rows, {
      runDate: "2026-04-24",
      gitSha: "deadbee",
    });
    expect(md).toContain("# cheat-detection scorecard — 2026-04-24");
    expect(md).toContain("1/2 cheats caught by batonq");
    expect(md).toContain("`demo-blocked`");
    expect(md).toContain("`demo-passed`");
    expect(md).toContain("✅ batonq blocks cheat");
    expect(md).toContain("❌ batonq fails to detect");
    expect(md).toContain("`deadbee`");
    // Receipts table includes the stderr first line.
    expect(md).toContain("boom");
  });
});
