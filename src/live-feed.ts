// live-feed — data helpers + state reducer for the TUI's §4 Live feed panel.
// Three sources, chronologically merged (tail -f semantic):
//   [loop] /tmp/agent-coord-loop-*.log (newest by mtime) — yellow prefix
//   [evt]  ~/.claude/agent-coord-measurement/events.jsonl — cyan prefix
//   [git]  commits from each active claim's holder_cwd — green prefix
//
// All filesystem + git reads live here so the LiveFeedPanel component stays
// thin and the merge/sort/trim logic is unit-testable without ink.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";

export type FeedSource = "loop" | "evt" | "git";

export type FeedRecord = {
  ts: number; // epoch ms — sort key
  source: FeedSource;
  text: string; // display text, prefix-free (component adds [source])
};

// Polling cadence for the live feed (§4 of docs/tui-ux-v2.md).
export const FEED_POLL_MS = 500;
// Buffer cap — we render at most this many lines to stop runaway growth.
export const LIVE_FEED_MAX_LINES = 40;
// Default newest-log glob. Matches the upstream ~/bin/agent-coord-loop naming
// and the repo-local batonq-loop output path.
export const DEFAULT_LOOP_GLOB = "/tmp/agent-coord-loop-*.log";

// newestLoopLogPath — pick newest file matching a one-`*` glob by mtime.
// Null when no match or the directory is unreadable. Duplicated from
// logs-core so live-feed has no cross-module coupling; both files are small.
export function newestLoopLogPath(pattern: string): string | null {
  const dir = dirname(pattern);
  const base = basename(pattern);
  const star = base.indexOf("*");
  if (star < 0) return existsSync(pattern) ? pattern : null;
  const prefix = base.slice(0, star);
  const suffix = base.slice(star + 1);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const full = `${dir}/${name}`;
    try {
      const mtime = statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: full, mtime };
    } catch {
      // transient unreadable entry — skip
    }
  }
  return best?.path ?? null;
}

// readLoopFeed — tail of the chosen loop log. Loop stdout has no per-line
// timestamp, so every line is anchored to the file's mtime; the newest loop
// log therefore sorts at (or near) the bottom of the merged feed. Within the
// file, relative order is preserved by mergeFeed's secondary sort key.
export function readLoopFeed(
  path: string | null,
  tailLines: number = LIVE_FEED_MAX_LINES,
): FeedRecord[] {
  if (!path || !existsSync(path)) return [];
  let text: string;
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  const slice = lines.slice(Math.max(0, lines.length - tailLines));
  return slice.map((line) => ({
    ts: mtime,
    source: "loop" as const,
    text: line,
  }));
}

// readEventsFeed — tail of events.jsonl pretty-printed as `<sess> <tool> <path>`.
// Reads the last ~64KB to avoid pulling multi-MB histories into memory.
export function readEventsFeed(
  path: string,
  tailLines: number = LIVE_FEED_MAX_LINES,
): FeedRecord[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    const size = statSync(path).size;
    const maxBytes = 64 * 1024;
    const start = Math.max(0, size - maxBytes);
    const fs = require("node:fs");
    const fd = fs.openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  return parseEventsFeedText(text, tailLines);
}

// Pure parser split out so tests can drive it with a synthetic jsonl string.
export function parseEventsFeedText(
  text: string,
  tailLines: number = LIVE_FEED_MAX_LINES,
): FeedRecord[] {
  const out: FeedRecord[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof e?.ts !== "string") continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    const sess = String(e.session ?? "?").slice(0, 8);
    const tool = String(e.tool ?? "?");
    const paths: string[] = Array.isArray(e.paths) ? e.paths : [];
    const p0 = paths[0] ?? "";
    const rel =
      e.git_root && typeof p0 === "string" && p0.startsWith(e.git_root)
        ? p0.slice(String(e.git_root).length + 1)
        : p0;
    out.push({
      ts,
      source: "evt",
      text: rel ? `${sess} ${tool} ${rel}` : `${sess} ${tool}`,
    });
  }
  return out.slice(Math.max(0, out.length - tailLines));
}

// readGitCommitsFeed — author-date-sorted commits per cwd. `sinceMs` bounds
// the window so we don't pull the entire history on every poll; null means
// "last `perRepoLimit`". Failures (not a repo, git missing) collapse to [].
export function readGitCommitsFeed(
  cwds: ReadonlyArray<string | null | undefined>,
  sinceMs: number | null,
  perRepoLimit: number = 10,
): FeedRecord[] {
  const out: FeedRecord[] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    const args = [
      "-C",
      cwd,
      "log",
      "--pretty=format:%ct %h %s",
      "-n",
      String(perRepoLimit),
    ];
    if (sinceMs && Number.isFinite(sinceMs)) {
      args.splice(3, 0, `--since=${new Date(sinceMs).toISOString()}`);
    }
    try {
      const r = spawnSync("git", args, { encoding: "utf8" });
      if (r.status !== 0) continue;
      for (const line of (r.stdout ?? "").split("\n")) {
        if (!line.trim()) continue;
        const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const ts = Number.parseInt(m[1]!, 10) * 1000;
        out.push({ ts, source: "git", text: `${m[2]} ${m[3]}` });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

// mergeFeed — combine arrays of FeedRecord into one chronologically-ordered
// list, trimmed to the last `limit` entries (newest at bottom).
//
// Stable ordering: when two records share a timestamp, input order is
// preserved deterministically — first by `sources` array index, then by
// element index within each array. Relying on Array.sort's implementation
// stability would be enough on V8/JavaScriptCore but we do it explicitly so
// the contract is visible in tests and robust across runtimes.
export function mergeFeed(
  sources: ReadonlyArray<ReadonlyArray<FeedRecord>>,
  limit: number = LIVE_FEED_MAX_LINES,
): FeedRecord[] {
  const decorated: { r: FeedRecord; s: number; i: number }[] = [];
  for (let s = 0; s < sources.length; s++) {
    const arr = sources[s]!;
    for (let i = 0; i < arr.length; i++) {
      decorated.push({ r: arr[i]!, s, i });
    }
  }
  decorated.sort((a, b) => a.r.ts - b.r.ts || a.s - b.s || a.i - b.i);
  const sorted = decorated.map((d) => d.r);
  return limit > 0 ? sorted.slice(-limit) : sorted;
}

// ── pause/scroll state machine ────────────────────────────────────────────────

// Separate from component rendering so the transitions are unit-testable
// without ink. The App owns the state; the component is a pure function of it.
export type FeedState = {
  paused: boolean;
  // Lines back from the latest entry. 0 = tail (newest at bottom).
  offset: number;
};

export type FeedAction =
  | { kind: "scroll-up" } // operator scrolled back — auto-pauses
  | { kind: "scroll-down" } // only effective when paused
  | { kind: "end" } // resume auto-scroll, snap to bottom
  | { kind: "toggle-pause" } // F — flip pause/resume; resume snaps to bottom
  | { kind: "tick" }; // new data arrived

export const INITIAL_FEED_STATE: FeedState = { paused: false, offset: 0 };

export function feedReducer(
  state: FeedState,
  action: FeedAction,
  bufferLen: number,
): FeedState {
  switch (action.kind) {
    case "scroll-up": {
      const maxOff = Math.max(0, bufferLen - 1);
      return { paused: true, offset: Math.min(maxOff, state.offset + 1) };
    }
    case "scroll-down": {
      if (!state.paused) return state;
      const next = Math.max(0, state.offset - 1);
      return { paused: true, offset: next };
    }
    case "end":
      return { paused: false, offset: 0 };
    case "toggle-pause":
      return state.paused
        ? { paused: false, offset: 0 }
        : { paused: true, offset: state.offset };
    case "tick":
      // New data pushes the "bottom" forward. While paused we keep the same
      // window (offset still counts back from the latest), so the visible
      // lines shift up by one per new entry — which is the expected
      // behaviour for a paused tail.
      return state;
  }
}

// visibleWindow — pick the slice of `records` to render given the current
// pause/scroll state. Newest records are at the end of `records`; offset
// measures lines back from that tail. `height` is the number of rows to show.
export function visibleWindow<T>(
  records: ReadonlyArray<T>,
  state: FeedState,
  height: number,
): T[] {
  if (records.length === 0 || height <= 0) return [];
  const end = Math.max(0, records.length - state.offset);
  const start = Math.max(0, end - height);
  return records.slice(start, end);
}
