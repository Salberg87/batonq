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
import {
  capOutput,
  resolveModel,
  STDOUT_CAP_BYTES,
} from "../src/agent-runners/types";
import {
  CLAUDE_MODELS,
  buildClaudeArgs,
  extractSessionId,
} from "../src/agent-runners/claude";
import { CODEX_MODELS } from "../src/agent-runners/codex";
import { GEMINI_MODELS } from "../src/agent-runners/gemini";

describe("agent-runners registry", () => {
  test("exposes claude, codex, gemini, opencode as implemented tools", () => {
    expect(IMPLEMENTED_TOOLS).toContain("claude");
    expect(IMPLEMENTED_TOOLS).toContain("codex");
    expect(IMPLEMENTED_TOOLS).toContain("gemini");
    expect(IMPLEMENTED_TOOLS).toContain("opencode");
  });

  test("getRunner returns a runner with the requested name", () => {
    expect(getRunner("claude").name).toBe("claude");
    expect(getRunner("codex").name).toBe("codex");
    expect(getRunner("gemini").name).toBe("gemini");
    expect(getRunner("opencode").name).toBe("opencode");
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

describe("resolveModel — nickname → real id translation", () => {
  test("returns undefined when nickname is undefined", () => {
    expect(resolveModel(undefined, CLAUDE_MODELS)).toBeUndefined();
  });

  test("translates known Claude nicknames", () => {
    expect(resolveModel("opus", CLAUDE_MODELS)).toBe(CLAUDE_MODELS.opus);
    expect(resolveModel("sonnet", CLAUDE_MODELS)).toBe(CLAUDE_MODELS.sonnet);
    expect(resolveModel("haiku", CLAUDE_MODELS)).toBe(CLAUDE_MODELS.haiku);
  });

  test("translates known Gemini nicknames", () => {
    expect(resolveModel("pro", GEMINI_MODELS)).toBe(GEMINI_MODELS.pro);
    expect(resolveModel("flash", GEMINI_MODELS)).toBe(GEMINI_MODELS.flash);
  });

  test("passes unknown nicknames through verbatim (caller can supply full id)", () => {
    const fullId = "claude-opus-4-99-20300101";
    expect(resolveModel(fullId, CLAUDE_MODELS)).toBe(fullId);
    expect(resolveModel("gemini-99-ultra", GEMINI_MODELS)).toBe(
      "gemini-99-ultra",
    );
  });
});

describe("Claude session continuity (fan-out 6/6)", () => {
  test("extractSessionId pulls the id out of stream-json output", () => {
    // Mimics what `claude -p --output-format stream-json` emits per event.
    const stdout =
      `{"type":"system","session_id":"3f2b1c0a-1111-2222-3333-abcdef012345"}\n` +
      `{"type":"message","content":"hello"}\n`;
    expect(extractSessionId(stdout)).toBe(
      "3f2b1c0a-1111-2222-3333-abcdef012345",
    );
  });

  test("extractSessionId also handles the human 'Session ID:' form", () => {
    const stdout = "doing work...\nSession ID: deadbeef-cafe-1234\nbye\n";
    expect(extractSessionId(stdout)).toBe("deadbeef-cafe-1234");
  });

  test("extractSessionId returns undefined when no id is present", () => {
    expect(extractSessionId("")).toBeUndefined();
    expect(
      extractSessionId("just plain output, no session here"),
    ).toBeUndefined();
  });

  test("follow-up dispatch with parentSessionId emits --continue <id>", () => {
    const args = buildClaudeArgs(
      {
        prompt: "retry after judge FAIL",
        cwd: "/tmp",
        parentSessionId: "3f2b1c0a-1111-2222-3333-abcdef012345",
      },
      undefined,
    );
    const idx = args.indexOf("--continue");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("3f2b1c0a-1111-2222-3333-abcdef012345");
  });

  test("no parentSessionId → no --continue flag (fresh session)", () => {
    const args = buildClaudeArgs({ prompt: "hello", cwd: "/tmp" }, undefined);
    expect(args).not.toContain("--continue");
  });

  test("blank parentSessionId is treated as absent (no --continue)", () => {
    const args = buildClaudeArgs(
      { prompt: "hello", cwd: "/tmp", parentSessionId: "   " },
      undefined,
    );
    expect(args).not.toContain("--continue");
  });

  // End-to-end of the dispatcher pattern: a judge-FAIL on a parent task
  // produces a follow-up task. The dispatcher only forwards the parent's
  // session_id when the follow-up's reuse_session flag is set — proving
  // the kill switch works and the runner stays opt-in (not auto-pull).
  test("judge-FAIL → retry chain: dispatcher forwards parent session_id only when reuse_session=true", () => {
    const PARENT_SESSION = "feedface-1234-5678-9abc-def012345678";

    // Simulated parent task row that captured a session id from its run.
    const parent = { external_id: "p1", session_id: PARENT_SESSION };

    // Tiny dispatcher: this is the gating logic the loop will own. Only
    // forward parent session_id when the follow-up explicitly opted in.
    function dispatchArgs(followUp: { reuse_session?: boolean }): string[] {
      const parentSessionId = followUp.reuse_session
        ? parent.session_id
        : undefined;
      return buildClaudeArgs(
        { prompt: "retry attempt", cwd: "/tmp", parentSessionId },
        undefined,
      );
    }

    // Default (reuse_session=false): fresh session, no --continue.
    const freshArgs = dispatchArgs({ reuse_session: false });
    expect(freshArgs).not.toContain("--continue");

    // Opt-in (reuse_session=true): --continue with parent's session id.
    const continuingArgs = dispatchArgs({ reuse_session: true });
    const idx = continuingArgs.indexOf("--continue");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(continuingArgs[idx + 1]).toBe(PARENT_SESSION);
  });
});

describe("MODELS maps cover the documented nicknames", () => {
  test("Claude has opus/sonnet/haiku", () => {
    for (const k of ["opus", "sonnet", "haiku"]) {
      expect(CLAUDE_MODELS[k]).toBeTruthy();
    }
  });

  test("Codex has at least 'default'", () => {
    expect(CODEX_MODELS["default"]).toBeTruthy();
  });

  test("Gemini has pro/flash", () => {
    expect(GEMINI_MODELS["pro"]).toBeTruthy();
    expect(GEMINI_MODELS["flash"]).toBeTruthy();
  });
});
