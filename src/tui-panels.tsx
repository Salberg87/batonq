// tui-panels — presentation components for the batonq TUI.
// Kept separate from tui.tsx so the main app file stays readable.

import React from "react";
import { Box, Text } from "ink";
import {
  formatAge,
  formatExpiresIn,
  sessionStatus,
  shortId,
  shortPath,
  type ClaimRow,
  type EventRow,
  type SessionRow,
  type TaskRow,
} from "./tui-data";

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

export function TasksPanel({
  latest,
  counts,
  selected,
  focused,
}: {
  latest: TaskRow[];
  counts: { pending: number; claimed: number; done: number };
  selected: number;
  focused: boolean;
}) {
  return (
    <Panel
      title={`Tasks  pending ${counts.pending} · claimed ${counts.claimed} · done ${counts.done}`}
      focused={focused}
    >
      {latest.length === 0 ? (
        <Text color={C.dim}>no tasks</Text>
      ) : (
        latest.slice(0, 5).map((t, i) => {
          const marker = focused && i === selected ? ">" : " ";
          const badge =
            t.status === "pending" ? (
              <Text color={C.warn}>pending</Text>
            ) : t.status === "claimed" ? (
              <Text color={C.brand}>claimed</Text>
            ) : (
              <Text color={C.ok}>done </Text>
            );
          return (
            <Box key={t.external_id}>
              <Text color={C.brand}>{marker} </Text>
              <Text color={C.dim}>[{t.external_id.slice(0, 8)}] </Text>
              {badge}
              <Text color={C.paper}>
                {" "}
                {truncate(`${t.repo} · ${t.body}`, 60)}
              </Text>
            </Box>
          );
        })
      )}
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
