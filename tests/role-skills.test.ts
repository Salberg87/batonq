// Tests for the per-role SKILL.md loader + per-runner injection wiring.
//
// We never let the loader hit the network — every test passes a synthetic
// fetcher and a per-test cache directory under tmpdir(). Runner-injection
// tests use the exported `buildXArgs` helpers so we never spawn the real
// CLIs either; the assertion is "the args/prompt this runner would pass
// to spawnSync include the SKILL.md via the documented mechanism".

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_ROLES,
  isAgentRole,
  loadRoleSkill,
  skillCachePath,
  skillUrl,
  type AgentRole,
} from "../src/agent-runners/role-skills";
import { applySkillToPrompt } from "../src/agent-runners/prompt-prepend";
import { buildClaudeArgs } from "../src/agent-runners/claude";
import { buildCodexArgs } from "../src/agent-runners/codex";
import { buildGeminiArgs } from "../src/agent-runners/gemini";
import { buildOpencodeArgs } from "../src/agent-runners/opencode";

function makeTmpCache(): string {
  return mkdtempSync(join(tmpdir(), "batonq-skills-test-"));
}

const trackedTmpDirs: string[] = [];
function track(dir: string): string {
  trackedTmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (trackedTmpDirs.length) {
    const d = trackedTmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("role-skills metadata", () => {
  test("AGENT_ROLES enumerates the five canonical roles", () => {
    expect(AGENT_ROLES).toEqual([
      "worker",
      "judge",
      "pr-runner",
      "explorer",
      "reviewer",
    ]);
  });

  test("isAgentRole accepts only those names", () => {
    for (const r of AGENT_ROLES) expect(isAgentRole(r)).toBe(true);
    expect(isAgentRole("nope")).toBe(false);
    expect(isAgentRole("Worker")).toBe(false); // case-sensitive
  });

  test("skillUrl points at the public Salberg87/batonq-skills repo", () => {
    expect(skillUrl("worker")).toBe(
      "https://raw.githubusercontent.com/Salberg87/batonq-skills/main/skills/batonq-worker/SKILL.md",
    );
    expect(skillUrl("pr-runner")).toBe(
      "https://raw.githubusercontent.com/Salberg87/batonq-skills/main/skills/batonq-pr-runner/SKILL.md",
    );
  });

  test("skillCachePath is per-role under the supplied root", () => {
    expect(skillCachePath("judge", "/x/y")).toBe("/x/y/judge/SKILL.md");
  });
});

describe("loadRoleSkill — cache + fetch behavior", () => {
  test("cache miss triggers fetch and writes the file", () => {
    const dir = track(makeTmpCache());
    let calls = 0;
    const result = loadRoleSkill("worker", {
      cacheDir: dir,
      fetcher: (url) => {
        calls += 1;
        expect(url).toBe(skillUrl("worker"));
        return "# worker skill\n";
      },
    });
    expect(calls).toBe(1);
    expect(result.fetched).toBe(true);
    expect(result.content).toBe("# worker skill\n");
    expect(result.path).toBe(`${dir}/worker/SKILL.md`);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toBe("# worker skill\n");
  });

  test("cache hit on a populated dir does NOT call the fetcher", () => {
    const dir = track(makeTmpCache());
    const fetcher = (url: string) => {
      // Should never run on the second call below.
      expect(url).toBe(skillUrl("judge"));
      return "judge content v1";
    };

    // Cold cache — populates.
    const first = loadRoleSkill("judge", { cacheDir: dir, fetcher });
    expect(first.fetched).toBe(true);

    // Warm cache — must not re-fetch. We swap to a fetcher that throws to
    // prove the loader never calls it.
    const second = loadRoleSkill("judge", {
      cacheDir: dir,
      fetcher: () => {
        throw new Error("fetcher must not run on cache hit");
      },
    });
    expect(second.fetched).toBe(false);
    expect(second.content).toBe("judge content v1");
    expect(second.path).toBe(first.path);
  });

  test("refresh:true busts the cache and re-fetches", () => {
    const dir = track(makeTmpCache());
    let counter = 0;
    const fetcher = () => `content v${++counter}`;

    const first = loadRoleSkill("explorer", { cacheDir: dir, fetcher });
    expect(first.content).toBe("content v1");
    expect(first.fetched).toBe(true);

    // Without refresh: cache hit.
    const cached = loadRoleSkill("explorer", { cacheDir: dir, fetcher });
    expect(cached.content).toBe("content v1");
    expect(cached.fetched).toBe(false);

    // With refresh: re-fetches and overwrites the cached file.
    const refreshed = loadRoleSkill("explorer", {
      cacheDir: dir,
      fetcher,
      refresh: true,
    });
    expect(refreshed.fetched).toBe(true);
    expect(refreshed.content).toBe("content v2");
    expect(readFileSync(refreshed.path, "utf8")).toBe("content v2");
  });

  test("BATONQ_SKILLS_REFRESH=1 env var also busts the cache", () => {
    const dir = track(makeTmpCache());
    let counter = 0;
    const fetcher = () => `env-bust v${++counter}`;

    loadRoleSkill("reviewer", { cacheDir: dir, fetcher });
    // Without env: cache hit.
    let result = loadRoleSkill("reviewer", { cacheDir: dir, fetcher });
    expect(result.fetched).toBe(false);

    // With env: re-fetches.
    const prev = process.env.BATONQ_SKILLS_REFRESH;
    process.env.BATONQ_SKILLS_REFRESH = "1";
    try {
      result = loadRoleSkill("reviewer", { cacheDir: dir, fetcher });
      expect(result.fetched).toBe(true);
      expect(result.content).toBe("env-bust v2");
    } finally {
      if (prev === undefined) delete process.env.BATONQ_SKILLS_REFRESH;
      else process.env.BATONQ_SKILLS_REFRESH = prev;
    }
  });
});

describe("applySkillToPrompt — shared prepend separator", () => {
  test("returns the prompt unchanged when no skill", () => {
    expect(applySkillToPrompt("hello", undefined)).toBe("hello");
    expect(applySkillToPrompt("hello", "")).toBe("hello");
  });

  test("inserts the SYSTEM/USER separator with the skill content", () => {
    const out = applySkillToPrompt("do the thing", "ROLE: worker\nrules");
    expect(out).toBe(
      "\n=== SYSTEM ===\nROLE: worker\nrules\n\n=== USER ===\ndo the thing",
    );
  });
});

describe("runner injection — claude uses --append-system-prompt-file", () => {
  test("buildClaudeArgs adds the file flag with the cached path", () => {
    const args = buildClaudeArgs(
      { prompt: "task body", cwd: "/tmp" },
      undefined,
      "/tmp/cache/worker/SKILL.md",
    );
    const idx = args.indexOf("--append-system-prompt-file");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/cache/worker/SKILL.md");
  });

  test("no skillPath → no --append-system-prompt-file flag", () => {
    const args = buildClaudeArgs(
      { prompt: "task body", cwd: "/tmp" },
      undefined,
    );
    expect(args).not.toContain("--append-system-prompt-file");
  });

  test("analyze mode does NOT inject the role skill flag", () => {
    // claude --print ignores --append-system-prompt[-file]; surfacing the
    // flag in analyze mode would mislead callers about its effect.
    const args = buildClaudeArgs(
      { prompt: "explain this", cwd: "/tmp", mode: "analyze" },
      undefined,
      "/tmp/cache/worker/SKILL.md",
    );
    expect(args).not.toContain("--append-system-prompt-file");
  });
});

describe("runner injection — codex prepends SYSTEM/USER separator", () => {
  test("buildCodexArgs prepends SKILL.md inside the prompt argv slot", () => {
    const args = buildCodexArgs(
      { prompt: "do work", cwd: "/tmp" },
      undefined,
      "ROLE BODY",
    );
    // Final argv slot is the prompt; everything before is flags.
    const finalPrompt = args[args.length - 1];
    expect(finalPrompt).toContain("=== SYSTEM ===");
    expect(finalPrompt).toContain("ROLE BODY");
    expect(finalPrompt).toContain("=== USER ===");
    expect(finalPrompt.endsWith("do work")).toBe(true);
  });

  test("analyze mode: SKILL.md is the SYSTEM block, hint stays in USER", () => {
    const args = buildCodexArgs(
      { prompt: "explain", cwd: "/tmp", mode: "analyze" },
      undefined,
      "ROLE BODY",
    );
    const finalPrompt = args[args.length - 1];
    // SYSTEM block contains the role, NOT the analyze hint.
    expect(finalPrompt.split("=== USER ===")[0]).toContain("ROLE BODY");
    expect(finalPrompt.split("=== USER ===")[0]).not.toContain("Read-only");
    // USER block contains both the analyze hint and the actual prompt.
    expect(finalPrompt.split("=== USER ===")[1]).toContain("Read-only");
    expect(finalPrompt.split("=== USER ===")[1]).toContain("explain");
  });
});

describe("runner injection — gemini prepends SYSTEM/USER separator", () => {
  test("buildGeminiArgs puts the prepended prompt right after -p", () => {
    const args = buildGeminiArgs(
      { prompt: "write tests", cwd: "/tmp" },
      undefined,
      "GEMINI ROLE",
    );
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThanOrEqual(0);
    const composed = args[pIdx + 1];
    expect(composed).toContain("=== SYSTEM ===");
    expect(composed).toContain("GEMINI ROLE");
    expect(composed).toContain("=== USER ===\nwrite tests");
    // Approval mode wiring stays intact alongside skill injection.
    expect(args).toContain("--approval-mode");
  });
});

describe("runner injection — opencode prepends SYSTEM/USER separator", () => {
  test("buildOpencodeArgs puts the prepended prompt as `run <msg>`", () => {
    const args = buildOpencodeArgs(
      { prompt: "ship it", cwd: "/tmp" },
      "OPENCODE ROLE",
    );
    expect(args[0]).toBe("run");
    const composed = args[1];
    expect(composed).toContain("=== SYSTEM ===");
    expect(composed).toContain("OPENCODE ROLE");
    expect(composed).toContain("=== USER ===\nship it");
  });

  test("no skill content → prompt passes through verbatim", () => {
    const args = buildOpencodeArgs(
      { prompt: "ship it", cwd: "/tmp" },
      undefined,
    );
    expect(args).toEqual(["run", "ship it"]);
  });
});

describe("runner injection covers every implemented role", () => {
  test("each role round-trips through every runner's builder", () => {
    const dir = track(makeTmpCache());
    for (const role of AGENT_ROLES as readonly AgentRole[]) {
      const skill = loadRoleSkill(role, {
        cacheDir: dir,
        fetcher: () => `# ${role}`,
      });
      const cArgs = buildClaudeArgs(
        { prompt: "p", cwd: "/tmp", role },
        undefined,
        skill.path,
      );
      expect(cArgs).toContain("--append-system-prompt-file");
      const xArgs = buildCodexArgs(
        { prompt: "p", cwd: "/tmp", role },
        undefined,
        skill.content,
      );
      expect(xArgs[xArgs.length - 1]).toContain(`# ${role}`);
      const gArgs = buildGeminiArgs(
        { prompt: "p", cwd: "/tmp", role },
        undefined,
        skill.content,
      );
      expect(gArgs[gArgs.indexOf("-p") + 1]).toContain(`# ${role}`);
      const oArgs = buildOpencodeArgs(
        { prompt: "p", cwd: "/tmp", role },
        skill.content,
      );
      expect(oArgs[1]).toContain(`# ${role}`);
    }
  });
});
