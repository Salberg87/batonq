// context — ContextStrategy gathering tests. Exercises the simple-grep
// path against a temp repo, the "none" no-op, and the auto routing branch
// that should pick simple for quick_fix tasks. We don't try to assert
// against the real rlm warning text beyond "fell back to simple".

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gatherContext,
  CONTEXT_STRATEGIES,
  DEFAULT_CONTEXT_STRATEGY,
} from "../src/agent-runners/context";
import { detectTaskType } from "../src/agent-runners/routing";

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "batonq-ctx-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    const dir = full.slice(0, full.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("CONTEXT_STRATEGIES enum surface", () => {
  test("exposes the four oxo-canonical strategies in order", () => {
    expect([...CONTEXT_STRATEGIES]).toEqual(["none", "simple", "rlm", "auto"]);
  });

  test("default is none — opt-in to context for existing tasks", () => {
    expect(DEFAULT_CONTEXT_STRATEGY).toBe("none");
  });
});

describe("gatherContext('none')", () => {
  test("returns empty string regardless of body or repo", () => {
    expect(gatherContext("anything goes here", "none", "/tmp")).toBe("");
    expect(
      gatherContext(
        "implement totally unique keyword: zztopfoobar",
        "none",
        "/tmp",
      ),
    ).toBe("");
  });
});

describe("gatherContext('simple')", () => {
  test("gathers grep hits for keywords found in the repo", () => {
    const repo = makeRepo({
      "src/widgetfoo.ts": [
        "// header line",
        "export function widgetfoo() {",
        "  return 'widgetfoo handler';",
        "}",
        "// trailer",
      ].join("\n"),
      "README.md": "Unrelated content here.",
    });
    try {
      // Body uses a unique-ish keyword we know exists. Length ≥ 4 to clear
      // the keyword extractor's threshold.
      const ctx = gatherContext(
        "Refactor the widgetfoo helper to handle empty input",
        "simple",
        repo,
      );
      expect(ctx).toContain("## Relevant code");
      expect(ctx).toContain("widgetfoo");
      expect(ctx).toMatch(/src\/widgetfoo\.ts:\d+/);
      // 5-line window: the file is 5 lines so we should see the hit line plus
      // surrounding lines, formatted with line numbers.
      expect(ctx).toMatch(/\d+: /);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("returns empty when no keyword from the body matches", () => {
    const repo = makeRepo({
      "src/only.ts": "export const value = 42;\n",
    });
    try {
      const ctx = gatherContext(
        "Add zztopfoobar barbazquux gizmoflux endpoint",
        "simple",
        repo,
      );
      expect(ctx).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("gatherContext('auto')", () => {
  test("routes to simple for quick_fix tasks (and that's the type)", () => {
    const body = "Fix typo in widgetfoo helper docstring";
    // Sanity-check the routing premise — if detectTaskType stops returning
    // quick_fix this test gets to fail loudly rather than silently passing.
    expect(detectTaskType(body)).toBe("quick_fix");

    const repo = makeRepo({
      "src/widgetfoo.ts": "export const widgetfoo = () => 'hi';\n",
    });
    try {
      const auto = gatherContext(body, "auto", repo);
      const simple = gatherContext(body, "simple", repo);
      // quick_fix → simple, so auto and simple must produce the same content.
      expect(auto).toBe(simple);
      expect(auto).toContain("widgetfoo");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("non-quick_fix bodies fall through to simple via the rlm stub", () => {
    const body = "Implement the new widgetfoo export endpoint with pagination";
    expect(detectTaskType(body)).toBe("implementation");

    const repo = makeRepo({
      "src/widgetfoo.ts": "export const widgetfoo = () => 'hi';\n",
    });
    try {
      // Auto for non-quick_fix prints the rlm-fallback warning to stderr but
      // returns the simple-strategy output. We only assert on the return.
      const auto = gatherContext(body, "auto", repo);
      expect(auto).toContain("widgetfoo");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("gatherContext('rlm') — stubbed, falls back to simple", () => {
  test("returns the same content the simple strategy would for the same body", () => {
    const repo = makeRepo({
      "src/widgetfoo.ts": "export const widgetfoo = () => 1;\n",
    });
    try {
      const body = "Audit widgetfoo coverage in the repo";
      const rlm = gatherContext(body, "rlm", repo);
      const simple = gatherContext(body, "simple", repo);
      expect(rlm).toBe(simple);
      expect(rlm).toContain("widgetfoo");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
