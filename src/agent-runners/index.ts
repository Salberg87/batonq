// agent-runners/index.ts — registry + dispatch for AgentRunner implementations.

import type { AgentRunner, AgentTool } from "./types";
import { IMPLEMENTED_TOOLS } from "./types";
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

/** Re-exported from types.ts so callers don't depend on the runner imports. */
export { IMPLEMENTED_TOOLS } from "./types";

/** Tools whose binary is on PATH (best-effort). */
export function availableTools(): AgentTool[] {
  return IMPLEMENTED_TOOLS.filter((t) => REGISTRY[t].available());
}

export {
  detectTaskType,
  routeTask,
  ROUTING_TABLE,
  DEFAULT_ROUTING,
  TASK_TYPES,
} from "./routing";
export type { TaskType, RoutingDecision } from "./routing";

export {
  gatherContext,
  CONTEXT_STRATEGIES,
  DEFAULT_CONTEXT_STRATEGY,
} from "./context";
export type { ContextStrategy } from "./context";

export type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  AgentTool,
  ExecutionMode,
  ModelNickname,
} from "./types";
