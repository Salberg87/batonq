// burn-tracker.ts — parse Claude Code session logs to estimate
// current Pro/Max 5-hour bucket consumption.
//
// Background: Anthropic's Claude subscription enforces a rolling
// 5-hour window. The window starts on the first request after a
// dormant period; subsequent requests draw from the same bucket
// until the window expires (or quota empties — at which point a
// "synthetic stop" appears in the session log: model="<synthetic>"
// with input_tokens: 0).
//
// We approximate the active bucket by scanning the last 5 hours
// of session jsonl files for non-synthetic assistant messages and
// summing every `usage.{input,output,cache_creation,cache_read}_input_tokens`.
// A synthetic stop within the window counts as the bucket boundary
// (anything before it belongs to the *previous* bucket and is
// excluded from the current count).
//
// This is operational telemetry, not a billing source of truth —
// for that, query Anthropic's API. Use this to avoid blowing the
// bucket overnight.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUCKET_HOURS = 5;
export const BUCKET_MS = BUCKET_HOURS * 60 * 60 * 1000;

/** A single assistant turn's token usage, normalized. */
export type Turn = {
  ts: number; // ms epoch
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  synthetic: boolean; // true = subscription-limit-hit marker
  sessionId: string;
};

export type BurnSummary = {
  bucketStart: number | null; // ms epoch, or null if no activity in window
  bucketAgeMs: number; // how long the bucket has been active
  bucketRemainingMs: number; // ms until 5h window expires
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalTokens: number; // sum of all four
  turns: number;
  burnRatePerMin: number; // tokens/min averaged over bucket age
  syntheticStops: number; // bucket-resets observed in window
};

/**
 * Read every session jsonl file under the projects dir and yield each
 * assistant turn with usage data, normalized into Turn shape.
 *
 * `projectsDir` defaults to `~/.claude/projects/-Users-fsalb-DEV/` style
 * — pass an explicit path for tests.
 */
export function readTurns(projectsDir: string, sinceMs: number): Turn[] {
  const turns: Turn[] = [];
  if (!existsSync(projectsDir)) return turns;

  const entries = readdirSync(projectsDir);
  const jsonlFiles: string[] = [];
  for (const e of entries) {
    const path = join(projectsDir, e);
    if (e.endsWith(".jsonl") && statSync(path).isFile()) {
      jsonlFiles.push(path);
    }
  }

  for (const file of jsonlFiles) {
    // Skip files whose mtime is well before the window — cheap filter
    // before parsing.
    const mtime = statSync(file).mtimeMs;
    if (mtime < sinceMs) continue;

    const sessionId =
      file
        .split("/")
        .pop()
        ?.replace(/\.jsonl$/, "") ?? "";
    let buf: string;
    try {
      buf = readFileSync(file, "utf8");
    } catch {
      continue; // file disappeared mid-read; skip
    }
    for (const line of buf.split("\n")) {
      if (!line.startsWith("{")) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== "assistant") continue;
      const msg = e.message;
      if (!msg) continue;
      const usage = msg.usage;
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (!ts || ts < sinceMs) continue;
      const synthetic = msg.model === "<synthetic>";
      turns.push({
        ts,
        inputTokens: synthetic ? 0 : (usage?.input_tokens ?? 0),
        outputTokens: synthetic ? 0 : (usage?.output_tokens ?? 0),
        cacheCreate: synthetic ? 0 : (usage?.cache_creation_input_tokens ?? 0),
        cacheRead: synthetic ? 0 : (usage?.cache_read_input_tokens ?? 0),
        synthetic,
        sessionId,
      });
    }
  }
  turns.sort((a, b) => a.ts - b.ts);
  return turns;
}

/**
 * Given turns sorted by timestamp, locate the active bucket boundary:
 * the most recent synthetic stop within the lookback window, or the
 * earliest turn if no synthetic stop is seen.
 *
 * Returns the index into `turns` where the active bucket begins
 * (inclusive of that turn), or -1 if no turns are present.
 */
export function findBucketStart(turns: Turn[]): number {
  if (turns.length === 0) return -1;
  // Walk backwards from the most recent turn; the last synthetic stop
  // marks the END of the prior bucket. Bucket start is the first turn
  // *after* that.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].synthetic) {
      return i + 1; // first non-synthetic turn after the stop
    }
  }
  return 0; // no synthetic stop in window — bucket started at first turn
}

/**
 * Aggregate turns into a BurnSummary. `now` is injectable for tests.
 */
export function summarize(turns: Turn[], now: number): BurnSummary {
  const startIdx = findBucketStart(turns);
  if (startIdx === -1 || startIdx >= turns.length) {
    return {
      bucketStart: null,
      bucketAgeMs: 0,
      bucketRemainingMs: BUCKET_MS,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      turns: 0,
      burnRatePerMin: 0,
      syntheticStops: 0,
    };
  }

  const active = turns.slice(startIdx);
  const bucketStart = active[0].ts;
  const bucketAgeMs = Math.max(0, now - bucketStart);
  const bucketRemainingMs = Math.max(0, BUCKET_MS - bucketAgeMs);

  let input = 0,
    output = 0,
    cacheC = 0,
    cacheR = 0,
    synth = 0;
  for (const t of active) {
    if (t.synthetic) {
      synth++;
      continue;
    }
    input += t.inputTokens;
    output += t.outputTokens;
    cacheC += t.cacheCreate;
    cacheR += t.cacheRead;
  }
  const total = input + output + cacheC + cacheR;
  const burnRatePerMin = bucketAgeMs > 0 ? total / (bucketAgeMs / 60_000) : 0;

  return {
    bucketStart,
    bucketAgeMs,
    bucketRemainingMs,
    inputTokens: input,
    outputTokens: output,
    cacheCreateTokens: cacheC,
    cacheReadTokens: cacheR,
    totalTokens: total,
    turns: active.length - synth,
    burnRatePerMin,
    syntheticStops: synth,
  };
}

/** Format ms as "1h 23m" or "47m". */
export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Format token count: 1234 → "1.2K", 1_234_567 → "1.2M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Render a BurnSummary as a one-screen text report. Caller decides
 * whether to print to stdout, append to log, etc.
 */
export function renderReport(s: BurnSummary, now: number): string {
  if (s.bucketStart === null) {
    return "burn: no Claude activity in last 5h — bucket likely fresh";
  }
  const elapsedPct = Math.round((s.bucketAgeMs / BUCKET_MS) * 100);
  const lines: string[] = [];
  lines.push(
    `bucket: ${fmtDuration(s.bucketAgeMs)} elapsed / 5h (${elapsedPct}%) · resets in ${fmtDuration(s.bucketRemainingMs)}`,
  );
  lines.push(
    `tokens: ${fmtTokens(s.totalTokens)} total (in ${fmtTokens(s.inputTokens)} · out ${fmtTokens(s.outputTokens)} · cache-write ${fmtTokens(s.cacheCreateTokens)} · cache-read ${fmtTokens(s.cacheReadTokens)})`,
  );
  lines.push(
    `rate: ${fmtTokens(Math.round(s.burnRatePerMin))}/min over ${s.turns} turns${s.syntheticStops > 0 ? ` · ⚠ ${s.syntheticStops} synthetic stops in window` : ""}`,
  );
  return lines.join("\n");
}

/**
 * Default projects-directory resolver — picks the slug Claude Code uses
 * for the current cwd. Override-able for tests.
 */
export function defaultProjectsDir(home: string, cwd: string): string {
  const slug = cwd.replace(/^\//, "").replace(/\//g, "-");
  return join(home, ".claude", "projects", `-${slug}`);
}
