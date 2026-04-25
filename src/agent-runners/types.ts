// agent-runners/types.ts — common interface for headless coding-CLI agents.
//
// Background: batonq's loop has historically only spawned `claude -p`. To
// fan out to codex, gemini, opencode, etc. we need a thin abstraction that
// hides per-tool flag idiosyncrasies behind a uniform call.
//
// Design absorbed from ~/DEV/oxo/src/adapters/cli_adapters.py (Python)
// and ~/DEV/oxo/agents.yaml — that earlier prototype shipped the routing
// concepts (per-task ExecutionMode, model nicknames, MODELS map) we
// replicate here in TS. Keeping the same vocabulary so a future merge or
// cross-port stays cheap.
//
// The interface is deliberately small: spawn synchronously, return exit
// code + captured stdio + duration. No streaming, no progress events.
// Loop-side stays as a simple bash poll for now.

// Runtime canonical list — the schema layer (task-schema.ts) imports this
// directly to derive its agent enum, so adding a runner here is the only
// place we need to touch when integrating a new CLI.
export const IMPLEMENTED_TOOLS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
] as const;
export type AgentTool = (typeof IMPLEMENTED_TOOLS)[number];

/**
 * Whether the agent runs in read-only or autonomous mode.
 *
 * - `analyze`: read-only output (Claude `--print` / Gemini `-p` / etc).
 *   No tool execution, no file edits, no commits. Cheap, fast, ideal for
 *   "explain this", "find files matching X", or pre-check probes.
 * - `execute`: full tool access (Claude `--dangerously-skip-permissions`,
 *   Codex `exec`, Gemini `--yolo`, opencode `run`). The agent can edit
 *   files and run shell commands. This is what the loop uses today.
 *
 * Not every CLI exposes the distinction — gemini and codex always run
 * tools, so analyze-mode for them is best-effort and documented per-runner.
 */
export type ExecutionMode = "analyze" | "execute";

/**
 * Model nickname → real model id mapping per tool. Callers pass nicknames
 * (`"opus"`, `"haiku"`, `"flash"`) instead of full versioned ids; each
 * runner translates via its own MODELS table. Nicknames the runner doesn't
 * recognise are passed through verbatim, so callers can also supply a full
 * id directly.
 */
export type ModelNickname = string;

export interface AgentRunOptions {
  /** The full task prompt. Fed via stdin or argv depending on the tool. */
  prompt: string;
  /** Working directory the agent runs in. */
  cwd: string;
  /** Hard timeout in milliseconds. Default 20 min (matches loop default). */
  timeoutMs?: number;
  /** Read-only vs autonomous. Default `execute`. See ExecutionMode docs. */
  mode?: ExecutionMode;
  /**
   * Model selector. Either a nickname the runner recognises (`opus`, `haiku`,
   * `flash`) or a full provider-specific id. Runners that don't expose model
   * choice (e.g. opencode without explicit flag) ignore this.
   */
  model?: ModelNickname;
  /**
   * Optional system-prompt-style prefix. Currently only honoured by Claude
   * (`--append-system-prompt`). Other tools ignore it.
   */
  systemPrompt?: string;
  /**
   * Claude session id of a previous run on the same task chain. When set,
   * the claude runner adds `--continue <id>` so the new invocation reuses
   * the prior session's context (turn history, mental model). Used for
   * follow-up tasks like judge-FAIL retries. Other CLIs (codex, gemini,
   * opencode) don't expose session continuity and silently ignore this.
   */
  parentSessionId?: string;
  /** Escape hatch: extra argv tokens appended after the tool's standard args. */
  extraArgs?: string[];
}

export interface AgentRunResult {
  tool: AgentTool;
  exitCode: number;
  durationMs: number;
  /** Captured stdout, truncated to ~80 KB to keep DB rows reasonable. */
  stdout: string;
  /** Captured stderr, same truncation. */
  stderr: string;
  /** True if the run was killed by timeout. */
  timedOut: boolean;
  /** Mode actually used (after default resolution). */
  mode: ExecutionMode;
  /** Resolved model id sent to the CLI, or undefined if no -m flag was used. */
  resolvedModel?: string;
  /**
   * Session id reported by the runner (only Claude does today). Persisted on
   * the task row so a follow-up dispatch can pass it back as parentSessionId
   * to keep context across the chain. Undefined for runners that don't
   * surface a session id.
   */
  sessionId?: string;
}

export interface AgentRunner {
  readonly name: AgentTool;
  /**
   * Best-effort availability check: is the binary on PATH? We don't probe
   * authentication state here — that costs a network round-trip and the
   * tools handle auth-failure cleanly via non-zero exit.
   */
  available(): boolean;
  run(opts: AgentRunOptions): AgentRunResult;
}

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
export const STDOUT_CAP_BYTES = 80_000;

/** Truncate a captured stream to the cap, marking the cut. */
export function capOutput(s: string): string {
  if (s.length <= STDOUT_CAP_BYTES) return s;
  return s.slice(0, STDOUT_CAP_BYTES) + "\n[truncated]";
}

/**
 * Resolve a nickname against a runner's MODELS map. Unknown nicknames pass
 * through verbatim so callers can specify full ids directly.
 */
export function resolveModel(
  nickname: ModelNickname | undefined,
  models: Record<string, string>,
): string | undefined {
  if (!nickname) return undefined;
  return models[nickname] ?? nickname;
}
