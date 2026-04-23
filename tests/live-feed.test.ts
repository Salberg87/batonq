// live-feed.test — §4 of docs/tui-ux-v2.md.
// Pure-data tests for the merge/trim/stable-sort helpers, plus the
// pause/scroll state reducer. The LiveFeedPanel's rendered output is
// exercised via ink-testing-library so the ⏸ marker + source prefixes are
// verified against real ink rendering.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import {
  FEED_POLL_MS,
  INITIAL_FEED_STATE,
  LIVE_FEED_MAX_LINES,
  feedReducer,
  mergeFeed,
  newestLoopLogPath,
  parseEventsFeedText,
  readEventsFeed,
  readLoopFeed,
  visibleWindow,
  type FeedAction,
  type FeedRecord,
  type FeedState,
} from "../src/live-feed";
import { LiveFeedPanel } from "../src/tui-panels";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "batonq-live-feed-"));
});
afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ── mergeFeed — stable sort + chronological trim ─────────────────────────────

describe("mergeFeed", () => {
  test("merges across sources chronologically and preserves input order on tied timestamps (STABLE)", () => {
    // Same ts across two sources — the deterministic tiebreak is (source-array
    // index, element index), so [loop, evt] input order survives the sort.
    const loop: FeedRecord[] = [
      { ts: 1000, source: "loop", text: "loop-A" },
      { ts: 1000, source: "loop", text: "loop-B" },
    ];
    const evt: FeedRecord[] = [
      { ts: 1000, source: "evt", text: "evt-A" },
      { ts: 500, source: "evt", text: "evt-early" },
      { ts: 1000, source: "evt", text: "evt-B" },
    ];
    const git: FeedRecord[] = [
      { ts: 2000, source: "git", text: "git-late" },
      { ts: 1000, source: "git", text: "git-A" },
    ];

    const out = mergeFeed([loop, evt, git], 100);
    const labels = out.map((r) => r.text);
    expect(labels).toEqual([
      // 500 first (the only earliest), then the 1000-bucket preserves input
      // order across sources: loop → evt → git (sourceIndex tiebreak).
      "evt-early",
      "loop-A",
      "loop-B",
      "evt-A",
      "evt-B",
      "git-A",
      "git-late",
    ]);
  });

  test("trim respects the buffer limit (§4: last ~40 lines)", () => {
    // Build 60 evt records with strictly-increasing ts so the sort is trivial
    // and the only thing we're verifying is the slice.
    const records: FeedRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push({ ts: i * 1000, source: "evt", text: `e${i}` });
    }
    const out = mergeFeed([records], LIVE_FEED_MAX_LINES);
    expect(out.length).toBe(LIVE_FEED_MAX_LINES);
    // Newest 40 are e20..e59 (slice(-40)).
    expect(out[0]!.text).toBe("e20");
    expect(out[out.length - 1]!.text).toBe("e59");
  });

  test("limit=0 disables trimming", () => {
    const records: FeedRecord[] = [
      { ts: 1, source: "evt", text: "a" },
      { ts: 2, source: "evt", text: "b" },
    ];
    expect(mergeFeed([records], 0).length).toBe(2);
  });

  test("empty sources return empty array", () => {
    expect(mergeFeed([], 10)).toEqual([]);
    expect(mergeFeed([[], [], []], 10)).toEqual([]);
  });
});

// ── feedReducer — pause / scroll state transitions ──────────────────────────

describe("feedReducer", () => {
  test("pause-resume: ↑ pauses + scrolls back, End resumes and snaps to bottom", () => {
    // Full pause-resume walk. Starts unpaused at bottom (offset 0).
    let state: FeedState = { ...INITIAL_FEED_STATE };
    expect(state).toEqual({ paused: false, offset: 0 });

    // ↑ → auto-pause, offset 1.
    state = feedReducer(state, { kind: "scroll-up" }, 40);
    expect(state).toEqual({ paused: true, offset: 1 });

    // ↑ again → offset 2, still paused.
    state = feedReducer(state, { kind: "scroll-up" }, 40);
    expect(state).toEqual({ paused: true, offset: 2 });

    // End → resume, snap to bottom.
    state = feedReducer(state, { kind: "end" }, 40);
    expect(state).toEqual({ paused: false, offset: 0 });
  });

  test("F toggles pause (resume always snaps to bottom)", () => {
    let state: FeedState = { paused: false, offset: 0 };
    // F → pause without moving.
    state = feedReducer(state, { kind: "toggle-pause" }, 40);
    expect(state).toEqual({ paused: true, offset: 0 });
    // Scroll back while paused.
    state = feedReducer(state, { kind: "scroll-up" }, 40);
    state = feedReducer(state, { kind: "scroll-up" }, 40);
    expect(state.offset).toBe(2);
    // F → resume + snap to bottom (offset cleared).
    state = feedReducer(state, { kind: "toggle-pause" }, 40);
    expect(state).toEqual({ paused: false, offset: 0 });
  });

  test("scroll-down is a no-op unless paused (arrow pauses, doesn't drift when tailing)", () => {
    // Unpaused: ↓ should not push offset negative or change paused state.
    const before: FeedState = { paused: false, offset: 0 };
    const after = feedReducer(before, { kind: "scroll-down" }, 40);
    expect(after).toBe(before); // reference-equal — no new object allocated

    // Paused + offset>0 → ↓ decrements.
    const paused: FeedState = { paused: true, offset: 3 };
    expect(feedReducer(paused, { kind: "scroll-down" }, 40)).toEqual({
      paused: true,
      offset: 2,
    });

    // Paused + offset=0 → ↓ clamps at 0.
    const pausedAtBottom: FeedState = { paused: true, offset: 0 };
    expect(feedReducer(pausedAtBottom, { kind: "scroll-down" }, 40)).toEqual({
      paused: true,
      offset: 0,
    });
  });

  test("scroll-up clamps at bufferLen-1 (can't scroll past history)", () => {
    let state: FeedState = { paused: false, offset: 0 };
    for (let i = 0; i < 20; i++) {
      state = feedReducer(state, { kind: "scroll-up" }, 5);
    }
    expect(state.offset).toBe(4); // bufferLen-1
  });

  test("tick is a no-op (state persists through polling)", () => {
    const paused: FeedState = { paused: true, offset: 3 };
    expect(feedReducer(paused, { kind: "tick" }, 40)).toBe(paused);
    const tailing: FeedState = { paused: false, offset: 0 };
    expect(feedReducer(tailing, { kind: "tick" }, 40)).toBe(tailing);
  });
});

// ── visibleWindow — render slice given pause/offset ─────────────────────────

describe("visibleWindow", () => {
  const records = Array.from({ length: 10 }, (_, i) => i);

  test("unpaused shows the tail (last `height` records)", () => {
    const win = visibleWindow(records, { paused: false, offset: 0 }, 3);
    expect(win).toEqual([7, 8, 9]);
  });

  test("paused + offset N slides the window back by N lines", () => {
    const win = visibleWindow(records, { paused: true, offset: 2 }, 3);
    // end = 10 - 2 = 8; start = 8 - 3 = 5 → slice(5,8) = [5,6,7]
    expect(win).toEqual([5, 6, 7]);
  });

  test("empty buffer or zero height → empty window", () => {
    expect(visibleWindow([], { paused: false, offset: 0 }, 10)).toEqual([]);
    expect(visibleWindow(records, { paused: false, offset: 0 }, 0)).toEqual([]);
  });
});

// ── log-reading helpers ─────────────────────────────────────────────────────

describe("readLoopFeed + newestLoopLogPath", () => {
  test("newestLoopLogPath picks the newest matching file by mtime", () => {
    const a = join(tmp, "agent-coord-loop-1.log");
    const b = join(tmp, "agent-coord-loop-2.log");
    const c = join(tmp, "other.log");
    writeFileSync(a, "first\n");
    writeFileSync(b, "second\n");
    writeFileSync(c, "not matched\n");
    // Force b to be newer than a even on fast filesystems.
    const now = Date.now() / 1000;
    utimesSync(a, now - 10, now - 10);
    utimesSync(b, now, now);

    const picked = newestLoopLogPath(join(tmp, "agent-coord-loop-*.log"));
    expect(picked).toBe(b);
  });

  test("returns null when no file matches", () => {
    expect(newestLoopLogPath(join(tmp, "nope-*.log"))).toBeNull();
  });

  test("readLoopFeed tails the last N lines and anchors ts to mtime", () => {
    const p = join(tmp, "agent-coord-loop-x.log");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(p, lines + "\n");
    const mtimeMs = statSync(p).mtimeMs;

    const out = readLoopFeed(p, 10);
    expect(out.length).toBe(10);
    expect(out[0]!.text).toBe("line 40");
    expect(out[9]!.text).toBe("line 49");
    expect(out.every((r) => r.source === "loop")).toBe(true);
    expect(out.every((r) => r.ts === mtimeMs)).toBe(true);
  });
});

// ── events.jsonl parsing ────────────────────────────────────────────────────

describe("parseEventsFeedText", () => {
  test("formats `<sess> <tool> <relative-path>` and preserves ts for merge", () => {
    const jsonl = [
      JSON.stringify({
        ts: "2026-04-24T00:00:01.000Z",
        phase: "pre",
        session: "9547642e-9fd7-4c20-b12e-220831c5ae4e",
        tool: "Read",
        git_root: "/Users/fsalb/DEV/batonq",
        paths: ["/Users/fsalb/DEV/batonq/src/tui.tsx"],
      }),
      JSON.stringify({
        ts: "2026-04-24T00:00:02.000Z",
        phase: "pre",
        session: "a1b2c3d4-0000-0000-0000-000000000000",
        tool: "Bash",
        paths: [],
      }),
      "{ not valid json }", // skipped
      JSON.stringify({ ts: "not a date", tool: "Skip" }), // skipped
    ].join("\n");

    const out = parseEventsFeedText(jsonl, 10);
    expect(out.length).toBe(2);
    expect(out[0]!.source).toBe("evt");
    expect(out[0]!.text).toBe("9547642e Read src/tui.tsx");
    expect(out[0]!.ts).toBe(Date.parse("2026-04-24T00:00:01.000Z"));
    expect(out[1]!.text).toBe("a1b2c3d4 Bash");
  });

  test("tails to the newest N events (matching LIVE_FEED_MAX_LINES semantics)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(
        JSON.stringify({
          ts: new Date(Date.UTC(2026, 3, 24, 0, 0, i)).toISOString(),
          session: "s",
          tool: "Read",
          paths: [],
        }),
      );
    }
    const out = parseEventsFeedText(lines.join("\n"), 5);
    expect(out.length).toBe(5);
    // Newest 5 of 50 input events.
    expect(out.map((r) => r.ts)).toEqual([
      Date.parse("2026-04-24T00:00:45.000Z"),
      Date.parse("2026-04-24T00:00:46.000Z"),
      Date.parse("2026-04-24T00:00:47.000Z"),
      Date.parse("2026-04-24T00:00:48.000Z"),
      Date.parse("2026-04-24T00:00:49.000Z"),
    ]);
  });
});

describe("readEventsFeed (file)", () => {
  test("reads and tails a real jsonl file", () => {
    const p = join(tmp, "events.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({
          ts: "2026-04-24T00:00:01.000Z",
          session: "aaa",
          tool: "Read",
          git_root: tmp,
          paths: [join(tmp, "x.ts")],
        }),
        JSON.stringify({
          ts: "2026-04-24T00:00:02.000Z",
          session: "bbb",
          tool: "Edit",
          git_root: tmp,
          paths: [join(tmp, "y.ts")],
        }),
      ].join("\n") + "\n",
    );
    const out = readEventsFeed(p, 10);
    expect(out.length).toBe(2);
    expect(out[0]!.text).toBe("aaa Read x.ts");
    expect(out[1]!.text).toBe("bbb Edit y.ts");
  });

  test("missing file → empty", () => {
    expect(readEventsFeed(join(tmp, "no-such.jsonl"))).toEqual([]);
  });
});

// ── LiveFeedPanel rendering ─────────────────────────────────────────────────

describe("LiveFeedPanel", () => {
  const sample: FeedRecord[] = [
    { ts: 1000, source: "loop", text: "→ agent-coord pick" },
    { ts: 2000, source: "evt", text: "9547642e Read src/tui.tsx" },
    { ts: 3000, source: "git", text: "a1b2c3d feat(tui): live feed §4" },
  ];

  test("renders source prefixes [loop]/[evt]/[git]", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LiveFeedPanel, {
        records: sample,
        state: INITIAL_FEED_STATE,
        focused: false,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[loop]");
    expect(frame).toContain("[evt]");
    expect(frame).toContain("[git]");
    expect(frame).toContain("→ agent-coord pick");
    expect(frame).toContain("feat(tui): live feed §4");
    unmount();
  });

  test("paused state surfaces the ⏸ marker and the resume hint", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LiveFeedPanel, {
        records: sample,
        state: { paused: true, offset: 0 },
        focused: true,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏸");
    expect(frame).toContain("End resumes");
    unmount();
  });

  test("unpaused + focused shows scroll hint, not the ⏸ marker", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LiveFeedPanel, {
        records: sample,
        state: INITIAL_FEED_STATE,
        focused: true,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("⏸");
    expect(frame).toContain("↑ scrolls back");
    unmount();
  });

  test("empty buffer shows the placeholder line", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LiveFeedPanel, {
        records: [],
        state: INITIAL_FEED_STATE,
        focused: false,
      }),
    );
    expect(lastFrame() ?? "").toContain("no activity yet");
    unmount();
  });
});

// ── sanity: 500ms polling constant matches spec ─────────────────────────────

describe("FEED_POLL_MS constant", () => {
  test("is 500ms per §4", () => {
    expect(FEED_POLL_MS).toBe(500);
  });
  test("LIVE_FEED_MAX_LINES is 40 per §4 ('last ~40 lines')", () => {
    expect(LIVE_FEED_MAX_LINES).toBe(40);
  });
});

// NOTE on FeedAction typing — importing the type here keeps TS's
// "unused export" warnings in check if/when we later add dispatch helpers.
const _actionTypecheck: FeedAction = { kind: "end" };
void _actionTypecheck;
