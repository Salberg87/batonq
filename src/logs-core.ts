// logs-core — pure helpers for `batonq logs`: parsing, merging, colorizing.
// All filesystem reads are isolated here so the CLI wrapper in `agent-coord`
// stays thin and the merge/sort/filter logic is unit-testable without spawning.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

export type LogSource = "events" | "loop";
export type LogLevel = "info" | "error";

export type LogRecord = {
  ts: number; // epoch ms — used as sort key
  source: LogSource;
  line: string; // formatted, color-free line ready for display
  level: LogLevel;
};

// ── ANSI colors ──────────────────────────────────────────────────────────────
// Kept inline (no dependency) so the CLI has no runtime-lib surface for this.
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

// ── event parsing ────────────────────────────────────────────────────────────
// Mirrors `agent-coord tail`'s formatter so `batonq logs` and `batonq tail`
// render each event identically.
export function formatEventLine(
  raw: string,
): { ts: number; line: string; level: LogLevel } | null {
  let e: any;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof e?.ts !== "string") return null;
  const ts = Date.parse(e.ts);
  if (Number.isNaN(ts)) return null;
  const repo = e.git_root ? basename(e.git_root) : "?";
  const paths: string[] = Array.isArray(e.paths) ? e.paths : [];
  const rel = paths
    .map((p) => (e.git_root ? p.replace(e.git_root + "/", "") : p))
    .join(", ");
  const pat = e.bash_pattern ? ` [${e.bash_pattern}]` : "";
  const tool = String(e.tool ?? "?").padEnd(9);
  const phase = String(e.phase ?? "?").padEnd(4);
  const session = String(e.session ?? "?").slice(0, 8);
  const line = `${e.ts.slice(11, 19)}  ${session}  ${tool} ${phase} ${repo}/${rel}${pat}`;
  return { ts, line, level: "info" };
}

// Loop lines are unstructured bash stdout — flag the error-ish ones so we can
// paint them red. Case-insensitive on the keywords; "✗" is a literal match.
export function classifyLoopLine(line: string): LogLevel {
  const low = line.toLowerCase();
  if (
    low.includes("error") ||
    low.includes("fatal") ||
    low.includes("fail") ||
    line.includes("✗")
  ) {
    return "error";
  }
  return "info";
}

// ── file readers ─────────────────────────────────────────────────────────────

export function readEvents(path: string): LogRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: LogRecord[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const f = formatEventLine(raw);
    if (!f) continue;
    out.push({ ts: f.ts, source: "events", line: f.line, level: f.level });
  }
  return out;
}

// Tiny glob: only supports a single `*` in the basename (enough for
// "batonq-loop*.log"). Returns the newest matching file by mtime, or null.
export function newestLoopLog(pattern: string): string | null {
  const dir = dirname(pattern);
  const base = basename(pattern);
  const star = base.indexOf("*");
  if (star < 0) return existsSync(pattern) ? pattern : null;
  const prefix = base.slice(0, star);
  const suffix = base.slice(star + 1);
  let best: { path: string; mtime: number } | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const full = `${dir}/${name}`;
    try {
      const mtime = statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: full, mtime };
    } catch {
      // ignore transient unreadable entry
    }
  }
  return best?.path ?? null;
}

// Loop logs are unstructured — bash echoes with no per-line timestamp. For
// merge-sort purposes we anchor every line to the file's mtime so loop output
// clusters at the end (latest activity). Within the file, insertion order is
// preserved via the stable sort in mergeAndTail.
export function readLoop(path: string | null): LogRecord[] {
  if (!path || !existsSync(path)) return [];
  const mtime = statSync(path).mtimeMs;
  const text = readFileSync(path, "utf8");
  const out: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    out.push({
      ts: mtime,
      source: "loop",
      line,
      level: classifyLoopLine(line),
    });
  }
  return out;
}

// ── merge / tail ─────────────────────────────────────────────────────────────

export type MergeOpts = {
  source: "events" | "loop" | "both";
  n: number; // <= 0 means "all"
};

export function mergeAndTail(
  events: LogRecord[],
  loop: LogRecord[],
  opts: MergeOpts,
): LogRecord[] {
  const buf: LogRecord[] = [];
  if (opts.source !== "loop") buf.push(...events);
  if (opts.source !== "events") buf.push(...loop);
  // Stable sort: decorate with original index, sort by (ts, index).
  const decorated = buf.map((r, i) => ({ r, i }));
  decorated.sort((a, b) => a.r.ts - b.r.ts || a.i - b.i);
  const sorted = decorated.map((d) => d.r);
  return opts.n > 0 ? sorted.slice(-opts.n) : sorted;
}

// ── display ──────────────────────────────────────────────────────────────────

export function colorize(r: LogRecord, useColor: boolean): string {
  if (!useColor) return r.line;
  const base = r.source === "events" ? CYAN : YELLOW;
  const prefix = r.level === "error" ? RED : base;
  return `${prefix}${r.line}${RESET}`;
}
