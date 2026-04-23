// Aggregate the latest N eval runs and print a comparison table across
// variants. Reads every *.jsonl under `results/`, sorts by filename (which
// is an ISO timestamp), takes the last N, groups by (variant, task) and
// prints pass rates + median wall-clock. Exports are kept pure so the test
// suite can feed it synthetic rows.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult, Variant } from "./harness";

export function listResultFiles(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

export function loadResults(resultsDir: string, lastN: number): RunResult[] {
  const files = listResultFiles(resultsDir).slice(-lastN);
  const rows: RunResult[] = [];
  for (const f of files) {
    const raw = readFileSync(join(resultsDir, f), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as RunResult);
      } catch {
        // skip malformed rows rather than crashing a comparison.
      }
    }
  }
  return rows;
}

export type AggRow = {
  task_id: string;
  variant: Variant;
  runs: number;
  verify_pass_rate: number;
  judge_pass_rate: number;
  median_ms: number;
  avg_files_edited: number;
  avg_commits: number;
};

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function aggregate(rows: RunResult[]): AggRow[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of rows) {
    const key = `${r.task_id}::${r.variant}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(r);
  }
  const out: AggRow[] = [];
  for (const [key, bucket] of groups) {
    const [task_id, variant] = key.split("::") as [string, Variant];
    const n = bucket.length;
    out.push({
      task_id,
      variant,
      runs: n,
      verify_pass_rate: bucket.filter((r) => r.pass_verify).length / n,
      judge_pass_rate: bucket.filter((r) => r.pass_judge).length / n,
      median_ms: median(bucket.map((r) => r.wall_clock_ms)),
      avg_files_edited: bucket.reduce((acc, r) => acc + r.files_edited, 0) / n,
      avg_commits: bucket.reduce((acc, r) => acc + r.commits, 0) / n,
    });
  }
  return out.sort((a, b) =>
    a.task_id === b.task_id
      ? a.variant.localeCompare(b.variant)
      : a.task_id.localeCompare(b.task_id),
  );
}

export function formatTable(rows: AggRow[]): string {
  if (rows.length === 0) return "(no results)\n";
  const header = [
    "task",
    "variant",
    "runs",
    "verify%",
    "judge%",
    "med_ms",
    "files",
    "commits",
  ];
  const body = rows.map((r) => [
    r.task_id,
    r.variant,
    String(r.runs),
    (r.verify_pass_rate * 100).toFixed(0),
    (r.judge_pass_rate * 100).toFixed(0),
    String(Math.round(r.median_ms)),
    r.avg_files_edited.toFixed(1),
    r.avg_commits.toFixed(1),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]!.length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return (
    [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join(
      "\n",
    ) + "\n"
  );
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const resultsDir = join(here, "results");
  const nArg = argv.find((a) => a.startsWith("--last="));
  const n = nArg ? parseInt(nArg.split("=")[1] ?? "5", 10) : 5;
  const rows = loadResults(resultsDir, Number.isNaN(n) ? 5 : n);
  process.stdout.write(formatTable(aggregate(rows)));
}

if (import.meta.main) {
  main();
}
