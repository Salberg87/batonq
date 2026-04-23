// current-task-card.test — §2 of docs/tui-ux-v2.md.
// Covers the three task requirements:
//   (a) card renders with the correct elapsed string
//   (b) edits/bash counts are read from a mock events.jsonl tail
//   (c) idle banner renders when there is no active claim

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCurrentTaskInfo,
  countSessionEvents,
  CurrentTaskCard,
  formatElapsed,
  IdleBanner,
  lastActivityRelative,
} from "../src/current-task-card";
import { readEventsTail, type EventRow, type TaskRow } from "../src/tui-data";

const NOW = Date.parse("2026-04-24T00:00:00.000Z");
const iso = (offsetSec: number): string =>
  new Date(NOW + offsetSec * 1000).toISOString();

const SESSION = "64578277-2442-4254-b086-8d412ba6608f";

function mkClaimedTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 1,
    external_id: "abcdef0123456789",
    repo: "batonq",
    body:
      "Implementer TUI §2 (Current-task card) fra docs/tui-ux-v2.md. " +
      "Erstatt Active claims-panelet med en 5-7 lines card",
    status: "claimed",
    claimed_by: "pid_28108",
    claimed_at: iso(-125), // claimed 2 min 5 sec ago
    completed_at: null,
    created_at: iso(-3600),
    verify_cmd: "bun test tests/current-task-card.test.ts",
    judge_cmd: "did the card render correctly?",
    ...overrides,
  };
}

// ── formatElapsed ─────────────────────────────────────────────────────────────

describe("formatElapsed", () => {
  test("claimed_at 125s ago renders as '2m 5s'", () => {
    expect(formatElapsed(iso(-125), NOW)).toBe("2m 5s");
  });
  test("claimed_at 0s ago renders as '0m 0s'", () => {
    expect(formatElapsed(iso(0), NOW)).toBe("0m 0s");
  });
  test("null / unparsable → '?'", () => {
    expect(formatElapsed(null, NOW)).toBe("?");
    expect(formatElapsed("not-iso", NOW)).toBe("?");
  });
});

// ── countSessionEvents ────────────────────────────────────────────────────────

describe("countSessionEvents", () => {
  const events: EventRow[] = [
    // Before claim — excluded by `since`
    { ts: iso(-300), phase: "pre", session: SESSION, tool: "Edit" },
    // After claim, other session — excluded by `session` filter
    { ts: iso(-60), phase: "pre", session: "other-session", tool: "Edit" },
    // After claim, target session — counted (edit)
    { ts: iso(-50), phase: "pre", session: SESSION, tool: "Edit" },
    // post event — de-duped so Edit counts only once
    { ts: iso(-50), phase: "post", session: SESSION, tool: "Edit" },
    // Write counts as edit
    { ts: iso(-40), phase: "pre", session: SESSION, tool: "Write" },
    // Read is neither edit nor bash
    { ts: iso(-35), phase: "pre", session: SESSION, tool: "Read" },
    // Bash counts
    { ts: iso(-20), phase: "pre", session: SESSION, tool: "Bash" },
    { ts: iso(-10), phase: "pre", session: SESSION, tool: "Bash" },
  ];

  test("counts edits + bash since claim, filtered by session", () => {
    const r = countSessionEvents(events, {
      session: SESSION,
      since: iso(-125),
    });
    expect(r.edits).toBe(2); // Edit + Write (Edit post-event de-duped)
    expect(r.bash).toBe(2); // two Bash events
    expect(r.lastTs).toBe(iso(-10));
  });

  test("respects cwdPrefix when no session is provided", () => {
    const withCwd: EventRow[] = [
      { ts: iso(-50), phase: "pre", cwd: "/Users/x/repo-a/src", tool: "Edit" },
      { ts: iso(-40), phase: "pre", cwd: "/Users/x/repo-b/src", tool: "Edit" },
      { ts: iso(-30), phase: "pre", cwd: "/Users/x/repo-a", tool: "Bash" },
    ];
    const r = countSessionEvents(withCwd, {
      cwdPrefix: "/Users/x/repo-a",
      since: iso(-125),
    });
    expect(r.edits).toBe(1);
    expect(r.bash).toBe(1);
  });

  test("reads real events.jsonl tail and counts session events", () => {
    const dir = mkdtempSync(join(tmpdir(), "batonq-card-"));
    try {
      const p = join(dir, "events.jsonl");
      const lines = events.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(p, lines + "\n");
      const tail = readEventsTail(p, 50);
      const r = countSessionEvents(tail, {
        session: SESSION,
        since: iso(-125),
      });
      expect(r.edits).toBe(2);
      expect(r.bash).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── lastActivityRelative staleness colors ─────────────────────────────────────

describe("lastActivityRelative", () => {
  test("< 2m → ok (green)", () => {
    expect(lastActivityRelative(iso(-30), NOW).color).toBe("ok");
  });
  test("> 2m, ≤ 5m → warn (yellow)", () => {
    expect(lastActivityRelative(iso(-3 * 60), NOW).color).toBe("warn");
  });
  test("> 5m → err (red)", () => {
    expect(lastActivityRelative(iso(-6 * 60), NOW).color).toBe("err");
  });
  test("null → dim + em-dash", () => {
    const r = lastActivityRelative(null, NOW);
    expect(r.color).toBe("dim");
    expect(r.text).toBe("—");
  });
});

// ── CurrentTaskCard rendering (required test: elapsed correctness) ────────────

describe("CurrentTaskCard", () => {
  test("renders id, elapsed, body preview, counts, verify/judge status", () => {
    const task = mkClaimedTask();
    const events: EventRow[] = [
      { ts: iso(-60), phase: "pre", session: SESSION, tool: "Edit" },
      { ts: iso(-40), phase: "pre", session: SESSION, tool: "Write" },
      { ts: iso(-20), phase: "pre", session: SESSION, tool: "Bash" },
    ];
    const info = buildCurrentTaskInfo({
      task,
      claim: {
        id: 1,
        fingerprint: "fp",
        file_path: "/Users/x/DEV/batonq/src/tui.tsx",
        session_id: SESSION,
        acquired_at: iso(-125),
        expires_at: iso(60),
        released_at: null,
        holder_cwd: "/Users/x/DEV/batonq",
      },
      events,
      now: NOW,
    });
    const { lastFrame, unmount } = render(
      React.createElement(CurrentTaskCard, { info }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Active task");
    expect(out).toContain("abcdef01"); // short external_id
    expect(out).toContain("2m 5s"); // elapsed
    expect(out).toContain("Implementer TUI"); // body preview
    expect(out).toContain("2 edits"); // Edit + Write
    expect(out).toContain("1 bash"); // Bash count
    expect(out).toContain("verify:");
    expect(out).toContain("✓ captured"); // verify_cmd present
    expect(out).toContain("judge:");
    unmount();
  });

  test("body preview truncates at 120 chars with ellipsis", () => {
    const longBody = "x".repeat(200);
    const task = mkClaimedTask({ body: longBody });
    const info = buildCurrentTaskInfo({
      task,
      claim: null,
      events: [],
      now: NOW,
    });
    expect(info.bodyPreview.length).toBeLessThanOrEqual(120);
    expect(info.bodyPreview.endsWith("…")).toBe(true);
  });

  test("verify/judge missing when cmd columns are empty", () => {
    const task = mkClaimedTask({ verify_cmd: null, judge_cmd: "" });
    const info = buildCurrentTaskInfo({
      task,
      claim: null,
      events: [],
      now: NOW,
    });
    const { lastFrame, unmount } = render(
      React.createElement(CurrentTaskCard, { info }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("verify:");
    expect(out).toContain("missing");
    unmount();
  });

  test("latest commit row shows sha + subject when supplied", () => {
    const task = mkClaimedTask();
    const info = buildCurrentTaskInfo({
      task,
      claim: null,
      events: [],
      now: NOW,
      commit: { sha: "deadbee", subject: "feat(tui): add current-task card" },
    });
    const { lastFrame, unmount } = render(
      React.createElement(CurrentTaskCard, { info }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("latest commit:");
    expect(out).toContain("deadbee");
    expect(out).toContain("add current-task card");
    unmount();
  });
});

// ── IdleBanner (required test: idle state) ────────────────────────────────────

describe("IdleBanner", () => {
  test("renders '— idle (queue: N pending) —' when no task is claimed", () => {
    const { lastFrame, unmount } = render(
      React.createElement(IdleBanner, { pendingCount: 4 }),
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("idle");
    expect(out).toContain("queue: 4 pending");
    unmount();
  });

  test("pendingCount of 0 still renders without a crash", () => {
    const { lastFrame, unmount } = render(
      React.createElement(IdleBanner, { pendingCount: 0 }),
    );
    expect(lastFrame() ?? "").toContain("queue: 0 pending");
    unmount();
  });
});
