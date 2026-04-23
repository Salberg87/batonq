// drill-down — §5 of docs/tui-ux-v2.md. Full-screen modal rendered when the
// operator presses Enter on a task row (or alert). Shows the full task body,
// captured verify_cmd + output tail, captured judge_cmd + verdict head, and
// the commits that landed since the task was claimed. Esc closes; a/r/e mirror
// the main-panel keybinds (abandon / release-claim / enrich) so the operator
// doesn't have to back out to act on what they see.
//
// Pure data assembly lives in `buildDrillDownView` so tests can exercise the
// clipping (tailLines/headLines) and commit fetch without rendering ink.
//
// Overflow: verify/judge outputs are hard-capped at 30/15 lines by tailLines/
// headLines, but a tall stack of wrapped text can still exceed a small
// terminal. The overlay applies a per-section viewport (default 12 lines) and
// scrolls with j/k — visible clip indicators ("↑ N earlier / ↓ N more") tell
// the operator content was cut.
//
// Input isolation: the overlay owns its own useInput and the parent's
// useInput early-returns while `mode === "drill-down"`, so background-panel
// keybinds (Tab, j/k on tasks, a/r on other panels) do not fire while the
// modal is open. The overlay swallows any unhandled key to make that
// explicit — no accidental pass-through.
//
// Live refresh: the TUI stores only the task's external_id, not the TaskRow
// itself. On every 2s snapshot tick the caller re-resolves the row via
// `findTaskByEid(snap, eid)` and rebuilds the DrillDownView — so a writer
// process updating verify_output / judge_output / status while the modal is
// open shows up in the overlay without the operator having to close+reopen.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  commitsSince,
  doneBadge,
  headLines,
  tailLines,
  type TaskRow,
} from "./tui-data";
import { C } from "./tui-panels";

export type DrillDownView = {
  externalId: string;
  status: TaskRow["status"];
  badge: string | null;
  body: string;
  verifyCmd: string | null;
  verifyTail: string[];
  judgeCmd: string | null;
  judgeHead: string[];
  commits: { sha: string; subject: string }[];
};

// Default per-section viewport. Kept small enough that the full overlay
// (header + body + verify + judge + commits + footer) fits a 24-row terminal.
export const DEFAULT_VIEWPORT_LINES = 12;

// Assemble a DrillDownView from a task row + the claim's repo cwd (used to
// resolve commits-since-claimed_at). `verifyTail` is the last 30 lines of
// verify_output (failing assertion lives near the end of a long log);
// `judgeHead` is the first 15 lines of judge_output (verdict token lives on
// line 1).
export function buildDrillDownView(
  task: TaskRow,
  repoCwd: string | null | undefined,
): DrillDownView {
  return {
    externalId: task.external_id,
    status: task.status,
    badge: task.status === "done" ? doneBadge(task) : null,
    body: task.body,
    verifyCmd: task.verify_cmd ?? null,
    verifyTail: tailLines(task.verify_output ?? null, 30),
    judgeCmd: task.judge_cmd ?? null,
    judgeHead: headLines(task.judge_output ?? null, 15),
    commits: repoCwd ? commitsSince(task.claimed_at, repoCwd) : [],
  };
}

// Clamp a scroll offset to the valid window for `total` lines shown
// `viewport` at a time. Exported for tests.
export function clampOffset(
  offset: number,
  total: number,
  viewport: number,
): number {
  const max = Math.max(0, total - viewport);
  if (offset < 0) return 0;
  if (offset > max) return max;
  return offset;
}

// Colour for a done-task badge — mirrors tui-panels.DoneBadgeCell logic so the
// drill-down header matches the Tasks panel at a glance.
function badgeColor(badge: string): string {
  if (badge === "⚠") return C.err;
  if (badge === "⊘") return C.dim;
  return C.ok;
}

function statusColor(status: TaskRow["status"]): string {
  if (status === "done") return C.ok;
  if (status === "claimed") return C.brand;
  if (status === "draft") return C.brand;
  return C.warn;
}

// ScrollableList — render `lines[offset..offset+viewport]` with "↑ N earlier"
// / "↓ N more" markers when content is clipped. Keeps the layout predictable
// so the whole overlay fits a standard terminal.
function ScrollableList({
  lines,
  offset,
  viewport,
  emptyText = "(none)",
}: {
  lines: string[];
  offset: number;
  viewport: number;
  emptyText?: string;
}): React.ReactElement {
  if (lines.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color={C.dim}>{emptyText}</Text>
      </Box>
    );
  }
  const clamped = clampOffset(offset, lines.length, viewport);
  const shown = lines.slice(clamped, clamped + viewport);
  const before = clamped;
  const after = Math.max(0, lines.length - (clamped + viewport));
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {before > 0 ? <Text color={C.dim}>↑ {before} earlier</Text> : null}
      {shown.map((line, i) => (
        <Text key={i} color={C.paper}>
          {line}
        </Text>
      ))}
      {after > 0 ? <Text color={C.dim}>↓ {after} more</Text> : null}
    </Box>
  );
}

export function DrillDownOverlay({
  view,
  viewportLines = DEFAULT_VIEWPORT_LINES,
  onClose,
  onAbandon,
  onRelease,
  onEnrich,
}: {
  view: DrillDownView;
  viewportLines?: number;
  onClose: () => void;
  onAbandon: () => void;
  onRelease: () => void;
  onEnrich: () => void;
}): React.ReactElement {
  // Separate scroll offsets per section — verify can be long, judge/commits
  // are short. j/k scrolls the "active" section (verify by default).
  const [verifyOffset, setVerifyOffset] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (input === "a") {
      onAbandon();
      return;
    }
    if (input === "r") {
      onRelease();
      return;
    }
    if (input === "e") {
      onEnrich();
      return;
    }
    if (input === "j" || key.downArrow) {
      setVerifyOffset((o) =>
        clampOffset(o + 1, view.verifyTail.length, viewportLines),
      );
      return;
    }
    if (input === "k" || key.upArrow) {
      setVerifyOffset((o) =>
        clampOffset(o - 1, view.verifyTail.length, viewportLines),
      );
      return;
    }
    // Swallow everything else — the modal owns the keyboard while open so
    // background panel keybinds (Tab, n, p, o, L, …) cannot fire through.
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={C.brand}
      paddingX={1}
    >
      <Box>
        <Text bold color={C.brand}>
          Task {view.externalId}
        </Text>
        <Text color={C.dim}> — </Text>
        <Text color={statusColor(view.status)}>[{view.status}]</Text>
        {view.badge ? (
          <>
            <Text color={C.dim}> </Text>
            <Text bold color={badgeColor(view.badge)}>
              {view.badge}
            </Text>
          </>
        ) : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={C.dim}>Body:</Text>
        <Box paddingLeft={2}>
          <Text color={C.paper}>{view.body}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={C.dim}>Verify cmd:</Text>
        <Box paddingLeft={2}>
          <Text color={C.paper}>{view.verifyCmd ?? "— none —"}</Text>
        </Box>
        <Text color={C.dim}>Verify output (last 30 lines):</Text>
        <ScrollableList
          lines={view.verifyTail}
          offset={verifyOffset}
          viewport={viewportLines}
        />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={C.dim}>Judge cmd:</Text>
        <Box paddingLeft={2}>
          <Text color={C.paper}>{view.judgeCmd ?? "— none —"}</Text>
        </Box>
        <Text color={C.dim}>Judge verdict:</Text>
        <ScrollableList
          lines={view.judgeHead}
          offset={0}
          viewport={viewportLines}
        />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={C.dim}>Commits since claim ({view.commits.length}):</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {view.commits.length === 0 ? (
            <Text color={C.dim}>(none)</Text>
          ) : (
            view.commits.slice(0, viewportLines).map((c) => (
              <Box key={c.sha}>
                <Text color={C.ok}>{c.sha}</Text>
                <Text color={C.paper}> {c.subject}</Text>
              </Box>
            ))
          )}
          {view.commits.length > viewportLines ? (
            <Text color={C.dim}>
              ↓ {view.commits.length - viewportLines} more
            </Text>
          ) : null}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={C.dim}>
          <Text color={C.brand} bold>
            Esc
          </Text>{" "}
          close ·{" "}
          <Text color={C.brand} bold>
            j/k
          </Text>{" "}
          scroll verify ·{" "}
          <Text color={C.brand} bold>
            a
          </Text>{" "}
          abandon ·{" "}
          <Text color={C.brand} bold>
            r
          </Text>{" "}
          release-claim ·{" "}
          <Text color={C.brand} bold>
            e
          </Text>{" "}
          enrich
        </Text>
      </Box>
    </Box>
  );
}
