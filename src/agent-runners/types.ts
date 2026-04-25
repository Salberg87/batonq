// agent-runners/types.ts — common interface for headless coding-CLI agents.
//
// Background: batonq's loop has historically only spawned `claude -p`. To
// fan out to codex, gemini, opencode, etc. we need a thin abstraction that
// hides per-tool flags (codex needs `--skip-git-repo-check`, gemini wants
// `--yolo`, opencode uses `run` subcommand) behind a uniform call.
//
// The interface is deliberately small: spawn synchronously, return exit code
// + captured stdio + duration. No streaming, no progress events. Loop-side
// stays as a simple bash poll for now.

export type AgentTool = "claude" | "codex" | "gemini" | "opencode";

export interface AgentRunOptions {
  /** The full task prompt. Fed via stdin or argv depending on the tool. */
  prompt: string;
  /** Working directory the agent runs in. */
  cwd: string;
  /** Hard timeout in milliseconds. Default 20 min (matches loop default). */
  timeoutMs?: number;
  /**
   * Optional system-prompt-style prefix. Currently only honoured by Claude
   * (`--append-system-prompt`). Other tools ignore it.
   */
  systemPrompt?: string;
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
