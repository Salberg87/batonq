// agent-runners/claude.ts — Claude Code CLI runner.
//
// Mirrors the shell flags the loop (src/agent-coord-loop) uses today:
//   claude -p --dangerously-skip-permissions [--append-system-prompt <sp>]
//
// Prompt is fed via stdin (matches `echo "$PICK_OUTPUT" | claude -p ...`).
// stdin EOF is the exit signal — claude -p exits cleanly when stdin closes.
//
// Subscription-auth pattern (from ~/DEV/LOV/server/copilot/claude-runner.ts):
// when CLAUDECODE and ANTHROPIC_API_KEY are unset/empty in the env, the CLI
// falls back to the user's logged-in subscription instead of looking for an
// API key. That keeps overnight loops billed against the Pro/Max plan rather
// than racking up pay-as-you-go charges. We unset both env vars unless the
// caller has explicitly set BATONQ_USE_API_KEY=1.
//
// Session continuity (fan-out 6/6): when opts.parentSessionId is set we add
// `--continue <id>` so the invocation reuses a prior session's turn history.
// We also scan stdout for the session id Claude prints (looks for both the
// JSON form `"session_id":"<uuid>"` and the human form `Session ID: <uuid>`)
// and surface it on the AgentRunResult so the caller can persist it on the
// task row and feed it back into a follow-up dispatch.

import { spawnSync } from "node:child_process";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, capOutput, resolveModel } from "./types";

/**
 * Nickname → versioned model id. Caller writes `model: "opus"`, we send the
 * full id to Claude. Pass-through if nickname is unknown.
 *
 * Versions reflect what oxo/agents.yaml documented; bump as Anthropic
 * publishes new ids. Avoid hard-coding "latest" aliases — the loop wants a
 * deterministic id for reproducibility.
 */
export const CLAUDE_MODELS: Record<string, string> = {
  opus: "claude-opus-4-5",
  sonnet: "claude-sonnet-4",
  haiku: "claude-haiku-3-5",
};

function buildEnv(): NodeJS.ProcessEnv {
  // Honor explicit opt-in to API-key billing. Default: subscription auth.
  if (process.env.BATONQ_USE_API_KEY === "1") return { ...process.env };
  return {
    ...process.env,
    CLAUDECODE: "",
    ANTHROPIC_API_KEY: "",
  };
}

export const claudeRunner: AgentRunner = {
  name: "claude",

  available(): boolean {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  },

  run(opts: AgentRunOptions): AgentRunResult {
    const mode = opts.mode ?? "execute";
    const resolvedModel = resolveModel(opts.model, CLAUDE_MODELS);
    const args = buildClaudeArgs(opts, resolvedModel);

    const start = Date.now();
    const r = spawnSync("claude", args, {
      input: opts.prompt,
      cwd: opts.cwd,
      encoding: "utf8",
      env: buildEnv(),
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });

    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    return {
      tool: "claude",
      exitCode: r.status ?? -1,
      durationMs: Date.now() - start,
      stdout: capOutput(stdout),
      stderr: capOutput(stderr),
      timedOut: r.signal === "SIGTERM" && (r.status ?? 0) !== 0,
      mode,
      resolvedModel,
      sessionId: extractSessionId(stdout),
    };
  },
};

/**
 * Build the argv for `claude`. Exported for tests so we can verify the
 * `--continue <parentSessionId>` wiring without spawning a real binary.
 */
export function buildClaudeArgs(
  opts: AgentRunOptions,
  resolvedModel: string | undefined,
): string[] {
  const mode = opts.mode ?? "execute";
  // Mode → flag. `--print` is read-only one-shot (no tools). `--dangerously-
  // skip-permissions` enables full autonomous tool use. Currently the loop
  // wants execute; analyze is here for future cheap-probe use cases.
  const args =
    mode === "analyze" ? ["--print"] : ["-p", "--dangerously-skip-permissions"];

  // Session continuity comes from a prior run on the same task chain.
  // `--continue <id>` makes claude rehydrate that session before consuming
  // the new prompt on stdin. Empty / whitespace-only ids are ignored so a
  // stray empty column value doesn't produce an invalid claude invocation.
  if (opts.parentSessionId && opts.parentSessionId.trim()) {
    args.push("--continue", opts.parentSessionId.trim());
  }

  if (resolvedModel) args.push("--model", resolvedModel);
  if (opts.systemPrompt && mode === "execute") {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/**
 * Pull the Claude session id out of captured stdout. Claude emits it in two
 * shapes depending on `--output-format`: the JSON/stream-json variants yield
 * `"session_id":"<uuid>"` (possibly with whitespace), and human-readable
 * traces print `Session ID: <uuid>`. We accept either. Returns undefined
 * when no id is found — the caller treats that as "this run didn't surface
 * a continuable session".
 *
 * UUIDs are 36 chars (8-4-4-4-12 hex with dashes). We accept any sequence
 * of hex / dashes ≥ 8 chars to stay compatible with shorter/test ids.
 */
export function extractSessionId(stdout: string): string | undefined {
  if (!stdout) return undefined;
  const jsonMatch = stdout.match(
    /"session_id"\s*:\s*"([0-9a-fA-F][0-9a-fA-F-]{7,})"/,
  );
  if (jsonMatch) return jsonMatch[1];
  const humanMatch = stdout.match(
    /Session ID:\s*([0-9a-fA-F][0-9a-fA-F-]{7,})/,
  );
  if (humanMatch) return humanMatch[1];
  return undefined;
}
