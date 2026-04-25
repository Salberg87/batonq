// agent-runners/codex.ts — OpenAI Codex CLI runner.
//
// Headless invocation: `codex exec [--skip-git-repo-check] "<prompt>"`.
// The `exec` subcommand is the non-interactive entry point. We always pass
// `--skip-git-repo-check` because batonq tasks frequently target dirs that
// are not git roots themselves (e.g. `~/DEV` umbrella runs, scratch dirs).
// Auth is via `codex login` (ChatGPT or API key); the runner does not
// re-check auth on every call — failures surface as non-zero exit.
//
// Prompt is passed as a positional arg, NOT stdin: codex exec reads stdin
// for "additional input" which behaves differently from the prompt slot.

import { spawnSync } from "node:child_process";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, capOutput } from "./types";

export const codexRunner: AgentRunner = {
  name: "codex",

  available(): boolean {
    const r = spawnSync("codex", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  },

  run(opts: AgentRunOptions): AgentRunResult {
    const args = ["exec", "--skip-git-repo-check"];
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    args.push(opts.prompt);

    const start = Date.now();
    const r = spawnSync("codex", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // Empty stdin so codex exec doesn't wait on additional input.
      input: "",
    });

    return {
      tool: "codex",
      exitCode: r.status ?? -1,
      durationMs: Date.now() - start,
      stdout: capOutput(r.stdout ?? ""),
      stderr: capOutput(r.stderr ?? ""),
      timedOut: r.signal === "SIGTERM" && (r.status ?? 0) !== 0,
    };
  },
};
