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
//
// IMPORTANT — when to reuse a session vs start fresh:
//   Reuse (set parentSessionId) only when the follow-up task wants the prior
//   agent's *mental model* preserved: incremental fixes on a near-correct
//   solution where re-loading the codebase would burn tokens to rebuild the
//   same understanding (e.g. judge said "looks good but missing edge case
//   X" or verify failed on a single typo in a 500-line refactor).
//
//   Start fresh (leave parentSessionId undefined) when the prior approach
//   was wrong at the architectural level. Reusing the session anchors the
//   new attempt to the failed reasoning — the agent rationalises around
//   its old plan instead of reconsidering. judge-FAIL on a logic-level
//   critique is the canonical "start fresh" case.
//
//   The runner is intentionally agnostic: it does NOT auto-pull session_id
//   from a parent task row. The dispatcher decides per-retry whether to
//   pass parentSessionId, gated by Task.reuse_session (opt-in flag in
//   task-schema.ts). Default is fresh — continuity is the explicit choice.

import { spawnSync } from "node:child_process";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./types";
import { DEFAULT_TIMEOUT_MS, capOutput, resolveModel } from "./types";
import { loadRoleSkill } from "./role-skills";

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
    const skillPath = opts.role ? loadRoleSkill(opts.role)?.path : undefined;
    const args = buildClaudeArgs(opts, resolvedModel, skillPath);

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
 * `--continue <parentSessionId>` and `--append-system-prompt-file <path>`
 * wiring without spawning a real binary.
 *
 * The optional `skillPath` arg is the cached SKILL.md path resolved by
 * `loadRoleSkill(opts.role)` in `run()`. Tests pass a synthetic path
 * directly so they don't have to touch the filesystem cache.
 */
export function buildClaudeArgs(
  opts: AgentRunOptions,
  resolvedModel: string | undefined,
  skillPath?: string,
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
  // Role SKILL.md → claude's native file-based system-prompt loader. Stays
  // out of analyze mode because `--print` ignores append-system-prompt and
  // surfacing the flag there would mislead callers about its effect.
  if (skillPath && mode === "execute") {
    args.push("--append-system-prompt-file", skillPath);
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/**
 * Dispatcher hook: decide whether a follow-up should reuse the parent's
 * Claude session. This is the single place the loop calls when building a
 * retry — it keeps the gating policy (default fresh, opt-in via
 * reuse_session) in one place instead of scattering the same conditional
 * across every callsite that wants to spawn a continuation.
 *
 * Returns the parent session id when the follow-up opted into reuse AND
 * the parent actually has a session id on file; undefined otherwise. The
 * undefined return is what tells claudeRunner.run to start a fresh session.
 */
export function pickParentSessionId(
  parent: { session_id?: string | null } | null | undefined,
  followUp: { reuse_session?: boolean | null } | null | undefined,
): string | undefined {
  if (!parent?.session_id) return undefined;
  if (!followUp?.reuse_session) return undefined;
  return parent.session_id;
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
