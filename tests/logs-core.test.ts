// logs-core.test — covers the pure helpers that back `batonq logs`.
// Tests the three behaviors mandated by the spec:
//   1. -n N yields exactly N lines from the tail.
//   2. --source filter is respected (events-only / loop-only / both).
//   3. Merge sort is stable: equal timestamps keep insertion order.
// Plus a few sanity probes (classification, format, newest-file glob).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyLoopLine,
  colorize,
  formatEventLine,
  mergeAndTail,
  newestLoopLog,
  readEvents,
  readLoop,
  type LogRecord,
} from "../src/logs-core";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "batonq-logs-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function makeEventRec(tsIso: string, i: number): LogRecord {
  return {
    ts: Date.parse(tsIso),
    source: "events",
    line: `event-${i}`,
    level: "info",
  };
}

function makeLoopRec(ts: number, i: number): LogRecord {
  return {
    ts,
    source: "loop",
    line: `loop-${i}`,
    level: "info",
  };
}

// ── 1. -n N yields exactly N lines ────────────────────────────────────────────

describe("mergeAndTail — last-N", () => {
  test("returns exactly N most-recent combined lines when both sources populated", () => {
    const events: LogRecord[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(
        makeEventRec(`2026-04-23T12:00:${String(i).padStart(2, "0")}Z`, i),
      );
    }
    const loop: LogRecord[] = [];
    for (let i = 0; i < 10; i++) {
      // Loop batch timestamp > all events, so they sort to the end.
      loop.push(makeLoopRec(Date.parse("2026-04-23T12:05:00Z"), i));
    }

    const got = mergeAndTail(events, loop, { source: "both", n: 5 });
    expect(got.length).toBe(5);
    // Last 5 should be the last 5 loop records in file order.
    expect(got.map((r) => r.line)).toEqual([
      "loop-5",
      "loop-6",
      "loop-7",
      "loop-8",
      "loop-9",
    ]);
  });

  test("n <= 0 returns everything", () => {
    const events = [
      makeEventRec("2026-04-23T12:00:00Z", 0),
      makeEventRec("2026-04-23T12:00:01Z", 1),
    ];
    const loop = [makeLoopRec(Date.parse("2026-04-23T12:00:02Z"), 0)];
    const got = mergeAndTail(events, loop, { source: "both", n: 0 });
    expect(got.length).toBe(3);
  });

  test("n larger than total returns everything without padding", () => {
    const events = [makeEventRec("2026-04-23T12:00:00Z", 0)];
    const loop = [makeLoopRec(Date.parse("2026-04-23T12:00:01Z"), 0)];
    const got = mergeAndTail(events, loop, { source: "both", n: 999 });
    expect(got.length).toBe(2);
  });
});

// ── 2. --source filter is respected ───────────────────────────────────────────

describe("mergeAndTail — source filter", () => {
  const events = [
    makeEventRec("2026-04-23T12:00:00Z", 0),
    makeEventRec("2026-04-23T12:00:01Z", 1),
  ];
  const loop = [
    makeLoopRec(Date.parse("2026-04-23T12:00:02Z"), 0),
    makeLoopRec(Date.parse("2026-04-23T12:00:03Z"), 1),
  ];

  test("source=events excludes loop lines", () => {
    const got = mergeAndTail(events, loop, { source: "events", n: 100 });
    expect(got.every((r) => r.source === "events")).toBe(true);
    expect(got.length).toBe(2);
  });

  test("source=loop excludes event lines", () => {
    const got = mergeAndTail(events, loop, { source: "loop", n: 100 });
    expect(got.every((r) => r.source === "loop")).toBe(true);
    expect(got.length).toBe(2);
  });

  test("source=both includes both, ordered by ts", () => {
    const got = mergeAndTail(events, loop, { source: "both", n: 100 });
    expect(got.length).toBe(4);
    expect(got.map((r) => r.source)).toEqual([
      "events",
      "events",
      "loop",
      "loop",
    ]);
  });
});

// ── 3. Stable sort on equal timestamps ────────────────────────────────────────

describe("mergeAndTail — stable timestamp sort", () => {
  test("records with identical ts preserve insertion order (events before loop)", () => {
    const sameTs = Date.parse("2026-04-23T12:00:00Z");
    const events: LogRecord[] = [
      { ts: sameTs, source: "events", line: "E1", level: "info" },
      { ts: sameTs, source: "events", line: "E2", level: "info" },
    ];
    const loop: LogRecord[] = [
      { ts: sameTs, source: "loop", line: "L1", level: "info" },
      { ts: sameTs, source: "loop", line: "L2", level: "info" },
    ];
    const got = mergeAndTail(events, loop, { source: "both", n: 100 });
    // Events are concatenated first in mergeAndTail, so at equal ts they win.
    expect(got.map((r) => r.line)).toEqual(["E1", "E2", "L1", "L2"]);
  });

  test("mixed ts: strictly older ts sorts before, equal ts keeps original order", () => {
    const older = Date.parse("2026-04-23T12:00:00Z");
    const newer = Date.parse("2026-04-23T12:00:01Z");
    const events: LogRecord[] = [
      { ts: newer, source: "events", line: "E-newer", level: "info" },
      { ts: older, source: "events", line: "E-older", level: "info" },
    ];
    const loop: LogRecord[] = [
      { ts: newer, source: "loop", line: "L-newer-1", level: "info" },
      { ts: newer, source: "loop", line: "L-newer-2", level: "info" },
    ];
    const got = mergeAndTail(events, loop, { source: "both", n: 100 });
    expect(got.map((r) => r.line)).toEqual([
      "E-older",
      "E-newer",
      "L-newer-1",
      "L-newer-2",
    ]);
  });
});

// ── 4. Event formatter matches `batonq tail` output ───────────────────────────

describe("formatEventLine", () => {
  test("renders a well-formed event in the expected one-liner shape", () => {
    const raw = JSON.stringify({
      ts: "2026-04-23T13:45:07.123Z",
      session: "abc12345deadbeef",
      tool: "Edit",
      phase: "pre",
      git_root: "/Users/x/DEV/repo",
      paths: ["/Users/x/DEV/repo/src/foo.ts"],
    });
    const got = formatEventLine(raw);
    expect(got).not.toBeNull();
    expect(got!.ts).toBe(Date.parse("2026-04-23T13:45:07.123Z"));
    // Time slice + session[:8] + tool padded + phase padded + repo/rel
    expect(got!.line).toBe(
      "13:45:07  abc12345  Edit      pre  repo/src/foo.ts",
    );
  });

  test("returns null for malformed JSON and for entries without ts", () => {
    expect(formatEventLine("not json")).toBeNull();
    expect(formatEventLine("{}")).toBeNull();
  });
});

// ── 5. Loop line classification → error paints red ────────────────────────────

describe("classifyLoopLine", () => {
  test("flags lines containing 'error', 'fatal', 'fail', or '✗' as error", () => {
    expect(classifyLoopLine("something went wrong: ERROR: boom")).toBe("error");
    expect(classifyLoopLine("Fatal: unreachable")).toBe("error");
    expect(classifyLoopLine("verify FAILED")).toBe("error");
    expect(classifyLoopLine("✗ watchdog fired")).toBe("error");
    expect(classifyLoopLine("→ batonq pick")).toBe("info");
  });
});

// ── 6. File readers: events + loop + newestLoopLog glob ───────────────────────

describe("readEvents / readLoop / newestLoopLog", () => {
  test("readEvents parses valid JSONL lines and skips blanks/garbage", () => {
    const path = join(workdir, "events.jsonl");
    const lines = [
      JSON.stringify({
        ts: "2026-04-23T10:00:00Z",
        session: "sess1aaaa",
        tool: "Read",
        phase: "pre",
        git_root: "/r",
        paths: ["/r/a.ts"],
      }),
      "",
      "not-json-noise",
      JSON.stringify({
        ts: "2026-04-23T10:00:01Z",
        session: "sess2bbbb",
        tool: "Edit",
        phase: "post",
        git_root: "/r",
        paths: ["/r/b.ts"],
      }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const got = readEvents(path);
    expect(got.length).toBe(2);
    expect(got.every((r) => r.source === "events")).toBe(true);
  });

  test("readLoop assigns every line the file mtime and flags errors", () => {
    const path = join(workdir, "batonq-loop.log");
    writeFileSync(path, "→ batonq pick\n✗ watchdog fired\n");
    const fixedMtime = Math.floor(Date.now() / 1000) - 42;
    utimesSync(path, fixedMtime, fixedMtime);
    const got = readLoop(path);
    expect(got.length).toBe(2);
    expect(got[0]!.source).toBe("loop");
    expect(got[0]!.level).toBe("info");
    expect(got[1]!.level).toBe("error");
    // Both lines share the file mtime.
    expect(got[0]!.ts).toBe(got[1]!.ts);
  });

  test("newestLoopLog picks the freshest matching file in the directory", () => {
    const a = join(workdir, "batonq-loop.log");
    const b = join(workdir, "batonq-loop-other.log");
    const c = join(workdir, "unrelated.log");
    writeFileSync(a, "a\n");
    writeFileSync(b, "b\n");
    writeFileSync(c, "c\n");
    const older = Math.floor(Date.now() / 1000) - 1000;
    const newer = Math.floor(Date.now() / 1000) - 10;
    utimesSync(a, older, older);
    utimesSync(b, newer, newer);
    const pattern = join(workdir, "batonq-loop*.log");
    expect(newestLoopLog(pattern)).toBe(b);
  });

  test("newestLoopLog returns null when nothing matches", () => {
    const pattern = join(workdir, "batonq-loop*.log");
    expect(newestLoopLog(pattern)).toBeNull();
  });
});

// ── 7. colorize: disabled when asked, event=cyan, loop=yellow, error=red ─────

describe("colorize", () => {
  const r = (
    source: "events" | "loop",
    level: "info" | "error",
  ): LogRecord => ({
    ts: 0,
    source,
    level,
    line: "hello",
  });

  test("returns raw line when useColor is false", () => {
    expect(colorize(r("events", "info"), false)).toBe("hello");
  });

  test("events default to cyan, loop to yellow, error overrides to red", () => {
    expect(colorize(r("events", "info"), true)).toContain("\x1b[36m");
    expect(colorize(r("loop", "info"), true)).toContain("\x1b[33m");
    expect(colorize(r("loop", "error"), true)).toContain("\x1b[31m");
    expect(colorize(r("events", "error"), true)).toContain("\x1b[31m");
  });
});
