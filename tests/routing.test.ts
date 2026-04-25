// routing.test — task-type detection + oxo-inspired runner routing.
// Pure regex/dispatch logic, no DB or process spawn — fast and isolated.

import { describe, expect, test } from "bun:test";
import {
  detectTaskType,
  routeTask,
  ROUTING_TABLE,
  DEFAULT_ROUTING,
  TASK_TYPES,
  type TaskType,
} from "../src/agent-runners/routing";

describe("detectTaskType — regex classification per task type", () => {
  test("exploration: explore/investigate/research/understand", () => {
    expect(
      detectTaskType("Explore the auth module to map the session flow"),
    ).toBe("exploration");
    expect(detectTaskType("Investigate why the build is slow on CI")).toBe(
      "exploration",
    );
    expect(detectTaskType("Research how the indexer batches writes")).toBe(
      "exploration",
    );
  });

  test("implementation: implement/add feature/build endpoint", () => {
    expect(
      detectTaskType("Implement the new export endpoint with pagination"),
    ).toBe("implementation");
    expect(detectTaskType("Add a new feature for bulk task import")).toBe(
      "implementation",
    );
    expect(detectTaskType("Build a new component for the priority badge")).toBe(
      "implementation",
    );
  });

  test("architecture: architecture/redesign/system design", () => {
    expect(
      detectTaskType("Design the new caching architecture for the queue"),
    ).toBe("architecture");
    expect(
      detectTaskType("Redesign the runner registry to support plugins"),
    ).toBe("architecture");
  });

  test("review: code review/audit/find bugs", () => {
    expect(
      detectTaskType("Code review for the migrate-path PR before merging"),
    ).toBe("review");
    expect(detectTaskType("Audit the security of the claim TTL handler")).toBe(
      "review",
    );
    expect(detectTaskType("Find bugs in the priority sort path")).toBe(
      "review",
    );
  });

  test("quick_fix: typo/formatting/lint/whitespace", () => {
    expect(detectTaskType("Fix typo in README.md")).toBe("quick_fix");
    expect(
      detectTaskType("Reformat the agent-runners files via prettier"),
    ).toBe("quick_fix");
    expect(detectTaskType("Whitespace cleanup in tasks-core.ts")).toBe(
      "quick_fix",
    );
  });

  test("code_generation: generate boilerplate/scaffold/stub", () => {
    expect(detectTaskType("Generate boilerplate for a new MCP server")).toBe(
      "code_generation",
    );
    expect(detectTaskType("Scaffold the docs site folder layout")).toBe(
      "code_generation",
    );
  });

  test("bulk_analysis: across codebase/all files/patterns across", () => {
    expect(
      detectTaskType("Analyze TODO comments across the entire codebase"),
    ).toBe("bulk_analysis");
    expect(
      detectTaskType("Find patterns across all files that mention BATONQ_"),
    ).toBe("bulk_analysis");
  });

  test("refactor: refactor/extract method/rename function", () => {
    expect(
      detectTaskType("Refactor selectCandidate into smaller helpers"),
    ).toBe("refactor");
    expect(
      detectTaskType("Extract method runScheduleGate from selectCandidate"),
    ).toBe("refactor");
  });

  test("Norwegian bodies hit the same buckets as the English equivalents", () => {
    // TASKS.md mixes Norwegian and English freely — the regex must classify
    // both languages or it silently underroutes Norwegian-language tasks.
    expect(detectTaskType("Implementer ny feature for bulk task import")).toBe(
      "implementation",
    );
    expect(detectTaskType("Legg til en ny funksjon for eksport")).toBe(
      "implementation",
    );
    expect(
      detectTaskType("Refaktorer selectCandidate til mindre helpers"),
    ).toBe("refactor");
    expect(
      detectTaskType("Utforsk auth-modulen og kartlegg session-flow"),
    ).toBe("exploration");
    expect(detectTaskType("Undersøk hvorfor bygget er tregt på CI")).toBe(
      "exploration",
    );
    expect(detectTaskType("Gjennomgå PR-en før merge")).toBe("review");
    expect(detectTaskType("Kodegjennomgang av migrate-path")).toBe("review");
    expect(detectTaskType("Fiks skrivefeil i README.md")).toBe("quick_fix");
    expect(detectTaskType("Redesign arkitekturen for køen")).toBe(
      "architecture",
    );
    expect(detectTaskType("Generer boilerplate for ny MCP-server")).toBe(
      "code_generation",
    );
    expect(detectTaskType("Analyser TODO-kommentarer i hele kodebasen")).toBe(
      "bulk_analysis",
    );
  });

  test("ROUTING_TABLE covers every TaskType", () => {
    for (const t of TASK_TYPES) {
      expect(ROUTING_TABLE[t as TaskType]).toBeTruthy();
      expect(typeof ROUTING_TABLE[t as TaskType].agent).toBe("string");
      expect(typeof ROUTING_TABLE[t as TaskType].model).toBe("string");
    }
  });
});

describe("routeTask — explicit agent vs detection routing", () => {
  test("explicit agent overrides routing, body type is ignored", () => {
    // Body screams "exploration" — would normally route to gemini/flash —
    // but the explicit pin to claude wins.
    const explore = "Explore the codebase and investigate session lifecycle";
    expect(routeTask(explore, "claude")).toEqual({
      agent: "claude",
      model: "sonnet",
    });
    expect(routeTask(explore, "codex")).toEqual({
      agent: "codex",
      model: "default",
    });
    expect(routeTask(explore, "opencode")).toEqual({
      agent: "opencode",
      model: "default",
    });
    expect(routeTask(explore, "gemini")).toEqual({
      agent: "gemini",
      model: "flash",
    });
  });

  test("'any' falls back to detection — preferred routing for the type", () => {
    // refactor → codex/default
    expect(
      routeTask("Refactor the runner registry to use a Map", "any"),
    ).toEqual({ agent: "codex", model: "default" });
    // architecture → claude/opus
    expect(
      routeTask("Redesign the priority architecture for fairness", "any"),
    ).toEqual({ agent: "claude", model: "opus" });
    // bulk_analysis → gemini/pro
    expect(
      routeTask("Analyze patterns across the entire codebase", "any"),
    ).toEqual({ agent: "gemini", model: "pro" });
    // quick_fix → claude/haiku
    expect(routeTask("Fix typo in CHANGELOG", "any")).toEqual({
      agent: "claude",
      model: "haiku",
    });
  });

  test("undefined / null agent is treated as 'any'", () => {
    expect(routeTask("Explore the build pipeline", undefined)).toEqual({
      agent: "gemini",
      model: "flash",
    });
    expect(routeTask("Explore the build pipeline", null)).toEqual({
      agent: "gemini",
      model: "flash",
    });
  });

  test("unrecognized body falls back to claude/sonnet (implementation default)", () => {
    // No keywords match any pattern.
    const result = routeTask("xyz qrs lmnop random gibberish text 42", "any");
    expect(result).toEqual({ agent: "claude", model: "sonnet" });
    expect(result).toEqual(DEFAULT_ROUTING);
  });

  test("unrecognized agent value falls back to claude/sonnet", () => {
    // Defensive guard against legacy DB rows or hand-edited values that
    // somehow slipped past the schema.
    expect(
      routeTask("Refactor the runner registry to use a Map", "made-up-agent"),
    ).toEqual({ agent: "claude", model: "sonnet" });
  });
});
