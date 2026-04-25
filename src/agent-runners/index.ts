// agent-runners/index.ts — registry + dispatch for AgentRunner implementations.

import type { AgentRunner, AgentTool } from "./types";
import { claudeRunner } from "./claude";
import { codexRunner } from "./codex";
import { geminiRunner } from "./gemini";
import { opencodeRunner } from "./opencode";

const REGISTRY: Record<AgentTool, AgentRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
  gemini: geminiRunner,
  opencode: opencodeRunner,
};

/** Look up a runner by name. Throws if the name is not registered. */
export function getRunner(name: AgentTool): AgentRunner {
  const r = REGISTRY[name];
  if (!r) throw new Error(`unknown agent tool: ${name}`);
  return r;
}

/** Tools that have first-class implementations. */
export const IMPLEMENTED_TOOLS: readonly AgentTool[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
];

/** Tools whose binary is on PATH (best-effort). */
export function availableTools(): AgentTool[] {
  return IMPLEMENTED_TOOLS.filter((t) => REGISTRY[t].available());
}

export type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  AgentTool,
  ExecutionMode,
  ModelNickname,
} from "./types";
