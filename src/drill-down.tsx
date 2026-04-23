// drill-down — §5 of docs/tui-ux-v2.md. Full-screen modal rendered when the
// operator presses Enter on a task row (or alert). Shows the full task body,
// captured verify_cmd + output tail, captured judge_cmd + verdict head, and
// the commits that landed since the task was claimed. Esc closes; a/r/e mirror
// the main-panel keybinds (abandon / release-claim / enrich) so the operator
// doesn't have to back out to act on what they see.
//
// Pure data assembly lives in `buildDrillDownView` so tests can exercise the
// clipping (tailLines/headLines) and commit fetch without rendering ink.

import React from "react";
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

export function DrillDownOverlay({
  view,
  onClose,
  onAbandon,
  onRelease,
  onEnrich,
}: {
  view: DrillDownView;
  onClose: () => void;
  onAbandon: () => void;
  onRelease: () => void;
  onEnrich: () => void;
}): React.ReactElement {
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
        <Box flexDirection="column" paddingLeft={2}>
          {view.verifyTail.length === 0 ? (
            <Text color={C.dim}>(none)</Text>
          ) : (
            view.verifyTail.map((line, i) => (
              <Text key={i} color={C.paper}>
                {line}
              </Text>
            ))
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={C.dim}>Judge cmd:</Text>
        <Box paddingLeft={2}>
          <Text color={C.paper}>{view.judgeCmd ?? "— none —"}</Text>
        </Box>
        <Text color={C.dim}>Judge verdict:</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {view.judgeHead.length === 0 ? (
            <Text color={C.dim}>(none)</Text>
          ) : (
            view.judgeHead.map((line, i) => (
              <Text key={i} color={C.paper}>
                {line}
              </Text>
            ))
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={C.dim}>Commits since claim ({view.commits.length}):</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {view.commits.length === 0 ? (
            <Text color={C.dim}>(none)</Text>
          ) : (
            view.commits.map((c) => (
              <Box key={c.sha}>
                <Text color={C.ok}>{c.sha}</Text>
                <Text color={C.paper}> {c.subject}</Text>
              </Box>
            ))
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={C.dim}>
          <Text color={C.brand} bold>
            Esc
          </Text>{" "}
          close ·{" "}
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
