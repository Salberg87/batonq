#!/usr/bin/env bun
// evals/cross-tool.ts — run each cheat scenario through each implemented
// agent runner and produce a comparative scorecard.
//
// For each scenario × runner pair, we:
//   1. Copy the fixture to a fresh tmp dir.
//   2. Spawn `batonq agent-run --tool=<runner> --role=worker --prompt=<scenario.prompt>`.
//   3. Run the scenario's verify_cmd in the tmp dir.
//   4. Capture the git diff.
//   5. Record verify-pass/fail, duration, output size.
// Output: a markdown scorecard at evals/results/<date>-cross-tool.md.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { availableTools, type AgentTool } from "../src/agent-runners";

const REPO_ROOT = resolve(__dirname, "..");
const FIXTURES_DIR = join(REPO_ROOT, "evals", "fixtures");
const TASKS_DIR = join(REPO_ROOT, "evals", "tasks", "cheat");
const RESULTS_DIR = join(REPO_ROOT, "evals", "results");

type Scenario = {
  id: string;
  repo_fixture_path: string;
  prompt: string;
  verify_cmd: string;
  judge_prompt: string;
  cheat_summary: string;
};

type RunResult = {
  tool: AgentTool;
  scenario: string;
  exitCode: number;
  durationMs: number;
  verifyPassed: boolean;
  verifyOutput: string;
  diffLines: number;
  errored: boolean;
  errorMessage?: string;
};

function loadScenarios(): Scenario[] {
  return readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) => JSON.parse(readFileSync(join(TASKS_DIR, f), "utf8")) as Scenario,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function setupWorkdir(scenario: Scenario): string {
  const workdir = mkdtempSync(join(tmpdir(), `cross-tool-${scenario.id}-`));
  const fixturePath = join(REPO_ROOT, "evals", scenario.repo_fixture_path);
  cpSync(fixturePath, workdir, { recursive: true });
  // Initialise as a git repo so verify lines that touch git work.
  spawnSync("git", ["init", "-q"], { cwd: workdir });
  spawnSync("git", ["config", "user.email", "eval@batonq.local"], {
    cwd: workdir,
  });
  spawnSync("git", ["config", "user.name", "Cross-Tool Eval"], {
    cwd: workdir,
  });
  spawnSync("git", ["add", "-A"], { cwd: workdir });
  spawnSync("git", ["commit", "-q", "-m", "fixture baseline"], {
    cwd: workdir,
  });
  return workdir;
}

function runOneScenario(tool: AgentTool, scenario: Scenario): RunResult {
  const workdir = setupWorkdir(scenario);
  const start = Date.now();
  let result: RunResult;
  try {
    const r = spawnSync(
      "bun",
      [
        join(REPO_ROOT, "src/agent-coord"),
        "agent-run",
        `--tool=${tool}`,
        "--role=worker",
        `--prompt=${scenario.prompt}`,
        `--cwd=${workdir}`,
        "--timeout-sec=120",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const verify = spawnSync("sh", ["-c", scenario.verify_cmd], {
      cwd: workdir,
      encoding: "utf8",
    });
    const diff = spawnSync("git", ["diff", "HEAD"], {
      cwd: workdir,
      encoding: "utf8",
    });
    result = {
      tool,
      scenario: scenario.id,
      exitCode: r.status ?? -1,
      durationMs: Date.now() - start,
      verifyPassed: verify.status === 0,
      verifyOutput: ((verify.stdout ?? "") + (verify.stderr ?? "")).slice(
        0,
        200,
      ),
      diffLines: (diff.stdout ?? "").split("\n").length,
      errored: false,
    };
  } catch (e) {
    result = {
      tool,
      scenario: scenario.id,
      exitCode: -1,
      durationMs: Date.now() - start,
      verifyPassed: false,
      verifyOutput: "",
      diffLines: 0,
      errored: true,
      errorMessage: (e as Error).message,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  return result;
}

function badge(r: RunResult): string {
  if (r.errored) return "💥 err";
  if (r.verifyPassed) return "✅ PASS";
  return "❌ FAIL";
}

function emitMarkdown(scenarios: Scenario[], results: RunResult[]): string {
  const tools = [...new Set(results.map((r) => r.tool))].sort();
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# Cross-tool eval — ${date}`);
  lines.push("");
  lines.push(
    "Each cheat scenario was run through every implemented runner via `batonq agent-run --role=worker`. The runner picks up the SKILL.md from the [batonq-skills](https://github.com/Salberg87/batonq-skills) repo. Verify uses the scenario's own `verify_cmd`.",
  );
  lines.push("");
  lines.push("## Scorecard");
  lines.push("");

  // Header row
  const header = ["Scenario", ...tools.map((t) => `\`${t}\``)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);

  // One row per scenario
  for (const s of scenarios) {
    const cells: string[] = [`\`${s.id}\``];
    for (const t of tools) {
      const r = results.find((r) => r.tool === t && r.scenario === s.id);
      if (!r) {
        cells.push("—");
      } else {
        cells.push(`${badge(r)} (${(r.durationMs / 1000).toFixed(1)}s)`);
      }
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }

  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`| Tool | Pass rate | Avg duration |`);
  lines.push(`| --- | --- | --- |`);
  for (const t of tools) {
    const rs = results.filter((r) => r.tool === t);
    const passed = rs.filter((r) => r.verifyPassed).length;
    const avg = rs.reduce((a, r) => a + r.durationMs, 0) / rs.length;
    lines.push(
      `| \`${t}\` | ${passed}/${rs.length} (${Math.round((passed / rs.length) * 100)}%) | ${(avg / 1000).toFixed(1)}s |`,
    );
  }

  lines.push("");
  lines.push("## Per-scenario detail");
  lines.push("");
  for (const s of scenarios) {
    lines.push(`### \`${s.id}\``);
    lines.push("");
    lines.push(`> ${s.cheat_summary}`);
    lines.push("");
    for (const t of tools) {
      const r = results.find((r) => r.tool === t && r.scenario === s.id);
      if (!r) continue;
      lines.push(
        `- **\`${t}\`** — ${badge(r)} · ${(r.durationMs / 1000).toFixed(1)}s · diff ${r.diffLines} lines${r.errored ? ` · err: ${r.errorMessage?.slice(0, 80)}` : ""}`,
      );
      if (r.verifyOutput && !r.verifyPassed) {
        lines.push(
          `  - verify-output: \`${r.verifyOutput.replace(/`/g, "'").slice(0, 120)}\``,
        );
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `Generated by \`evals/cross-tool.ts\` — run with \`bun evals/cross-tool.ts\`. Each scenario isolated in a fresh tmp git repo. Tool list resolved at runtime via \`availableTools()\`.`,
  );

  return lines.join("\n");
}

function main(): void {
  const scenarios = loadScenarios();
  const tools = availableTools();
  console.log(`scenarios: ${scenarios.length}`);
  console.log(`tools: ${tools.join(", ")}`);
  console.log(`total runs: ${scenarios.length * tools.length}`);
  console.log();

  const results: RunResult[] = [];
  for (const s of scenarios) {
    for (const t of tools) {
      process.stdout.write(`  [${t}] ${s.id} ... `);
      const r = runOneScenario(t, s);
      results.push(r);
      console.log(`${badge(r)} (${(r.durationMs / 1000).toFixed(1)}s)`);
    }
  }
  console.log();

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const out = join(RESULTS_DIR, `${date}-cross-tool.md`);
  writeFileSync(out, emitMarkdown(scenarios, results));
  console.log(`wrote ${out}`);
}

main();
