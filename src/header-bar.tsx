// header-bar — single-line headline strip at the top of the TUI.
//
// Operators open the dashboard to answer "does anything need me?" — the
// counts that answer that question live here, not buried in alerts. When
// every count is zero and burn is healthy, the whole strip dims so the
// NOW card visually breathes.
//
// Renders (in order): brand · needs-human count · failed-verify count ·
// burn elapsed/5h · loop glyph + state. Each cell suppresses itself when
// its value is zero/unknown so the bar stays scannable.

import React from "react";
import { Box, Text } from "ink";
import type { Alert } from "./alerts";
import type { LoopStatus } from "./loop-status";
import type { BurnSummary } from "./burn-tracker";
import { fmtDuration } from "./burn-tracker";
import { C } from "./tui-panels";

// Aggregate alerts into the two counts the operator cares about. "needs
// human" = red severities (verify/judge fails, cheat-done). "warnings" =
// yellow severities (stale claim, watchdog kill). gray-severity alerts
// (empty-queue) don't move the needle.
export function headerCounts(alerts: Alert[]): {
  needsHuman: number;
  warnings: number;
} {
  let needsHuman = 0;
  let warnings = 0;
  for (const a of alerts) {
    if (a.severity === "red") needsHuman += 1;
    else if (a.severity === "yellow") warnings += 1;
  }
  return { needsHuman, warnings };
}

const BUCKET_HOURS = 5;
const BUCKET_MS = BUCKET_HOURS * 60 * 60 * 1000;

// Severity color for the burn cell — matches LoopStatusFooter.burnColor so
// the operator sees the same threshold in both places.
function burnColor(b: BurnSummary): string {
  const pct = b.bucketAgeMs / BUCKET_MS;
  if (pct >= 0.9) return C.err;
  if (pct >= 0.6) return C.warn;
  return C.ok;
}

function loopStateColor(state: LoopStatus["state"]): string {
  if (state === "running") return C.ok;
  if (state === "idle") return C.warn;
  return C.err; // dead
}

function loopStateGlyph(state: LoopStatus["state"]): string {
  if (state === "running") return "◉";
  if (state === "idle") return "◌";
  return "✕"; // dead
}

export function HeaderBar({
  alerts,
  burn,
  loop,
}: {
  alerts: Alert[];
  burn: BurnSummary | null;
  loop: LoopStatus;
}): React.ReactElement {
  const { needsHuman, warnings } = headerCounts(alerts);
  const allQuiet =
    needsHuman === 0 &&
    warnings === 0 &&
    loop.state === "running" &&
    (!burn || burn.bucketStart === null || burn.bucketAgeMs / BUCKET_MS < 0.6);
  const brandColor = allQuiet ? C.dim : C.brand;
  return (
    <Box paddingX={1}>
      <Text color={brandColor} bold={!allQuiet}>
        batonq
      </Text>
      <Text color={C.dim}> · </Text>
      <Text color={needsHuman > 0 ? C.err : C.dim} bold={needsHuman > 0}>
        {needsHuman} need-action
      </Text>
      <Text color={C.dim}> · </Text>
      <Text color={warnings > 0 ? C.warn : C.dim} bold={warnings > 0}>
        {warnings} warning{warnings === 1 ? "" : "s"}
      </Text>
      <Text color={C.dim}> · burn </Text>
      {burn && burn.bucketStart !== null ? (
        <Text color={burnColor(burn)}>
          {fmtDuration(burn.bucketAgeMs)}/{BUCKET_HOURS}h
        </Text>
      ) : (
        <Text color={C.dim}>—</Text>
      )}
      <Text color={C.dim}> · loop </Text>
      <Text color={loopStateColor(loop.state)}>
        {loopStateGlyph(loop.state)}
      </Text>
      <Text color={C.dim}> {loop.state}</Text>
    </Box>
  );
}
