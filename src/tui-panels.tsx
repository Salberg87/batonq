// tui-panels — presentation components for the batonq TUI.
// Kept separate from tui.tsx so the main app file stays readable.

import React from "react";
import { Box, Text } from "ink";
import {
  doneBadge,
  formatAge,
  formatExpiresIn,
  groupByPriority,
  priorityBucket,
  sessionStatus,
  shortId,
  shortPath,
  type ClaimRow,
  type DoneBadge,
  type EventRow,
  type PriorityBucket,
  type SessionRow,
  type TaskRow,
} from "./tui-data";
import {
  eventsAgeColor,
  formatEventsAge,
  loopStateGlyph,
  taskBodyPreview,
  type LoopStatus,
} from "./loop-status";

// Brand colors from /tmp/brand/colors.css
export const C = {
  brand: "#E8A43A", // baton amber
  ink: "#1F2937", // ink slate
  ok: "#4ADE80", // handoff green
  paper: "#FAFAF9", // paper
  dim: "gray",
  warn: "#F59E0B",
  err: "#EF4444",
} as const;

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}

export function Panel({
  title,
  focused,
  children,
}: {
  title: string;
  focused: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "round" : "single"}
      borderColor={focused ? C.brand : C.dim}
      paddingX={1}
    >
      <Text bold color={focused ? C.brand : C.paper}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function SessionsPanel({
  rows,
  selected,
  focused,
  now,
}: {
  rows: SessionRow[];
  selected: number;
  focused: boolean;
  now: number;
}) {
  return (
    <Panel title={`Sessions (${rows.length})`} focused={focused}>
      {rows.length === 0 ? (
        <Text color={C.dim}>no active sessions</Text>
      ) : (
        rows.slice(0, 8).map((s, i) => {
          const status = sessionStatus(s.last_seen, now);
          const color =
            status === "live" ? C.ok : status === "idle" ? C.warn : C.dim;
          const marker = focused && i === selected ? ">" : " ";
          return (
            <Box key={s.session_id}>
              <Text color={C.brand}>{marker} </Text>
              <Text color={color}>●</Text>
              <Text> {shortId(s.session_id, 12).padEnd(12)} </Text>
              <Text color={C.dim}>
                {shortPath(s.cwd ?? "-", 28).padEnd(28)}
              </Text>
              <Text color={C.paper}>
                {" "}
                {formatAge(s.last_seen, now).padStart(4)}
              </Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}

// Pending rows grouped into [H]/[N]/[L] buckets. Within a bucket the upstream
// order is preserved (groupByPriority is stable), so whatever sort the caller
// applied — pick-order, created_at, id — remains visible to the operator.
// This matches §3 of docs/tui-ux-v2.md.
function PendingByPriority({ tasks }: { tasks: TaskRow[] }) {
  if (tasks.length === 0) return null;
  const grouped = groupByPriority(tasks);
  const ordered = [...grouped.H, ...grouped.N, ...grouped.L];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.dim}>Pending ({tasks.length}) — by priority</Text>
      {ordered.slice(0, 8).map((t) => {
        const bucket = priorityBucket(t);
        const markerColor =
          bucket === "H" ? C.err : bucket === "L" ? C.dim : C.paper;
        return (
          <Box key={t.external_id}>
            <Text> </Text>
            <Text color={markerColor} bold={bucket === "H"}>
              [{bucket}]
            </Text>
            <Text color={C.dim}> [{t.external_id.slice(0, 8)}] </Text>
            <Text color={C.paper}>{truncate(t.body, 60)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// Badge colours: ⚠ is red+bold (juks — operator must investigate), ⊘ is dim
// (no gates configured), everything else is ok-green (gates ran).
function DoneBadgeCell({ badge }: { badge: DoneBadge }) {
  const color = badge === "⚠" ? C.err : badge === "⊘" ? C.dim : C.ok;
  const bold = badge === "⚠";
  return (
    <Text color={color} bold={bold}>
      {badge.padEnd(6)}
    </Text>
  );
}

function RecentDone({ tasks, now }: { tasks: TaskRow[]; now: number }) {
  if (tasks.length === 0) return null;
  const shown = tasks.slice(0, 10);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.dim}>Recent done (last {shown.length})</Text>
      {shown.map((t) => {
        const badge = doneBadge(t);
        const age = t.completed_at ? formatAge(t.completed_at, now) : "?";
        const extra =
          badge === "⚠"
            ? "  (DONE WITHOUT VERIFY)"
            : badge === "⊘"
              ? "  (no gates)"
              : "";
        return (
          <Box key={t.external_id}>
            <Text> </Text>
            <DoneBadgeCell badge={badge} />
            <Text color={C.dim}> [{t.external_id.slice(0, 8)}] </Text>
            <Text color={C.paper}>{truncate(t.body, 44)}</Text>
            <Text color={C.dim}> {age.padStart(3)}</Text>
            {extra ? <Text color={C.dim}>{extra}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

export function TasksPanel({
  latest,
  counts,
  selected,
  focused,
  expandedOriginals,
  pending,
  done,
  now,
}: {
  latest: TaskRow[];
  counts: {
    drafts: number;
    pending: number;
    claimed: number;
    done: number;
  };
  selected: number;
  focused: boolean;
  expandedOriginals?: Set<string>;
  // §3: when these are provided, the panel renders dedicated "Pending (by
  // priority)" and "Recent done (with verify/judge badges)" sub-sections below
  // the existing `latest` rows. Absent/empty arrays → sections omitted, so the
  // pre-§3 callers (and their tests) keep rendering the old compact layout.
  pending?: TaskRow[];
  done?: TaskRow[];
  now?: number;
}) {
  const title =
    `Tasks  drafts ${counts.drafts} · pending ${counts.pending}` +
    ` · claimed ${counts.claimed} · done ${counts.done}`;
  return (
    <Panel title={title} focused={focused}>
      {latest.length === 0 ? (
        <Text color={C.dim}>no tasks</Text>
      ) : (
        latest.slice(0, 6).map((t, i) => {
          const marker = focused && i === selected ? ">" : " ";
          // Draft badge uses brand.accent (baton amber) — it's the colour a
          // human's attention should land on first: drafts block pick-next
          // until a human enriches + promotes.
          const badge =
            t.status === "draft" ? (
              <Text color={C.brand} bold>
                📝draft
              </Text>
            ) : t.status === "pending" ? (
              <Text color={C.warn}>pending</Text>
            ) : t.status === "claimed" ? (
              <Text color={C.brand}>claimed</Text>
            ) : (
              <Text color={C.ok}>done </Text>
            );
          const hasOriginal =
            t.status === "draft" &&
            !!t.original_body &&
            t.original_body !== t.body;
          const expanded = expandedOriginals?.has(t.external_id) ?? false;
          return (
            <Box key={t.external_id} flexDirection="column">
              <Box>
                <Text color={C.brand}>{marker} </Text>
                <Text color={C.dim}>[{t.external_id.slice(0, 8)}] </Text>
                {badge}
                <Text color={C.paper}>
                  {" "}
                  {truncate(`${t.repo} · ${t.body}`, 60)}
                </Text>
              </Box>
              {hasOriginal && !expanded && (
                <Box paddingLeft={4}>
                  <Text color={C.dim}>
                    Original: {truncate(t.original_body!, 50)} (o: expand)
                  </Text>
                </Box>
              )}
              {hasOriginal && expanded && (
                <Box paddingLeft={4}>
                  <Text color={C.dim}>Original: {t.original_body} </Text>
                  <Text color={C.dim}>(o: collapse)</Text>
                </Box>
              )}
            </Box>
          );
        })
      )}
      {pending && pending.length > 0 ? (
        <PendingByPriority tasks={pending} />
      ) : null}
      {done && done.length > 0 ? (
        <RecentDone tasks={done} now={now ?? Date.now()} />
      ) : null}
    </Panel>
  );
}

export function ClaimsPanel({
  rows,
  selected,
  focused,
  now,
}: {
  rows: ClaimRow[];
  selected: number;
  focused: boolean;
  now: number;
}) {
  return (
    <Panel title={`Active claims (${rows.length})`} focused={focused}>
      {rows.length === 0 ? (
        <Text color={C.dim}>no active claims</Text>
      ) : (
        rows.slice(0, 8).map((c, i) => {
          const marker = focused && i === selected ? ">" : " ";
          const exp = formatExpiresIn(c.expires_at, now);
          const expiring = exp === "expired" || exp.endsWith("s");
          return (
            <Box key={c.id}>
              <Text color={C.brand}>{marker} </Text>
              <Text color={C.paper}>
                {shortPath(c.file_path, 40).padEnd(40)}
              </Text>
              <Text color={C.dim}>
                {" "}
                {shortId(c.session_id, 10).padEnd(10)}{" "}
              </Text>
              <Text color={C.dim}>
                {formatAge(c.acquired_at, now).padStart(4)}
              </Text>
              <Text color={expiring ? C.err : C.ok}> ⟶ {exp}</Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}

export function EventsPanel({
  rows,
  selected,
  focused,
  now,
}: {
  rows: EventRow[];
  selected: number;
  focused: boolean;
  now: number;
}) {
  const visible = rows.slice(-10);
  return (
    <Panel title={`Events (${rows.length} / last 20)`} focused={focused}>
      {visible.length === 0 ? (
        <Text color={C.dim}>no events yet</Text>
      ) : (
        visible.map((e, i) => {
          const marker = focused && i === selected ? ">" : " ";
          const age = formatAge(e.ts, now);
          const tool = (e.tool ?? "?").padEnd(10);
          const phaseColor =
            e.phase === "pre" ? C.brand : e.phase === "post" ? C.ok : C.dim;
          const p0 = (e.paths && e.paths[0]) ?? "";
          return (
            <Box key={e.event_id ?? `${e.ts}-${i}`}>
              <Text color={C.brand}>{marker} </Text>
              <Text color={C.dim}>{age.padStart(4)} </Text>
              <Text color={phaseColor}>{e.phase.padEnd(4)}</Text>
              <Text color={C.paper}>{tool}</Text>
              <Text color={C.dim}>{truncate(p0, 44)}</Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}

// Loop-status footer — one-line summary of the batonq-loop subsystem so you
// can tell at a glance whether Claude-p is actively chewing on a task or the
// queue has stalled. Rendered below the four panels, auto-refreshed by the
// main App tick. Colors: brand.accent for the running baton-pass, warn/err
// when the event log goes mtime-stale past the watchdog thresholds.
export function LoopStatusFooter({ status }: { status: LoopStatus }) {
  const stateColor =
    status.state === "running"
      ? C.ok
      : status.state === "idle"
        ? C.warn
        : C.err;
  const taskText = status.currentTask
    ? `${status.currentTask.externalId.slice(0, 8)} · ${taskBodyPreview(status.currentTask.body, 50)}`
    : "— (idle)";
  const claudeText = status.claude
    ? `pid ${status.claude.pid} running ${status.claude.uptimeSec}s`
    : "— (no claude -p)";
  const eventsColor = eventsAgeColor(status.eventsAgeSec, {
    dim: C.dim,
    warn: C.warn,
    err: C.err,
    ok: C.ok,
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.brand} bold>
          Loop
        </Text>
        <Text color={C.dim}> · </Text>
        <Text color={stateColor}>{loopStateGlyph(status.state)}</Text>
        {status.loopPid !== null && (
          <Text color={C.dim}> (pid {status.loopPid})</Text>
        )}
        <Text color={C.dim}> · </Text>
        <Text color={C.paper}>task: </Text>
        <Text color={C.brand}>{taskText}</Text>
      </Box>
      <Box>
        <Text color={C.paper}>claude: </Text>
        <Text color={C.brand}>{claudeText}</Text>
        <Text color={C.dim}> · </Text>
        <Text color={C.paper}>events: </Text>
        <Text color={eventsColor}>{formatEventsAge(status.eventsAgeSec)}</Text>
        <Text color={C.dim}> · press </Text>
        <Text color={C.brand} bold>
          L
        </Text>
        <Text color={C.dim}> to restart loop</Text>
      </Box>
    </Box>
  );
}

export function HelpOverlay() {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={C.brand}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={C.brand}>
        batonq TUI — help
      </Text>
      <Text> </Text>
      <Text>
        <Text color={C.brand}>Tab</Text> cycle panel focus
      </Text>
      <Text>
        <Text color={C.brand}>j / ↓</Text> next row
      </Text>
      <Text>
        <Text color={C.brand}>k / ↑</Text> previous row
      </Text>
      <Text>
        <Text color={C.brand}>/</Text> filter rows in focused panel
      </Text>
      <Text>
        <Text color={C.brand}>a</Text> abandon selected task (Tasks panel)
      </Text>
      <Text>
        <Text color={C.brand}>r</Text> release selected claim (Claims panel)
      </Text>
      <Text>
        <Text color={C.brand}>n</Text> new task (inline form)
      </Text>
      <Text>
        <Text color={C.brand}>e</Text> enrich selected draft (opus, inline)
      </Text>
      <Text>
        <Text color={C.brand}>p</Text> promote selected draft → pending
      </Text>
      <Text>
        <Text color={C.brand}>o</Text> toggle original body on enriched draft
      </Text>
      <Text>
        <Text color={C.brand}>L</Text> restart batonq-loop (confirm y/n)
      </Text>
      <Text>
        <Text color={C.brand}>?</Text> toggle this help
      </Text>
      <Text>
        <Text color={C.brand}>q</Text> quit
      </Text>
      <Text> </Text>
      <Text color={C.dim}>press any key to dismiss</Text>
    </Box>
  );
}
