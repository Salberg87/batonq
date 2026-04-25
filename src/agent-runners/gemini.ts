// agent-runners/gemini.ts — Google Gemini CLI runner.
//
// Headless invocation:
//   gemini -p "<prompt>" [-m <model>] --approval-mode=<plan|auto_edit|yolo>
//
// `-p`/`--prompt` enables non-interactive mode. Approval mode controls
// tool-call gating:
//   plan       — read-only, no tool execution (our `analyze` mode)
//   auto_edit  — auto-approve edits but not arbitrary shell (our `execute`)
//   yolo       — auto-approve everything; often blocked by Workspace admin
//                policy, so we DON'T default to it. Use --extra-args to opt
//                in: `--extra-args=--approval-mode=yolo`.
// Without an approval flag the CLI prompts and would deadlock a non-
// interactive run.
//
// Model nicknames map to oxo/agents.yaml: `pro` (1M context, multimodal,
// reasoning), `flash` (fast and cheap). Defaults are chosen by the CLI
// when --model is omitted.
//
// Auth: gemini login (Google OAuth). MCP / skills warnings during startup
// are noise — we don't filter them, callers can grep them out if needed.

import { spawnSync } from "node:child_process";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, capOutput, resolveModel } from "./types";

export const GEMINI_MODELS: Record<string, string> = {
  pro: "gemini-2.5-pro",
  flash: "gemini-2.5-flash",
};

export const geminiRunner: AgentRunner = {
  name: "gemini",

  available(): boolean {
    const r = spawnSync("gemini", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  },

  run(opts: AgentRunOptions): AgentRunResult {
    const mode = opts.mode ?? "execute";
    const resolvedModel = resolveModel(opts.model, GEMINI_MODELS);

    // -p enables non-interactive mode. --approval-mode controls tool gating
    // without requiring the admin-policy-sensitive --yolo. Caller can still
    // pass `--approval-mode=yolo` via extraArgs when their account allows.
    const args = ["-p", opts.prompt];
    if (resolvedModel) args.push("-m", resolvedModel);
    args.push("--approval-mode", mode === "analyze" ? "plan" : "auto_edit");
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    const start = Date.now();
    const r = spawnSync("gemini", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      input: "",
    });

    return {
      tool: "gemini",
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
