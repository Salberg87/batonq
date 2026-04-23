// alerts — data access + classification for the TUI's Alert lane (§1).
//
// Scans the tasks table + external signals (loop log, pending counters) and
// returns up to N alerts in priority order. The TUI hides the lane entirely
// when the returned list is empty — there is no "all-clear" line by design.
//
// Pure helpers are exported separately from `computeAlerts` so the tests can
// probe watchdog-log parsing and severity mapping without driving a DB.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";

export type AlertSeverity = "red" | "yellow" | "gray";

export type AlertKind =
  | "verify-failed"
  | "judge-failed"
  | "juks-done"
  | "stale-claim"
  | "watchdog-kill"
  | "empty-queue";

export type Alert = {
  kind: AlertKind;
  severity: AlertSeverity;
  text: string;
  externalId?: string;
};

// Priority order — lower index = higher priority. When only `maxAlerts` slots
// are available, the tail is dropped. Red alerts outrank yellow outrank gray.
export const ALERT_PRIORITY: AlertKind[] = [
  "verify-failed",
  "judge-failed",
  "juks-done",
  "stale-claim",
  "watchdog-kill",
  "empty-queue",
];

export const ALERT_SEVERITY: Record<AlertKind, AlertSeverity> = {
  "verify-failed": "red",
  "judge-failed": "red",
  "juks-done": "red",
  "stale-claim": "yellow",
  "watchdog-kill": "yellow",
  "empty-queue": "gray",
};

// Default thresholds match the TUI UX v2 spec.
export const STALE_CLAIM_SEC = 30 * 60;
export const STALE_PROGRESS_SEC = 10 * 60;
export const EMPTY_QUEUE_SEC = 15 * 60;

export type ComputeAlertsOpts = {
  now?: number;
  loopLogPath?: string | null;
  maxAlerts?: number;
  staleClaimSec?: number;
  staleProgressSec?: number;
  emptyQueueSec?: number;
};

function firstNonEmptyLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

// verify_output signals failure when it contains a bare FAIL token OR the
// shell idiom "exit <nonzero>". Leading-word FAIL matches "FAIL: ..." AND
// "some prefix FAIL" lines; we deliberately don't match the substring inside
// words like "FAILSAFE" to avoid false positives.
export function looksLikeVerifyFail(output: string): boolean {
  if (!output) return false;
  if (/(^|\s|:)FAIL(\s|:|$)/.test(output)) return true;
  if (/\bexit\s+[1-9][0-9]*\b/i.test(output)) return true;
  return false;
}

// judge_output is considered failed when the first non-empty line starts
// with the token "FAIL" (verdict comes first by convention). Anything else —
// including PASS, blank output, or a reasoned verdict without FAIL — is OK.
export function looksLikeJudgeFail(output: string): boolean {
  const first = firstNonEmptyLine(output);
  if (!first) return false;
  // Accept "FAIL", "FAIL:", "FAIL." etc — but only when FAIL is the verdict
  // word, not buried later in the line.
  return /^FAIL\b/i.test(first);
}

// Return minutes since the most recent `[watchdog]…killing` line in the last
// 100 lines of `logPath`. Null when the file is missing or no match found.
// Age is derived from file mtime (the loop log doesn't prefix timestamps).
export function watchdogKillAgeMinutes(
  logPath: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!logPath || !existsSync(logPath)) return null;
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - 100));
  const hit = tail.some((l) => /\[watchdog\].*killing/i.test(l));
  if (!hit) return null;
  try {
    const mtime = statSync(logPath).mtimeMs;
    return Math.max(0, Math.floor((nowMs - mtime) / 60000));
  } catch {
    return 0;
  }
}

export function computeAlerts(
  db: Database,
  opts: ComputeAlertsOpts = {},
): Alert[] {
  const now = opts.now ?? Date.now();
  const max = opts.maxAlerts ?? 2;
  const staleClaimSec = opts.staleClaimSec ?? STALE_CLAIM_SEC;
  const staleProgressSec = opts.staleProgressSec ?? STALE_PROGRESS_SEC;
  const emptyQueueSec = opts.emptyQueueSec ?? EMPTY_QUEUE_SEC;

  const found: Alert[] = [];

  // Latest done task drives verify-failed / judge-failed. Even if no gates
  // ran, we still fetch it so juks detection (below) uses the same row.
  const latestDone = db
    .query(
      `SELECT external_id, verify_cmd, verify_output, verify_ran_at,
              judge_cmd, judge_output, judge_ran_at
       FROM tasks
       WHERE status = 'done'
       ORDER BY completed_at DESC LIMIT 1`,
    )
    .get() as
    | {
        external_id: string;
        verify_cmd: string | null;
        verify_output: string | null;
        verify_ran_at: string | null;
        judge_cmd: string | null;
        judge_output: string | null;
        judge_ran_at: string | null;
      }
    | undefined;

  if (latestDone) {
    const vOut = latestDone.verify_output ?? "";
    const jOut = latestDone.judge_output ?? "";
    if (looksLikeVerifyFail(vOut)) {
      found.push({
        kind: "verify-failed",
        severity: "red",
        externalId: latestDone.external_id,
        text: `✗ verify FAILED on ${latestDone.external_id.slice(0, 8)}: ${firstNonEmptyLine(vOut).slice(0, 80)}`,
      });
    }
    if (looksLikeJudgeFail(jOut)) {
      const reason =
        firstNonEmptyLine(jOut)
          .replace(/^FAIL[:\s]*/i, "")
          .slice(0, 80) || "no reason";
      found.push({
        kind: "judge-failed",
        severity: "red",
        externalId: latestDone.external_id,
        text: `✗ judge FAILED on ${latestDone.external_id.slice(0, 8)}: ${reason}`,
      });
    }
  }

  // Juks detection runs across ALL done tasks — a task that self-closed past
  // its gates is the biggest trust failure we can surface, and it deserves an
  // alert even if it's not the most recent done row.
  const juks = db
    .query(
      `SELECT external_id FROM tasks
       WHERE status = 'done'
         AND verify_cmd IS NOT NULL
         AND verify_ran_at IS NULL
         AND judge_ran_at IS NULL
       ORDER BY completed_at DESC LIMIT 1`,
    )
    .get() as { external_id: string } | undefined;
  if (juks) {
    found.push({
      kind: "juks-done",
      severity: "red",
      externalId: juks.external_id,
      text: `⚠ task ${juks.external_id.slice(0, 8)} marked done without gates — investigate`,
    });
  }

  // Stale-claim — claimed task older than staleClaimSec AND no progress within
  // staleProgressSec. last_progress_at may be null on a freshly-claimed task;
  // treat null as "no progress since claim" which falls through to the age
  // check naturally.
  const claimedRows = db
    .query(
      `SELECT external_id, claimed_at, last_progress_at
       FROM tasks
       WHERE status = 'claimed' AND claimed_at IS NOT NULL`,
    )
    .all() as {
    external_id: string;
    claimed_at: string;
    last_progress_at: string | null;
  }[];
  for (const c of claimedRows) {
    const claimedMs = Date.parse(c.claimed_at);
    if (!Number.isFinite(claimedMs)) continue;
    const claimAgeSec = (now - claimedMs) / 1000;
    if (claimAgeSec < staleClaimSec) continue;
    const progMs = c.last_progress_at
      ? Date.parse(c.last_progress_at)
      : claimedMs;
    const progAgeSec = (now - progMs) / 1000;
    if (progAgeSec < staleProgressSec) continue;
    const mins = Math.floor(claimAgeSec / 60);
    found.push({
      kind: "stale-claim",
      severity: "yellow",
      externalId: c.external_id,
      text: `⚠ claim ${c.external_id.slice(0, 8)} stale for ${mins}m`,
    });
    break; // one stale-claim alert is enough for the lane
  }

  // Watchdog kill — grep the loop log for the telltale "[watchdog] … killing"
  // line. Age comes from file mtime.
  const watchMin = watchdogKillAgeMinutes(opts.loopLogPath, now);
  if (watchMin != null) {
    found.push({
      kind: "watchdog-kill",
      severity: "yellow",
      text: `⚠ watchdog killed claude ~${watchMin}m ago`,
    });
  }

  // Empty queue — pending = 0 AND the most recent task activity (completion,
  // claim, or creation) is older than emptyQueueSec. We use the max of those
  // three timestamps as a proxy for "the queue was last non-empty".
  const pendingRow = db
    .query(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'`)
    .get() as { n: number } | undefined;
  const pending = pendingRow?.n ?? 0;
  if (pending === 0) {
    const tsRow = db
      .query(
        `SELECT MAX(COALESCE(completed_at, claimed_at, created_at)) AS ts FROM tasks`,
      )
      .get() as { ts: string | null } | undefined;
    const ts = tsRow?.ts ?? null;
    if (ts) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms)) {
        const ageSec = (now - ms) / 1000;
        if (ageSec > emptyQueueSec) {
          const mins = Math.floor(ageSec / 60);
          found.push({
            kind: "empty-queue",
            severity: "gray",
            text: `ℹ queue empty for ${mins}m`,
          });
        }
      }
    }
  }

  found.sort(
    (a, b) => ALERT_PRIORITY.indexOf(a.kind) - ALERT_PRIORITY.indexOf(b.kind),
  );
  return found.slice(0, max);
}
