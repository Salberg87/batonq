// task-schema — Zod schema tests. The schema is the strict gate before a
// task becomes authoritative; a regression here means malformed tasks can
// slip into the queue again (the verify/judge-stub bug that motivated this
// refactor).

import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { parseTaskInput, TaskSchema } from "../src/task-schema";

const MIN_VALID = {
  external_id: "abc123",
  repo: "any:infra",
  body: "a minimally valid task body that clears the 20-char floor",
  priority: "normal",
  status: "pending",
};

describe("parseTaskInput", () => {
  test("accepts a minimal valid task and round-trips every field", () => {
    const parsed = parseTaskInput(MIN_VALID);
    expect(parsed.external_id).toBe("abc123");
    expect(parsed.repo).toBe("any:infra");
    expect(parsed.priority).toBe("normal");
    expect(parsed.status).toBe("pending");
    expect(parsed.scheduled_for).toBeUndefined();
    expect(parsed.verify).toBeUndefined();
    expect(parsed.judge).toBeUndefined();
  });

  test("accepts optional scheduled_for / verify / judge when well-formed", () => {
    const parsed = parseTaskInput({
      ...MIN_VALID,
      scheduled_for: "2026-05-01T09:00:00.000Z",
      verify: "bun test tests/core.test.ts",
      judge: "bun run typecheck && grep -q foo src/",
    });
    expect(parsed.scheduled_for).toBe("2026-05-01T09:00:00.000Z");
    expect(parsed.verify).toBe("bun test tests/core.test.ts");
    expect(parsed.judge).toBe("bun run typecheck && grep -q foo src/");
  });

  test("rejects an invalid priority with ZodError", () => {
    expect(() => parseTaskInput({ ...MIN_VALID, priority: "urgent" })).toThrow(
      ZodError,
    );
  });

  test("rejects an invalid status with ZodError", () => {
    expect(() =>
      parseTaskInput({ ...MIN_VALID, status: "in-progress" }),
    ).toThrow(ZodError);
  });

  test("rejects a body shorter than 20 chars", () => {
    const res = TaskSchema.safeParse({ ...MIN_VALID, body: "too short" });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = res.error.issues.map((i) => i.message).join("\n");
      expect(msg).toMatch(/body/i);
    }
  });

  test("rejects a verify stub shorter than 10 chars (the Prettier-eats-`verify:` regression)", () => {
    const res = TaskSchema.safeParse({ ...MIN_VALID, verify: "true" });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = res.error.issues.map((i) => i.message).join("\n");
      expect(msg).toMatch(/verify/i);
    }
  });

  test("rejects a judge stub shorter than 10 chars", () => {
    const res = TaskSchema.safeParse({ ...MIN_VALID, judge: "ok" });
    expect(res.success).toBe(false);
  });

  test("rejects a malformed scheduled_for (bare date, no time/tz)", () => {
    const res = TaskSchema.safeParse({
      ...MIN_VALID,
      scheduled_for: "2026-05-01",
    });
    expect(res.success).toBe(false);
  });

  test("rejects missing required fields (external_id + repo + body + status)", () => {
    for (const missing of ["external_id", "repo", "body", "status"]) {
      const input: Record<string, unknown> = { ...MIN_VALID };
      delete input[missing];
      const res = TaskSchema.safeParse(input);
      expect(res.success).toBe(false);
      if (!res.success) {
        const paths = res.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain(missing);
      }
    }
  });
});
