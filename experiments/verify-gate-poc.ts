// verify-gate-poc — proof-of-concept for the pi-agent pattern applied to
// batonq's verify/judge gates.
//
// Today batonq runs verify *post-hoc*: claude/codex/gemini/opencode finishes
// its loop, calls `batonq done <id>`, and the done command shells out to
// verify_cmd. If the agent self-closed before doing the work, we catch the
// cheat in the alert lane — but only after the fact.
//
// pi-agent's pattern (beforeToolCall / afterToolCall hooks) lets us flip that
// inside-out: when the agent itself reaches the "complete" tool, the hook
// runs verify_cmd RIGHT THERE. Pass → terminate the loop with success. Fail
// → block the tool, return a "verify failed, keep working" tool result, and
// let the agent self-correct. Cheats become impossible at the gate; the
// agent learns mid-flight what done means.
//
// This file demonstrates the shape. No real LLM — we simulate the agent's
// tool-call sequence inline so we can see the hook lifecycle without an API
// key. Two scenarios:
//   1. honest agent: edits a file, then completes → verify passes → done
//   2. cheating agent: completes without editing → verify fails → blocked
//
// Run: bun experiments/verify-gate-poc.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── core primitives (mirrors pi-agent's surface) ───────────────────────────

type ToolCall = { name: string; args: Record<string, unknown> };
type ToolResult = { ok: boolean; output: string };

type Tool = {
  name: string;
  exec: (args: Record<string, unknown>, ctx: AgentCtx) => ToolResult;
};

type AgentCtx = {
  cwd: string;
  verifyCmd: string;
  // The two hooks that matter. block:true short-circuits the tool exec and
  // returns a synthetic result to the agent (so it sees "this didn't work,
  // try again"). terminate:true ends the agent loop after this tool's result
  // is visible — the success path for "complete".
  beforeToolCall?: (
    call: ToolCall,
  ) => { block?: boolean; reason?: string } | undefined;
  afterToolCall?: (
    call: ToolCall,
    result: ToolResult,
  ) => { terminate?: boolean } | undefined;
};

function runAgent(
  ctx: AgentCtx,
  tools: Map<string, Tool>,
  scriptedCalls: ToolCall[],
): { trace: string[]; outcome: "completed" | "exhausted" | "blocked" } {
  const trace: string[] = [];
  for (const call of scriptedCalls) {
    const tool = tools.get(call.name);
    if (!tool) {
      trace.push(`[unknown-tool] ${call.name}`);
      continue;
    }
    // beforeToolCall: gate the call. If verify-gate blocks, the tool never
    // executes — the agent sees a tool-result saying "blocked, here's why."
    const pre = ctx.beforeToolCall?.(call);
    if (pre?.block) {
      trace.push(`[blocked] ${call.name}: ${pre.reason ?? "no reason"}`);
      // In a real loop this synthetic result would go back to the agent and
      // it would try again. The PoC just records the block and moves on.
      continue;
    }
    const result = tool.exec(call.args, ctx);
    trace.push(
      `[tool] ${call.name} → ${result.ok ? "ok" : "fail"}: ${result.output}`,
    );
    const post = ctx.afterToolCall?.(call, result);
    if (post?.terminate) {
      trace.push(`[terminate] ${call.name} signalled completion`);
      return { trace, outcome: "completed" };
    }
  }
  return { trace, outcome: "exhausted" };
}

// ── tools ─────────────────────────────────────────────────────────────────

const editFile: Tool = {
  name: "edit_file",
  exec: (args, ctx) => {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    writeFileSync(join(ctx.cwd, path), content);
    return { ok: true, output: `wrote ${content.length} bytes to ${path}` };
  },
};

// "complete" is a marker tool — its real job is to TRIGGER the verify-gate.
// The tool body does nothing; the hook around it is the whole story.
const complete: Tool = {
  name: "complete",
  exec: () => ({ ok: true, output: "agent declared done" }),
};

// ── verify-gate hook ──────────────────────────────────────────────────────

function verifyGateHook(ctx: AgentCtx) {
  return (call: ToolCall) => {
    if (call.name !== "complete") return undefined;
    const r = spawnSync("bash", ["-c", ctx.verifyCmd], {
      cwd: ctx.cwd,
      encoding: "utf8",
    });
    if (r.status === 0) return undefined; // pass — let "complete" execute
    return {
      block: true,
      reason: `verify failed (exit ${r.status}): ${(r.stderr || r.stdout || "")
        .trim()
        .slice(0, 120)}`,
    };
  };
}

function terminateOnComplete() {
  return (call: ToolCall, _result: ToolResult) => {
    if (call.name === "complete") return { terminate: true as const };
    return undefined;
  };
}

// ── scenarios ─────────────────────────────────────────────────────────────

function scenario(name: string, scripted: ToolCall[], verifyCmd: string) {
  const cwd = mkdtempSync(join(tmpdir(), "verify-gate-"));
  try {
    const ctx: AgentCtx = {
      cwd,
      verifyCmd,
    };
    ctx.beforeToolCall = verifyGateHook(ctx);
    ctx.afterToolCall = terminateOnComplete();
    const tools = new Map<string, Tool>([
      [editFile.name, editFile],
      [complete.name, complete],
    ]);
    console.log(`\n── ${name} ──`);
    const { trace, outcome } = runAgent(ctx, tools, scripted);
    for (const line of trace) console.log("  " + line);
    console.log(`  outcome: ${outcome}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Scenario 1 — honest agent. Edits hello.txt with "hi", then completes.
// verify_cmd checks the file's content. Expected: complete succeeds, agent
// terminates with success.
scenario(
  "honest agent (does work, then completes)",
  [
    { name: "edit_file", args: { path: "hello.txt", content: "hi" } },
    { name: "complete", args: {} },
  ],
  "test \"$(cat hello.txt)\" = 'hi'",
);

// Scenario 2 — cheating agent. Skips the work, calls complete immediately.
// Same verify_cmd. Expected: pre-hook blocks, "complete" never executes,
// agent does NOT receive terminate, loop exits "exhausted" — exactly the
// cheat-detection signal we want, but caught BEFORE the task is marked done.
scenario(
  "cheating agent (skips work, declares done)",
  [{ name: "complete", args: {} }],
  "test \"$(cat hello.txt)\" = 'hi'",
);

// Scenario 3 — agent self-corrects after a block. First tries to complete
// without work (blocked), then does the work, then completes (passes). The
// real win: the agent sees the block reason as a tool-result and can react.
scenario(
  "self-correcting agent (cheats, gets blocked, then does the work)",
  [
    { name: "complete", args: {} }, // blocked
    { name: "edit_file", args: { path: "hello.txt", content: "hi" } },
    { name: "complete", args: {} }, // passes
  ],
  "test \"$(cat hello.txt)\" = 'hi'",
);
