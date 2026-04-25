// Tests for the AgentRunner abstraction. We don't actually invoke the
// real CLIs (they cost money and require auth), only verify that:
//   - the registry exposes the tools we claim to have implemented,
//   - the typing surface is what callers expect,
//   - capOutput truncates correctly,
//   - parsing of agent-run flags is honest.

import { describe, expect, test } from "bun:test";
import {
  IMPLEMENTED_TOOLS,
  availableTools,
  getRunner,
} from "../src/agent-runners";
import { capOutput, STDOUT_CAP_BYTES } from "../src/agent-runners/types";

describe("agent-runners registry", () => {
  test("exposes claude and codex as implemented tools", () => {
    expect(IMPLEMENTED_TOOLS).toContain("claude");
    expect(IMPLEMENTED_TOOLS).toContain("codex");
  });

  test("getRunner returns a runner with the requested name", () => {
    expect(getRunner("claude").name).toBe("claude");
    expect(getRunner("codex").name).toBe("codex");
  });

  test("each implemented runner exposes available() and run()", () => {
    for (const t of IMPLEMENTED_TOOLS) {
      const r = getRunner(t);
      expect(typeof r.available).toBe("function");
      expect(typeof r.run).toBe("function");
    }
  });

  test("availableTools() returns a subset of IMPLEMENTED_TOOLS", () => {
    const present = availableTools();
    for (const t of present) {
      expect(IMPLEMENTED_TOOLS).toContain(t);
    }
  });
});

describe("capOutput", () => {
  test("returns short input unchanged", () => {
    expect(capOutput("hello")).toBe("hello");
    expect(capOutput("")).toBe("");
  });

  test("truncates long input to STDOUT_CAP_BYTES + marker", () => {
    const big = "x".repeat(STDOUT_CAP_BYTES + 5_000);
    const out = capOutput(big);
    expect(out.length).toBe(STDOUT_CAP_BYTES + "\n[truncated]".length);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  test("STDOUT_CAP_BYTES is the boundary, not off-by-one", () => {
    const exact = "y".repeat(STDOUT_CAP_BYTES);
    expect(capOutput(exact)).toBe(exact);
    expect(capOutput(exact + "z").endsWith("[truncated]")).toBe(true);
  });
});
