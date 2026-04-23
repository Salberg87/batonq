// Feeds compare.ts synthetic JSONL files and checks that it reads the
// latest N, aggregates correctly per (task, variant), and renders a table.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregate,
  formatTable,
  listResultFiles,
  loadResults,
} from "./compare";
import type { RunResult } from "./harness";

function row(
  task: string,
  variant: "baseline" | "batonq",
  pass: boolean,
  ms: number,
): RunResult {
  return {
    task_id: task,
    variant,
    pass_verify: pass,
    pass_judge: pass,
    wall_clock_ms: ms,
    files_edited: 1,
    commits: 0,
    ts: "2026-04-23T12:00:00.000Z",
  };
}

describe("compare", () => {
  test("loadResults reads only the last N jsonl files, in filename order", () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-in-"));
    try {
      // Three files with ISO-sortable names — we keep only the last 2.
      writeFileSync(
        join(dir, "2026-04-23T10-00-00.jsonl"),
        JSON.stringify(row("t1", "baseline", false, 100)) + "\n",
      );
      writeFileSync(
        join(dir, "2026-04-23T11-00-00.jsonl"),
        JSON.stringify(row("t1", "baseline", true, 200)) + "\n",
      );
      writeFileSync(
        join(dir, "2026-04-23T12-00-00.jsonl"),
        JSON.stringify(row("t1", "batonq", true, 300)) + "\n",
      );
      // Junk files should be ignored.
      writeFileSync(join(dir, "README.md"), "not a result");
      writeFileSync(
        join(dir, "2026-04-23T12-30-00.jsonl"),
        "{malformed\n" +
          JSON.stringify(row("t2", "baseline", true, 400)) +
          "\n",
      );

      expect(listResultFiles(dir).length).toBe(4);

      const rows = loadResults(dir, 2);
      // Latest two files: the 12:00 one (t1/batonq) and 12:30 (malformed + t2).
      const ids = rows.map((r) => `${r.task_id}/${r.variant}`).sort();
      expect(ids).toEqual(["t1/batonq", "t2/baseline"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aggregate groups by (task, variant), sorts, and formatTable renders", () => {
    const rows: RunResult[] = [
      row("task-a", "baseline", true, 100),
      row("task-a", "baseline", false, 200),
      row("task-a", "batonq", true, 150),
      row("task-a", "batonq", true, 250),
      row("task-b", "batonq", false, 50),
    ];
    const agg = aggregate(rows);

    // Sorted by task, then variant.
    expect(agg.map((r) => `${r.task_id}/${r.variant}`)).toEqual([
      "task-a/baseline",
      "task-a/batonq",
      "task-b/batonq",
    ]);

    const baseline = agg.find(
      (r) => r.task_id === "task-a" && r.variant === "baseline",
    )!;
    expect(baseline.runs).toBe(2);
    expect(baseline.verify_pass_rate).toBe(0.5);
    expect(baseline.median_ms).toBe(150);

    const batonq = agg.find(
      (r) => r.task_id === "task-a" && r.variant === "batonq",
    )!;
    expect(batonq.runs).toBe(2);
    expect(batonq.verify_pass_rate).toBe(1);

    const table = formatTable(agg);
    expect(table).toContain("task-a");
    expect(table).toContain("baseline");
    expect(table).toContain("batonq");
    // Header row present.
    expect(table).toMatch(/task\s+variant\s+runs\s+verify%/);
  });

  test("formatTable handles zero rows", () => {
    expect(formatTable([])).toBe("(no results)\n");
  });
});
