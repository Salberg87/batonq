// alert-lane — top-of-TUI strip showing at most 2 active alerts (§1 of
// docs/tui-ux-v2.md). Kept in its own file so that parallel work on
// tui-panels.tsx (drill-down, done badges, etc.) doesn't conflict with
// alert-lane changes.

import React from "react";
import { Box, Text } from "ink";
import type { Alert, AlertSeverity } from "./alerts";

// Palette mirror — the Alert lane needs the same `err`/`warn`/`dim` colors as
// the rest of the TUI but should not import the whole `C` palette object
// (which lives in tui-panels and pulls in React/ink dependencies). Keeping the
// three hex values here is a tiny bit of duplication in exchange for not
// cross-importing between two presentation files.
const COLOR_RED = "#EF4444";
const COLOR_YELLOW = "#F59E0B";
const COLOR_GRAY = "gray";

// Map alert severity → terminal color. Red for failures/cheat, yellow for
// liveness warnings (stale claim / watchdog kill), gray for the info-level
// empty-queue notice.
export function alertSeverityColor(sev: AlertSeverity): string {
  if (sev === "red") return COLOR_RED;
  if (sev === "yellow") return COLOR_YELLOW;
  return COLOR_GRAY;
}

// AlertLane — returns null when there are zero alerts so the enclosing
// layout collapses entirely (no empty bordered box, no placeholder line).
export function AlertLane({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {alerts.map((a, i) => (
        <Text key={`${a.kind}-${i}`} color={alertSeverityColor(a.severity)}>
          {a.text}
        </Text>
      ))}
    </Box>
  );
}
