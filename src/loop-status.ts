// loop-status — pure helpers behind the TUI's "Loop status" footer.
// Kept free of ink/React so `tests/tui.test.ts` can exercise threshold logic,
// claimed-task lookup, and claude-uptime parsing without spawning processes.

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type LoopState = "running" | "idle" | "dead";

export type LoopStatus = {
  state: LoopState;
  loopPid: number | null;
  currentTask: { externalId: string; body: string } | null;
  claude: { pid: number; uptimeSec: number } | null;
  eventsAgeSec: number | null; // null when events.jsonl is missing
};

// 5 min → yellow, 10 min → red. Aligned with batonq-loop watchdog default
// (BATONQ_WATCHDOG_STALE_SEC=600) so the footer lights red right around
// the time the watchdog itself would fire.
export const EVENTS_WARN_SEC = 300;
export const EVENTS_CRIT_SEC = 600;

export function eventsAgeColor(
  ageSec: number | null,
  palette: { dim: string; warn: string; err: string; ok: string },
): string {
  if (ageSec === null) return palette.dim;
  if (ageSec > EVENTS_CRIT_SEC) return palette.err;
  if (ageSec > EVENTS_WARN_SEC) return palette.warn;
  return palette.ok;
}

export function loopStateGlyph(state: LoopState): string {
  if (state === "running") return "✅ running";
  if (state === "idle") return "⏸ idle";
  return "❌ dead";
}

// ── pgrep parsing ──────────────────────────────────────────────────────────────

// pgrep -f returns one pid per line. We take the oldest (first) for claude
// so the footer tracks the long-lived `claude -p` the loop is driving, not a
// short-lived sibling that spawned later.
export function parsePgrepPids(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map((l) => Number.parseInt(l, 10));
}

// ps etimes output ("  3621") → seconds. Returns null on malformed input.
export function parsePsEtimes(stdout: string): number | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  const n = Number.parseInt(line.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ── DB lookup ──────────────────────────────────────────────────────────────────

// Find the currently-claimed task most likely driven by the given loop pid.
// Matches any claimed_by ending in `_<pid>` so both formats currentSession()
// emits work: `pid_<ppid>` (no tty) and `term_<tty>_<ppid>` (tty present).
// If no direct match, fall back to the most-recent claim overall — better to
// show "something is being worked on" than blank.
export function findLoopCurrentTask(
  db: Database,
  loopPid: number | null,
): { externalId: string; body: string } | null {
  if (loopPid != null) {
    const row = db
      .query(
        `SELECT external_id, body FROM tasks
         WHERE status = 'claimed' AND claimed_by LIKE ?
         ORDER BY claimed_at DESC LIMIT 1`,
      )
      .get(`%_${loopPid}`) as { external_id: string; body: string } | undefined;
    if (row) return { externalId: row.external_id, body: row.body };
  }
  const any = db
    .query(
      `SELECT external_id, body FROM tasks
       WHERE status = 'claimed'
       ORDER BY claimed_at DESC LIMIT 1`,
    )
    .get() as { external_id: string; body: string } | undefined;
  return any ? { externalId: any.external_id, body: any.body } : null;
}

// Truncate a task body to 50 chars with an ellipsis, preserving leading words.
export function taskBodyPreview(body: string, max: number = 50): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}

// ── events.jsonl mtime ─────────────────────────────────────────────────────────

export function eventsAgeSec(
  path: string,
  nowMs: number = Date.now(),
): number | null {
  if (!existsSync(path)) return null;
  try {
    const mtime = statSync(path).mtimeMs;
    return Math.max(0, Math.floor((nowMs - mtime) / 1000));
  } catch {
    return null;
  }
}

// ── runtime-bound wrappers ─────────────────────────────────────────────────────

// These shell out; kept at the bottom so the pure logic above stays importable
// from tests without side effects. useLoopStatus() in tui.tsx is the only
// caller.

export function probeLoopPid(): number | null {
  // The loop binary was renamed `agent-coord-loop` → `batonq-loop` in v0.3.x;
  // match both so freshly-installed and legacy checkouts both probe correctly.
  // Without this the TUI shows `loop ✕ dead` against a perfectly-healthy
  // batonq-loop process — the symptom seen on 2026-04-26.
  const r = spawnSync("pgrep", ["-f", "batonq-loop|agent-coord-loop"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const pids = parsePgrepPids(r.stdout ?? "");
  // Lowest PID = parent loop (pgrep also matches the watchdog subprocess).
  return pids.length ? Math.min(...pids) : null;
}

export function probeClaudeInfo(): { pid: number; uptimeSec: number } | null {
  const r = spawnSync("pgrep", ["-f", "claude -p"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const pids = parsePgrepPids(r.stdout ?? "");
  if (!pids.length) return null;
  const pid = Math.min(...pids);
  const et = spawnSync("ps", ["-o", "etimes=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const uptime = parsePsEtimes(et.stdout ?? "");
  return uptime != null ? { pid, uptimeSec: uptime } : { pid, uptimeSec: 0 };
}

// ── formatter ──────────────────────────────────────────────────────────────────

export function formatEventsAge(ageSec: number | null): string {
  if (ageSec === null) return "— (no events.jsonl)";
  if (ageSec < 60) return `${ageSec}s ago`;
  const m = Math.floor(ageSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
