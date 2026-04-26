// task-schema — Zod schema + parser for task inputs.
//
// Guards the queue against malformed tasks slipping through. The existing
// TASKS.md parser in tasks-core is tolerant by design (best-effort parse of
// a human-edited markdown file); this schema is the stricter gate applied
// before a task becomes authoritative (persisted, claimed, or run).
//
// Field rules (mirrored in tests):
//   - external_id / repo: non-empty strings
//   - body: ≥ 20 chars (short bodies are almost always placeholder stubs)
//   - priority: exactly one of high | normal | low
//   - status:   exactly one of pending | draft | claimed | done | lost
//   - scheduled_for?: ISO-8601 datetime when present
//   - verify? / judge?: ≥ 10 chars when present (commands this short are
//     almost always typos — e.g. a leftover `true` from a debug edit)

import { z } from "zod";
import { IMPLEMENTED_TOOLS } from "./agent-runners/types";
import {
  CONTEXT_STRATEGIES,
  DEFAULT_CONTEXT_STRATEGY,
} from "./agent-runners/context";
import { AGENT_ROLES } from "./agent-runners/role-skills";

// Default role for tasks without an explicit `@role:` annotation or --role
// flag. `worker` matches the pre-roles behaviour (run, edit, test, commit).
export const DEFAULT_ROLE = "worker" as const;

export const PRIORITIES = ["high", "normal", "low"] as const;
export const STATUSES = [
  "pending",
  "draft",
  "claimed",
  "done",
  "lost",
] as const;

// Multi-CLI dispatch target. Derived from IMPLEMENTED_TOOLS so adding a new
// runner in agent-runners/types.ts automatically widens the schema — no
// chance of a hand-edited list drifting away from the runner registry. `any`
// (the default) means the loop is free to route to whichever runner has
// capacity / is installed; explicit values pin the task to a specific CLI.
export const AGENTS = [...IMPLEMENTED_TOOLS, "any"] as const;
export const DEFAULT_AGENT = "any";

export const TaskSchema = z.object({
  external_id: z.string().min(1, "external_id must be non-empty"),
  repo: z.string().min(1, "repo must be non-empty"),
  body: z.string().min(20, "body must be at least 20 characters"),
  priority: z.enum(PRIORITIES),
  scheduled_for: z.iso.datetime().optional(),
  verify: z
    .string()
    .min(10, "verify command must be at least 10 characters")
    .optional(),
  judge: z
    .string()
    .min(10, "judge command must be at least 10 characters")
    .optional(),
  status: z.enum(STATUSES),
  agent: z.enum(AGENTS).optional().default(DEFAULT_AGENT),
  // Optional context-gathering strategy (oxo port). Defaults to "none" so
  // existing tasks behave unchanged; opt in per-task to get keyword-based
  // grep slices prepended to the prompt. See agent-runners/context.ts.
  context_strategy: z
    .enum(CONTEXT_STRATEGIES)
    .optional()
    .default(DEFAULT_CONTEXT_STRATEGY),
  // Claude session id captured from the most recent run on this task chain.
  // Only Claude reports it (other CLIs ignore the column). The loop hands
  // this back to the runner as parentSessionId on a follow-up dispatch
  // (e.g. judge-FAIL retry) ONLY when reuse_session is true.
  session_id: z.string().min(1).optional(),
  // Opt-in kill switch for session continuity. Default false = a follow-up
  // dispatch starts a fresh Claude session even if the parent has a
  // session_id on file. Set true on the follow-up task only when the prior
  // agent's mental model is worth preserving (incremental fix on a near-
  // correct solution). Leaving it false avoids anchoring a retry to a
  // failed reasoning approach — see claude.ts for the full rationale.
  reuse_session: z.boolean().optional().default(false),
  // Per-task role identity. The dispatcher uses this to inject the matching
  // SKILL.md from `Salberg87/batonq-skills` into the agent's system prompt
  // (loader lives in the runners). Defaults to `worker` so existing tasks
  // and bare `batonq add` calls keep behaving as plain implementation work.
  // See `agent-runners/role-skills.ts` for the canonical enum.
  role: z.enum(AGENT_ROLES).optional().default(DEFAULT_ROLE),
});

export type Task = z.infer<typeof TaskSchema>;

// Strict parse — throws ZodError on any validation failure. Callers that
// want to collect issues without throwing should use `TaskSchema.safeParse`.
export function parseTaskInput(input: unknown): Task {
  return TaskSchema.parse(input);
}
