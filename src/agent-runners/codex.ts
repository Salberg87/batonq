// agent-runners/codex.ts — OpenAI Codex CLI runner.
//
// Headless invocation: `codex exec [--skip-git-repo-check] [--model <id>] "<prompt>"`.
// `exec` is the non-interactive subcommand. We always pass
// `--skip-git-repo-check` because batonq tasks frequently target dirs that
// are not git roots themselves (`~/DEV` umbrella, scratch dirs).
//
// Auth: `codex login` (ChatGPT subscription or API key). The runner does
// not re-check auth on every call — failures surface as non-zero exit.
//
// Mode caveat: codex has no read-only equivalent of `claude --print`.
// `analyze` and `execute` both invoke `exec`; analyze just adds a system-
// hint to the prompt asking for a no-edit response. Documented per spec.

import { spawnSync } from "node:child_process";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, capOutput, resolveModel } from "./types";

/** Codex model nicknames. Keep small — codex's model surface is narrower. */
export const CODEX_MODELS: Record<string, string> = {
  default: "codex",
};

const ANALYZE_HINT =
  "Read-only mode: explain or describe only. Do NOT edit files, run shell commands, or commit. Output your analysis as text.";

export const codexRunner: AgentRunner = {
  name: "codex",

  available(): boolean {
    const r = spawnSync("codex", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  },

  run(opts: AgentRunOptions): AgentRunResult {
    const mode = opts.mode ?? "execute";
    const resolvedModel = resolveModel(opts.model, CODEX_MODELS);

    const args = ["exec", "--skip-git-repo-check"];
    if (resolvedModel) args.push("--model", resolvedModel);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    // Codex has no native --print mode. Prepend a hint in analyze-mode so
    // the model self-restricts. Best-effort, not enforced by the CLI.
    const finalPrompt =
      mode === "analyze" ? `${ANALYZE_HINT}\n\n${opts.prompt}` : opts.prompt;
    args.push(finalPrompt);

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
      mode,
      resolvedModel,
    };
  },
};
