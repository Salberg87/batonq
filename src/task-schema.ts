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

export const PRIORITIES = ["high", "normal", "low"] as const;
export const STATUSES = [
  "pending",
  "draft",
  "claimed",
  "done",
  "lost",
] as const;

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
});

export type Task = z.infer<typeof TaskSchema>;

// Strict parse — throws ZodError on any validation failure. Callers that
// want to collect issues without throwing should use `TaskSchema.safeParse`.
export function parseTaskInput(input: unknown): Task {
  return TaskSchema.parse(input);
}
