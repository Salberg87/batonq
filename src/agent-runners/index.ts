// agent-runners/index.ts — registry + dispatch for AgentRunner implementations.

import type { AgentRunner, AgentTool } from "./types";
import { claudeRunner } from "./claude";
import { codexRunner } from "./codex";

const REGISTRY: Record<AgentTool, AgentRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
  // gemini and opencode wired in in follow-up tasks.
  gemini: claudeRunner, // placeholder so the type stays exhaustive
  opencode: claudeRunner, // placeholder
};

/**
 * Look up a runner by name. Throws if the name is not yet implemented
 * (caller should validate against `availableTools()` before calling).
 */
export function getRunner(name: AgentTool): AgentRunner {
  const r = REGISTRY[name];
  if (!r) throw new Error(`unknown agent tool: ${name}`);
  return r;
}

/** List runners that have first-class implementations (not placeholders). */
export const IMPLEMENTED_TOOLS: readonly AgentTool[] = ["claude", "codex"];

/** List runners whose binary is on PATH (best-effort). */
export function availableTools(): AgentTool[] {
  return IMPLEMENTED_TOOLS.filter((t) => REGISTRY[t].available());
}

export type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  AgentTool,
} from "./types";
