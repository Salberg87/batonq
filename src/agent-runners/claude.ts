// agent-runners/claude.ts — Claude Code CLI runner.
//
// Mirrors the shell flags the loop (src/agent-coord-loop) uses today:
//   claude -p --dangerously-skip-permissions [--append-system-prompt <sp>]
//
// Prompt is fed via stdin (matches `echo "$PICK_OUTPUT" | claude -p ...`).
// stdin EOF is the exit signal — claude -p exits cleanly when stdin closes.

import { spawnSync } from "node:child_process";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, capOutput } from "./types";

export const claudeRunner: AgentRunner = {
  name: "claude",

  available(): boolean {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  },

  run(opts: AgentRunOptions): AgentRunResult {
    const args = ["-p", "--dangerously-skip-permissions"];
    if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    const start = Date.now();
    const r = spawnSync("claude", args, {
      input: opts.prompt,
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });

    return {
      tool: "claude",
      exitCode: r.status ?? -1,
      durationMs: Date.now() - start,
      stdout: capOutput(r.stdout ?? ""),
      stderr: capOutput(r.stderr ?? ""),
      timedOut: r.signal === "SIGTERM" && (r.status ?? 0) !== 0,
    };
  },
};
