// agent-runners/opencode.ts — opencode multi-provider CLI runner.
//
// Headless invocation: `opencode run "<message>"`.
// The `run` subcommand fires a one-shot turn against whatever provider is
// configured under `opencode auth`. Default routes through OpenAI/
// Anthropic/OpenRouter (the user's configured creds — see
// `opencode auth list`). The runner doesn't pin a provider; the caller's
// opencode config decides.
//
// Mode + model: opencode `run` doesn't expose explicit analyze/yolo or a
// CLI model flag — provider/model are config-driven, and tool use is
// always on. We accept the option fields for interface symmetry and
// document the no-op so callers aren't surprised.

import { spawnSync } from "node:child_process";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, capOutput } from "./types";
import { loadRoleSkill } from "./role-skills";
import { applySkillToPrompt } from "./prompt-prepend";

export const opencodeRunner: AgentRunner = {
  name: "opencode",

  available(): boolean {
    const r = spawnSync("opencode", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  },

  run(opts: AgentRunOptions): AgentRunResult {
    const mode = opts.mode ?? "execute";
    const skillContent = opts.role
      ? loadRoleSkill(opts.role)?.content
      : undefined;
    const args = buildOpencodeArgs(opts, skillContent);

    const start = Date.now();
    const r = spawnSync("opencode", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      input: "",
    });

    return {
      tool: "opencode",
      exitCode: r.status ?? -1,
      durationMs: Date.now() - start,
      stdout: capOutput(r.stdout ?? ""),
      stderr: capOutput(r.stderr ?? ""),
      timedOut: r.signal === "SIGTERM" && (r.status ?? 0) !== 0,
      mode,
      // opencode does not accept a CLI model flag — model is config-driven.
      resolvedModel: undefined,
    };
  },
};

/**
 * Build the argv for `opencode run`. Exported for tests so role-skill
 * prepending can be verified without spawning the binary.
 *
 * opencode's `run` doesn't take a system flag, and per-agent config lives
 * under `.opencode/agents/` (per-cwd) — mutating that on every task would
 * leave stray files behind. Prepending SKILL.md inline keeps the
 * invocation stateless.
 */
export function buildOpencodeArgs(
  opts: AgentRunOptions,
  skillContent?: string,
): string[] {
  const finalPrompt = applySkillToPrompt(opts.prompt, skillContent);
  const args = ["run", finalPrompt];
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}
