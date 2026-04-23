// current-task-card — §2 of docs/tui-ux-v2.md. Replaces the static
// "Active claims" panel with a live work-surface card (task id, body,
// elapsed, edits+bash counts from events.jsonl, last-activity staleness,
// verify/judge captured-status, latest commit since claim). When there is
// no active claim the card collapses to a one-line idle banner.
//
// Repo / cwd handling: for single-repo tasks (repo=batonq etc.) the "latest
// commit" row queries the matching claim's holder_cwd. For multi-repo
// selectors (`any:infra`, `any:<persona>`) there is no canonical task repo,
// so the caller passes every live claim's cwd — latestCommitSinceClaim
// scans each one and picks the newest commit across them. If a multi-repo
// task is worked in a directory that has no live claim (no hook events),
// the commit row will miss those commits by design.
//
// Pure helpers are exported separately so tests can exercise the event
// counter and elapsed formatter without ink.

import React from "react";
import { Box, Text } from "ink";
import { spawnSync } from "node:child_process";
import type { ClaimRow, EventRow, TaskRow } from "./tui-data";
import { C, truncate } from "./tui-panels";

// Tools that mutate the working tree. We dedupe by counting only `pre` events
// (the hook emits both `pre` and `post` for each tool invocation).
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export type LastActivityColorKey = "ok" | "warn" | "err" | "dim";

// <relative>: turns yellow > 2m, red > 5m (per spec §2).
export function lastActivityRelative(
  lastIso: string | null,
  nowMs: number,
): { text: string; color: LastActivityColorKey } {
  if (!lastIso) return { text: "—", color: "dim" };
  const t = Date.parse(lastIso);
  if (!Number.isFinite(t)) return { text: "—", color: "dim" };
  const ageSec = Math.max(0, Math.floor((nowMs - t) / 1000));
  const color: LastActivityColorKey =
    ageSec > 300 ? "err" : ageSec > 120 ? "warn" : "ok";
  let text: string;
  if (ageSec < 60) text = `${ageSec}s ago`;
  else if (ageSec < 3600) text = `${Math.floor(ageSec / 60)}m ago`;
  else text = `${Math.floor(ageSec / 3600)}h ago`;
  return { text, color };
}

// claimed_at → now as "Xm Ys" (per spec §2). Negative / unparsable → "?".
export function formatElapsed(
  fromIso: string | null | undefined,
  nowMs: number,
): string {
  if (!fromIso) return "?";
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return "?";
  const delta = Math.max(0, Math.floor((nowMs - then) / 1000));
  const m = Math.floor(delta / 60);
  const s = delta % 60;
  return `${m}m ${s}s`;
}

// Count edits + bash calls in events.jsonl attributable to a given session,
// from `since` onwards. `session` matches `EventRow.session` (Claude's session
// UUID); when omitted we fall back to `cwdPrefix` which matches `EventRow.cwd`
// by prefix (useful when the TUI only knows the task's working directory).
// lastTs is the most recent event timestamp used for the "last activity"
// staleness signal.
export function countSessionEvents(
  events: EventRow[],
  opts: {
    session?: string | null;
    cwdPrefix?: string | null;
    since?: string | null;
  },
): { edits: number; bash: number; lastTs: string | null } {
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  let edits = 0;
  let bash = 0;
  let lastTs: string | null = null;
  let lastMs = 0;
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (sinceMs && ts < sinceMs) continue;
    if (opts.session && e.session !== opts.session) continue;
    if (opts.cwdPrefix && !(e.cwd ?? "").startsWith(opts.cwdPrefix)) continue;
    // Avoid double-counting — pre+post are both emitted per tool call.
    if (e.phase !== "pre") continue;
    if (e.tool && EDIT_TOOLS.has(e.tool)) edits += 1;
    else if (e.tool === "Bash") bash += 1;
    else continue;
    if (ts > lastMs) {
      lastMs = ts;
      lastTs = e.ts;
    }
  }
  return { edits, bash, lastTs };
}

// The latest git commit in `cwd` reachable from HEAD with author-date at/after
// `sinceIso`. Returns null when the repo has no commits in that window or git
// is unreachable. Callers pass a single repo path — multi-repo selectors like
// `any:infra` should use `latestCommitAcrossClaims` below so the card isn't
// blind to commits landed outside the first claim's cwd.
export function latestCommitInRepo(
  sinceIso: string | null | undefined,
  cwd: string | null | undefined,
): { sha: string; subject: string; tsMs: number } | null {
  if (!sinceIso || !cwd) return null;
  try {
    const r = spawnSync(
      "git",
      [
        "-C",
        cwd,
        "log",
        `--since=${sinceIso}`,
        // %ct = committer unix timestamp; lets us pick the newest commit when
        // aggregating across multiple repos.
        "--pretty=format:%h %ct %s",
        "-n",
        "1",
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return null;
    const line = (r.stdout ?? "").trim().split("\n")[0] ?? "";
    const m = line.match(/^(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) return null;
    return {
      sha: m[1]!,
      tsMs: Number.parseInt(m[2]!, 10) * 1000,
      subject: m[3]!,
    };
  } catch {
    return null;
  }
}

// For multi-repo task selectors (`any:infra`, `any:<persona>`) the task has no
// single home directory, so we scan every live claim's `holder_cwd` and return
// the newest commit across all of them. Single-repo callers can just pass the
// one cwd — the result is identical.
export function latestCommitSinceClaim(
  sinceIso: string | null | undefined,
  cwds: string | string[] | null | undefined,
): { sha: string; subject: string } | null {
  if (!sinceIso || !cwds) return null;
  const list = Array.isArray(cwds) ? cwds : [cwds];
  const unique = Array.from(new Set(list.filter((s): s is string => !!s)));
  let best: { sha: string; subject: string; tsMs: number } | null = null;
  for (const cwd of unique) {
    const hit = latestCommitInRepo(sinceIso, cwd);
    if (hit && (!best || hit.tsMs > best.tsMs)) best = hit;
  }
  return best ? { sha: best.sha, subject: best.subject } : null;
}

// Precomputed, render-ready data for the card. Pure — constructed once per
// tick in the TUI.
export type CurrentTaskInfo = {
  externalId: string;
  bodyPreview: string;
  elapsed: string;
  sessionShort: string;
  edits: number;
  bash: number;
  lastActivity: { text: string; color: LastActivityColorKey };
  verifyCaptured: boolean;
  judgeCaptured: boolean;
  latestCommit: { sha: string; subject: string } | null;
};

// Assemble CurrentTaskInfo from raw inputs. The TUI wires:
//   task  = most recent status='claimed' row
//   claim = matching entry in the claims table (for session_id + holder_cwd)
//   events = tail of events.jsonl
export function buildCurrentTaskInfo(params: {
  task: TaskRow;
  claim?: ClaimRow | null;
  events: EventRow[];
  now: number;
  commit?: { sha: string; subject: string } | null;
}): CurrentTaskInfo {
  const { task, claim, events, now } = params;
  const sessionId = claim?.session_id ?? null;
  const cwdPrefix = claim?.holder_cwd ?? null;
  const { edits, bash, lastTs } = countSessionEvents(events, {
    session: sessionId,
    cwdPrefix: sessionId ? null : cwdPrefix,
    since: task.claimed_at,
  });
  return {
    externalId: task.external_id,
    bodyPreview: truncate(task.body.replace(/\s+/g, " ").trim(), 120).trimEnd(),
    elapsed: formatElapsed(task.claimed_at, now),
    sessionShort: (sessionId ?? task.claimed_by ?? "—").slice(0, 10),
    edits,
    bash,
    lastActivity: lastActivityRelative(lastTs, now),
    verifyCaptured: !!task.verify_cmd && task.verify_cmd.trim().length > 0,
    judgeCaptured: !!task.judge_cmd && task.judge_cmd.trim().length > 0,
    latestCommit: params.commit ?? null,
  };
}

function colorFor(key: LastActivityColorKey, palette: typeof C = C): string {
  if (key === "err") return palette.err;
  if (key === "warn") return palette.warn;
  if (key === "ok") return palette.ok;
  return palette.dim;
}

// CurrentTaskCard — bordered card shown at the top of the main column when
// there is an active claim. Layout mirrors docs/tui-ux-v2.md §2.
export function CurrentTaskCard({
  info,
  focused = false,
}: {
  info: CurrentTaskInfo;
  focused?: boolean;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "round" : "single"}
      borderColor={focused ? C.brand : C.dim}
      paddingX={1}
    >
      <Box>
        <Text bold color={focused ? C.brand : C.paper}>
          Active task
        </Text>
        <Text color={C.dim}> — </Text>
        <Text color={C.brand}>{info.externalId.slice(0, 8)}</Text>
        <Text color={C.dim}> · elapsed </Text>
        <Text color={C.paper}>{info.elapsed}</Text>
      </Box>
      <Box>
        <Text color={C.paper}>{info.bodyPreview}</Text>
      </Box>
      <Box>
        <Text color={C.dim}>claimed by </Text>
        <Text color={C.brand}>{info.sessionShort}</Text>
        <Text color={C.dim}> · </Text>
        <Text color={C.paper}>{info.edits}</Text>
        <Text color={C.dim}> edits </Text>
        <Text color={C.paper}>{info.bash}</Text>
        <Text color={C.dim}> bash calls · last activity </Text>
        <Text color={colorFor(info.lastActivity.color)}>
          {info.lastActivity.text}
        </Text>
      </Box>
      <Box>
        <Text color={C.dim}>verify: </Text>
        <Text color={info.verifyCaptured ? C.ok : C.warn}>
          {info.verifyCaptured ? "✓ captured" : "missing"}
        </Text>
        <Text color={C.dim}> judge: </Text>
        <Text color={info.judgeCaptured ? C.ok : C.warn}>
          {info.judgeCaptured ? "✓ captured" : "missing"}
        </Text>
      </Box>
      {info.latestCommit ? (
        <Box>
          <Text color={C.dim}>latest commit: </Text>
          <Text color={C.ok}>{info.latestCommit.sha}</Text>
          <Text color={C.paper}>
            {" "}
            {truncate(info.latestCommit.subject, 60).trimEnd()}
          </Text>
        </Box>
      ) : (
        <Box>
          <Text color={C.dim}>latest commit: —</Text>
        </Box>
      )}
    </Box>
  );
}

// IdleBanner — rendered in place of the card when no task is currently
// claimed. Single line, low-visual-weight.
export function IdleBanner({
  pendingCount,
}: {
  pendingCount: number;
}): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color={C.dim}>— idle (queue: {pendingCount} pending) —</Text>
    </Box>
  );
}
