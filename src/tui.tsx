// tui — ink-based dashboard for batonq.
// 4 panels: Sessions, Tasks, Active claims, Event stream. Auto-refresh every 2s.
// Keybinds: q quit · Tab cycle · j/k nav · / filter · n new · e enrich draft ·
//           p promote draft · o toggle original · a abandon · r release · ? help
//
// ink-text-input vs @inkjs/ui: we use `ink-text-input` for the add-task form.
// Both list `ink >= 5` as peer (we're on ink 7), so either works. ink-text-input
// is single-purpose with only two transitive deps (chalk, type-fest); @inkjs/ui
// bundles a full component library plus cli-spinners/figures/deepmerge that we
// would not otherwise pull in. We only need a single-line input, so the smaller
// surface wins. Body is rendered with visual wrap but stored as one line — the
// TASKS.md format is line-oriented anyway.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { homedir } from "node:os";
import {
  appendClarifyingAnswers,
  externalId,
  validateNewTask,
  type ClarifyingAnswer,
  type NewTask,
} from "./tasks-core";
import {
  DEFAULT_DB_PATH,
  DEFAULT_EVENTS_PATH,
  doneBadge,
  filterClaims,
  filterEvents,
  filterSessions,
  filterTasks,
  loadSnapshot,
  openStateDb,
  priorityBucket,
  shortPath,
  type ClaimRow,
  type EventRow,
  type SessionRow,
  type Snapshot,
  type TaskRow,
} from "./tui-data";
import {
  C,
  HelpOverlay,
  LiveFeedPanel,
  LoopStatusFooter,
  PendingLane,
  RecentDoneLane,
  SessionsPanel,
} from "./tui-panels";
import { HeaderBar } from "./header-bar";
import { computeAlerts, type Alert } from "./alerts";
import { AlertLane } from "./alert-lane";
import { buildDrillDownView, DrillDownOverlay } from "./drill-down";
import {
  buildCurrentTaskInfo,
  CurrentTaskCard,
  IdleBanner,
  latestCommitSinceClaim,
} from "./current-task-card";
import {
  eventsAgeSec,
  findLoopCurrentTask,
  probeClaudeInfo,
  probeLoopPid,
  type LoopStatus,
} from "./loop-status";
import {
  BUCKET_MS,
  defaultProjectsDir,
  readTurns,
  summarize,
  type BurnSummary,
} from "./burn-tracker";
import {
  DEFAULT_LOOP_GLOB,
  FEED_POLL_MS,
  feedReducer,
  INITIAL_FEED_STATE,
  LIVE_FEED_MAX_LINES,
  mergeFeed,
  newestLoopLogPath,
  readEventsFeed,
  readGitCommitsFeed,
  readLoopFeed,
  type FeedAction,
  type FeedRecord,
  type FeedState,
} from "./live-feed";

// The single-column action-first layout has only two interactive lanes:
// the pending queue (drafts + priority-sorted pending) and the recent-done
// list (cheats hoisted). Sessions and the live feed are still available
// but only as overlays — see Mode "sessions-overlay" / "feed-overlay".
type PanelKey = "pending" | "done";
const PANELS: PanelKey[] = ["pending", "done"];

type Mode =
  | "normal"
  | "filter"
  | "help"
  | "confirm"
  | "add-task"
  | "questions"
  | "drill-down"
  | "sessions-overlay"
  | "feed-overlay";
type ConfirmAction =
  | { kind: "abandon"; task: TaskRow }
  | { kind: "release"; claim: ClaimRow }
  | { kind: "restart-loop" };

export type ParsedQuestion = { n: string; text: string };

type FormField = "repo" | "body" | "verify" | "judge";
const FORM_FIELDS: FormField[] = ["repo", "body", "verify", "judge"];

const REFRESH_MS = 2000;
const FLASH_MS = 3000;
const DEFAULT_TASKS_PATH = `${homedir()}/DEV/TASKS.md`;
// Default loop-log path used by the Alert lane's watchdog-kill detector.
// Matches runRestartLoop's output redirect so the two stay in sync.
const DEFAULT_LOOP_LOG_PATH = "/tmp/batonq-loop.log";

// Focus-scoped footer hints — only show the verbs that actually fire on the
// focused lane (k9s pattern). Global keys (q / s / l / L / ?) live in the
// help overlay so the footer stays terse.
function focusFooterHints(focus: PanelKey): string {
  if (focus === "pending") {
    return "j/k nav · ↵ drill · n new · e enrich · p promote · a abandon · / filter · s sessions · l feed · ? help";
  }
  return "j/k nav · ↵ drill · a abandon · r release · / filter · s sessions · l feed · ? help";
}

function useTick(ms: number): { now: number; bump: () => void } {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return { now: t, bump: () => setT(Date.now()) };
}

// useLiveFeed — polls the three feed sources every FEED_POLL_MS and returns
// the merged, trimmed buffer. `claimCwds` is the list of holder_cwd values
// from active claims, used to locate git repos for the [git] source. We
// pass the array through useMemo so the polling effect only re-subscribes
// when the set of cwds actually changes.
function useLiveFeed(claimCwds: string[]): FeedRecord[] {
  const [records, setRecords] = useState<FeedRecord[]>([]);
  const cwdKey = claimCwds.join("|");
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      try {
        const loopPath = newestLoopLogPath(DEFAULT_LOOP_GLOB);
        const loop = readLoopFeed(loopPath, LIVE_FEED_MAX_LINES);
        const evt = readEventsFeed(DEFAULT_EVENTS_PATH, LIVE_FEED_MAX_LINES);
        // Bound the git window to the last hour — a TUI feed shouldn't show
        // ancient commits, and --since keeps `git log` fast on big repos.
        const sinceMs = Date.now() - 60 * 60 * 1000;
        const git = readGitCommitsFeed(claimCwds, sinceMs, 5);
        const merged = mergeFeed([loop, evt, git], LIVE_FEED_MAX_LINES);
        if (!cancelled) setRecords(merged);
      } catch {
        // Keep the previous records on transient errors.
      }
    };
    poll();
    const id = setInterval(poll, FEED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cwdKey]);
  return records;
}

function useSnapshot(now: number): Snapshot | null {
  return useMemo(() => {
    try {
      const db = openStateDb(DEFAULT_DB_PATH);
      try {
        return loadSnapshot(db, {
          eventsPath: DEFAULT_EVENTS_PATH,
          limit: 20,
          now,
        });
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }, [now]);
}

// Pull the current alert list off the shared DB on each tick. We open + close
// a fresh read-only handle so the TUI never sits on a write lock (per §6's
// implementation-note constraint). A failure to read collapses to no alerts
// — the TUI should not lie about health if the DB itself is broken.
//
// Classifier lives in src/alerts.ts. Alert kinds surfaced here:
//   verify-failed / judge-failed — done row with FAIL in captured output
//   cheat-done — done task where verify_cmd IS NOT NULL AND verify_ran_at IS
//               NULL AND judge_ran_at IS NULL (the task self-closed past
//               its own gates — highest-trust failure we can detect)
//   stale-claim — >30m claimed, >10m since last progress
//   watchdog-kill — "[watchdog] … killing" grep in /tmp/batonq-loop.log
//   empty-queue — pending=0 for >15m
function useAlerts(now: number): Alert[] {
  return useMemo(() => {
    try {
      const db = openStateDb(DEFAULT_DB_PATH);
      try {
        return computeAlerts(db, {
          now,
          loopLogPath: DEFAULT_LOOP_LOG_PATH,
        });
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }, [now]);
}

// Build a LoopStatus snapshot — three shell probes + one DB lookup, so it's
// tied to the main refresh tick and not a separate interval. The events-age
// cell compares `now` against the events.jsonl mtime; keybind 'L' opens the
// restart-loop confirm (see useInput below).
// useBurn — throttled. Reading every jsonl file every 2s tick is wasteful;
// the bucket changes by at most a few hundred tokens/sec on steady-state
// traffic. Recompute every 30s and cache between.
const BURN_REFRESH_MS = 30_000;
function useBurn(now: number): BurnSummary | null {
  const cache = useRef<{ at: number; value: BurnSummary | null }>({
    at: 0,
    value: null,
  });
  return useMemo(() => {
    if (now - cache.current.at < BURN_REFRESH_MS && cache.current.at > 0) {
      return cache.current.value;
    }
    try {
      const dir = defaultProjectsDir(homedir(), process.cwd());
      const turns = readTurns(dir, now - BUCKET_MS);
      const summary = summarize(turns, now);
      cache.current = { at: now, value: summary };
      return summary;
    } catch {
      cache.current = { at: now, value: null };
      return null;
    }
  }, [now]);
}

function useLoopStatus(now: number): LoopStatus {
  return useMemo(() => {
    const loopPid = probeLoopPid();
    const claude = probeClaudeInfo();
    let state: LoopStatus["state"];
    if (loopPid === null) state = "dead";
    else if (claude === null) state = "idle";
    else state = "running";

    let currentTask: LoopStatus["currentTask"] = null;
    try {
      const db = openStateDb(DEFAULT_DB_PATH);
      try {
        currentTask = findLoopCurrentTask(db, loopPid);
      } finally {
        db.close();
      }
    } catch {
      currentTask = null;
    }

    return {
      state,
      loopPid,
      currentTask,
      claude,
      eventsAgeSec: eventsAgeSec(DEFAULT_EVENTS_PATH, now),
    };
  }, [now]);
}

export function App() {
  const { exit } = useApp();
  const { now, bump: forceRefresh } = useTick(REFRESH_MS);
  const snap = useSnapshot(now);
  const loopStatus = useLoopStatus(now);
  const burn = useBurn(now);
  const alerts = useAlerts(now);

  const [focus, setFocus] = useState<PanelKey>("pending");
  const [selected, setSelected] = useState<Record<PanelKey, number>>({
    pending: 0,
    done: 0,
  });
  const [mode, setMode] = useState<Mode>("normal");
  const [filters, setFilters] = useState<Record<PanelKey, string>>({
    pending: "",
    done: "",
  });
  const [filterInput, setFilterInput] = useState("");
  const [flash, setFlash] = useState<{ msg: string; color: string } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [addTaskRepo, setAddTaskRepo] = useState<string>("");
  const [enrichingEid, setEnrichingEid] = useState<string | null>(null);
  const [questionsPending, setQuestionsPending] = useState<{
    eid: string;
    questions: ParsedQuestion[];
  } | null>(null);
  const [expandedOriginals, setExpandedOriginals] = useState<Set<string>>(
    () => new Set(),
  );
  // Store only the external_id so the overlay picks up live DB updates on
  // every tick (a writer process may mutate verify_output / status while the
  // modal is open). The actual TaskRow is re-resolved from `snap` below.
  const [drillDownEid, setDrillDownEid] = useState<string | null>(null);
  const [feedState, setFeedState] = useState<FeedState>(INITIAL_FEED_STATE);

  // Pull the live set of claim-holder cwds off the snapshot so the feed's
  // git source knows which repos to poll. Memoized so new snapshot objects
  // with the same cwd set don't thrash the feed polling effect.
  const claimCwds = useMemo(() => {
    if (!snap) return [] as string[];
    const cwds = snap.claims
      .map((c) => c.holder_cwd ?? null)
      .filter((c): c is string => !!c);
    return Array.from(new Set(cwds));
  }, [snap]);
  const feedRecords = useLiveFeed(claimCwds);
  const dispatchFeed = (action: FeedAction) =>
    setFeedState((s) => feedReducer(s, action, feedRecords.length));

  // The single-column layout has two interactive lanes:
  //   pendingLane = drafts (hoisted) + priority-sorted pending
  //   doneLane    = cheat rows (hoisted) + remaining done
  //
  // We compute the ordered arrays here once per tick so j/k navigation, Enter
  // (drill-down), and the action keys (e/p/o/a) all resolve against the same
  // index the user sees on screen. PendingLane / RecentDoneLane mirror this
  // ordering exactly — they're pure presentation now.
  const filtered = useMemo(() => {
    if (!snap) return null;
    const pendingFiltered = filterTasks(snap.tasks.pending, filters.pending);
    const draftsFiltered = filterTasks(snap.tasks.drafts, filters.pending);
    const doneFiltered = filterTasks(snap.tasks.done, filters.done);
    const groupedPending = (() => {
      const H = pendingFiltered.filter((t) => priorityBucket(t) === "H");
      const N = pendingFiltered.filter((t) => priorityBucket(t) === "N");
      const L = pendingFiltered.filter((t) => priorityBucket(t) === "L");
      return [...H, ...N, ...L];
    })();
    const pendingLane = [...draftsFiltered, ...groupedPending];
    const cheats = doneFiltered.filter((t) => doneBadge(t) === "⚠");
    const others = doneFiltered.filter((t) => doneBadge(t) !== "⚠");
    const doneLane = [...cheats, ...others];
    return {
      pending: pendingLane,
      drafts: draftsFiltered,
      pendingOnly: pendingFiltered,
      done: doneLane,
      sessions: filterSessions(snap.sessions, ""),
      claims: filterClaims(snap.claims, ""),
      events: filterEvents(snap.events, ""),
    };
  }, [snap, filters]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);

  // Shared enrich trigger — used by the normal-mode `e` keybind and the
  // drill-down overlay's `e` callback. Mirrors the original inline logic:
  // open questions overlay if answers already stored, otherwise spawn
  // `batonq enrich` and flash progress.
  function triggerEnrich(t: TaskRow): void {
    if (t.status !== "draft") {
      setFlash({ msg: "'e' only works on draft tasks", color: C.warn });
      return;
    }
    if (t.enrich_questions) {
      const qs = parseQuestions(t.enrich_questions);
      if (qs.length === 0) {
        setFlash({
          msg: "draft has unparseable questions — re-run enrich",
          color: C.warn,
        });
        return;
      }
      setQuestionsPending({ eid: t.external_id, questions: qs });
      setMode("questions");
      return;
    }
    if (enrichingEid) {
      setFlash({
        msg: `already enriching ${enrichingEid.slice(0, 8)}`,
        color: C.warn,
      });
      return;
    }
    setEnrichingEid(t.external_id);
    setFlash({
      msg: `→ enriching ${t.external_id.slice(0, 8)} (claude --model opus)…`,
      color: C.brand,
    });
    runEnrichAsync(t.external_id)
      .then((res) => {
        setEnrichingEid(null);
        forceRefresh();
        if (res.kind === "error") {
          setFlash({ msg: `enrich failed: ${res.error}`, color: C.err });
          return;
        }
        if (res.kind === "questions") {
          setFlash({
            msg: `↯ questions stored on ${res.newEid.slice(0, 8)} — press e to answer`,
            color: C.warn,
          });
          return;
        }
        setFlash({
          msg: `✓ enriched → ${res.newEid.slice(0, 8)} (p promote, o see original)`,
          color: C.ok,
        });
      })
      .catch((e: any) => {
        setEnrichingEid(null);
        setFlash({
          msg: `enrich error: ${e?.message ?? String(e)}`,
          color: C.err,
        });
      });
  }

  // Row currently under the cursor in the focused lane.
  function selectedTask(): TaskRow | null {
    if (!filtered) return null;
    if (focus === "pending") return filtered.pending[selected.pending] ?? null;
    return filtered.done[selected.done] ?? null;
  }

  // Claim attached to the actively running task. The single-column layout
  // no longer has a Claims panel — `r` (release) targets the running task's
  // claim instead. Returns null when the queue is idle.
  function activeClaim(): ClaimRow | null {
    if (!snap) return null;
    const task = snap.tasks.claimed[0];
    if (!task) return null;
    return findClaimForTask(task, snap.claims);
  }

  useInput((input, key) => {
    if (mode === "help") {
      setMode("normal");
      return;
    }
    if (mode === "add-task" || mode === "questions" || mode === "drill-down") {
      // Keys in these modes are handled by the embedded form/overlay.
      return;
    }
    if (mode === "sessions-overlay") {
      if (key.escape || input === "q" || input === "s") setMode("normal");
      return;
    }
    if (mode === "feed-overlay") {
      if (key.escape || input === "q" || input === "l") {
        setMode("normal");
        return;
      }
      // Inside the feed overlay arrows + F + End drive the feed reducer
      // directly — no panel focus to worry about.
      if (input === "F") {
        dispatchFeed({ kind: "toggle-pause" });
        return;
      }
      if (input === "k" || key.upArrow) {
        dispatchFeed({ kind: "scroll-up" });
        return;
      }
      if (input === "j" || key.downArrow) {
        dispatchFeed({ kind: "scroll-down" });
        return;
      }
      if ((key as any).end || input === "[F" || input === "[4~") {
        dispatchFeed({ kind: "end" });
        return;
      }
      return;
    }
    if (mode === "filter") {
      if (key.return) {
        setFilters((f) => ({ ...f, [focus]: filterInput }));
        setMode("normal");
        return;
      }
      if (key.escape) {
        setFilterInput(filters[focus]);
        setMode("normal");
        return;
      }
      if (key.backspace || key.delete) {
        setFilterInput((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilterInput((s) => s + input);
      }
      return;
    }
    if (mode === "confirm") {
      if (input === "y" && confirm) {
        if (confirm.kind === "abandon") runAbandon(confirm.task, setFlash);
        else if (confirm.kind === "release")
          runRelease(confirm.claim, setFlash);
        else if (confirm.kind === "restart-loop") runRestartLoop(setFlash);
        setConfirm(null);
        setMode("normal");
        return;
      }
      if (input === "n" || key.escape) {
        setConfirm(null);
        setMode("normal");
      }
      return;
    }

    // normal mode
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "?") {
      setMode("help");
      return;
    }
    if (input === "s") {
      setMode("sessions-overlay");
      return;
    }
    if (input === "l") {
      setMode("feed-overlay");
      return;
    }
    // `A` jumps to the first alert with an externalId and opens
    // the drill-down on its task. The Alert lane itself isn't focusable, so
    // rather than introduce a fifth panel focus just for this we short-circuit
    // straight to the modal — it's what the operator actually wants (see why
    // the alert is red).
    if (input === "A") {
      const first = alerts.find((a) => a.externalId);
      if (!first) {
        setFlash({ msg: "no actionable alert", color: C.warn });
        return;
      }
      setDrillDownEid(first.externalId!);
      setMode("drill-down");
      return;
    }
    if (key.tab) {
      const idx = PANELS.indexOf(focus);
      setFocus(PANELS[(idx + 1) % PANELS.length]!);
      return;
    }
    if (input === "j" || key.downArrow) {
      const max =
        focus === "pending"
          ? (filtered?.pending.length ?? 0)
          : (filtered?.done.length ?? 0);
      setSelected((s) => ({
        ...s,
        [focus]: Math.min(s[focus] + 1, Math.max(0, max - 1)),
      }));
      return;
    }
    if (input === "k" || key.upArrow) {
      setSelected((s) => ({ ...s, [focus]: Math.max(0, s[focus] - 1) }));
      return;
    }
    if (key.return) {
      // Enter opens the drill-down overlay on the currently selected row in
      // either lane. For done rows this is the cheat-investigation entry.
      const t = selectedTask();
      if (t) {
        setDrillDownEid(t.external_id);
        setMode("drill-down");
      }
      return;
    }
    if (input === "/") {
      setFilterInput(filters[focus]);
      setMode("filter");
      return;
    }
    if (input === "n") {
      setAddTaskRepo(defaultRepoForCwd());
      setMode("add-task");
      return;
    }
    if (input === "a") {
      const t = selectedTask();
      if (!t) {
        setFlash({ msg: "no task selected", color: C.warn });
        return;
      }
      if (t.status === "done") {
        setFlash({ msg: "task already done — cannot abandon", color: C.warn });
        return;
      }
      setConfirm({ kind: "abandon", task: t });
      setMode("confirm");
      return;
    }
    if (input === "r") {
      // 'r' releases the currently-running task's claim — the single-column
      // layout has no separate Claims panel.
      const c = activeClaim();
      if (!c) {
        setFlash({ msg: "no active claim to release", color: C.warn });
        return;
      }
      setConfirm({ kind: "release", claim: c });
      setMode("confirm");
      return;
    }
    if (input === "e") {
      if (focus !== "pending") {
        setFlash({ msg: "'e' only works on the NEXT lane", color: C.warn });
        return;
      }
      const t = selectedTask();
      if (!t) {
        setFlash({ msg: "no task selected", color: C.warn });
        return;
      }
      triggerEnrich(t);
      return;
    }
    if (input === "p") {
      if (focus !== "pending") {
        setFlash({ msg: "'p' only works on the NEXT lane", color: C.warn });
        return;
      }
      const t = selectedTask();
      if (!t) {
        setFlash({ msg: "no task selected", color: C.warn });
        return;
      }
      if (t.status !== "draft") {
        setFlash({ msg: "'p' only promotes drafts", color: C.warn });
        return;
      }
      runPromote(t, setFlash);
      forceRefresh();
      return;
    }
    if (input === "L") {
      setConfirm({ kind: "restart-loop" });
      setMode("confirm");
      return;
    }
    if (input === "o") {
      if (focus !== "pending") return;
      const t = selectedTask();
      if (!t || t.status !== "draft" || !t.original_body) {
        setFlash({
          msg: "no enriched draft selected (o reveals the original body)",
          color: C.warn,
        });
        return;
      }
      setExpandedOriginals((s) => {
        const n = new Set(s);
        if (n.has(t.external_id)) n.delete(t.external_id);
        else n.add(t.external_id);
        return n;
      });
      return;
    }
  });

  if (!snap || !filtered) {
    return (
      <Box padding={1} flexDirection="column">
        <Logo />
        <Text color={C.dim}>loading state…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <HeaderBar alerts={alerts} burn={burn} loop={loopStatus} />
      <AlertLane alerts={alerts} />
      {renderCurrentTaskArea(snap, snap.claims, now, false, alerts)}
      <PendingLane
        pending={filtered.pendingOnly}
        drafts={filtered.drafts}
        draftCount={snap.tasks.counts.drafts}
        selected={selected.pending}
        focused={focus === "pending"}
        expandedOriginals={expandedOriginals}
      />
      <RecentDoneLane
        done={filtered.done}
        now={now}
        focused={focus === "done"}
      />
      <Box paddingX={1} marginTop={1}>
        <LoopStatusFooter status={loopStatus} burn={burn} />
      </Box>
      <Box paddingX={1} flexDirection="column">
        {filters[focus] && (
          <Text color={C.dim}>
            filter [{focus}]: <Text color={C.brand}>{filters[focus]}</Text>
          </Text>
        )}
        {mode === "filter" && (
          <Text color={C.brand}>
            / {filterInput}
            <Text color={C.dim}> (enter=apply, esc=cancel)</Text>
          </Text>
        )}
        {mode === "confirm" && confirm && (
          <Text color={C.warn}>
            {confirm.kind === "abandon"
              ? `abandon task ${confirm.task.external_id}? (y/n)`
              : confirm.kind === "release"
                ? `release claim on ${shortPath(confirm.claim.file_path, 50)}? (y/n)`
                : `restart batonq-loop? this kills the running loop + claude-p (y/n)`}
          </Text>
        )}
        {flash && <Text color={flash.color}>{flash.msg}</Text>}
        {enrichingEid && !flash && (
          <Text color={C.brand}>
            enriching {enrichingEid.slice(0, 8)} (claude --model opus,
            streaming)
          </Text>
        )}
        {mode === "normal" && !flash && !enrichingEid && (
          <Text color={C.dim}>{focusFooterHints(focus)}</Text>
        )}
      </Box>

      {mode === "add-task" && (
        <Box marginTop={1}>
          <AddTaskForm
            initialRepo={addTaskRepo}
            onSubmit={(t) => {
              submitAddTask(t, setFlash);
              setMode("normal");
              // Re-read the snapshot now instead of waiting up to 2s for
              // the next tick — otherwise the new task appears to "lag".
              forceRefresh();
            }}
            onCancel={() => setMode("normal")}
            onInvalidSubmit={(reason) =>
              setFlash({
                msg:
                  reason === "body-required"
                    ? "body is required"
                    : `invalid: ${reason}`,
                color: C.warn,
              })
            }
          />
        </Box>
      )}

      {mode === "questions" && questionsPending && (
        <Box marginTop={1}>
          <QuestionsOverlay
            eid={questionsPending.eid}
            questions={questionsPending.questions}
            onSubmit={(qa) => {
              try {
                const { newExternalId } = submitClarifyingAnswers(
                  questionsPending.eid,
                  qa,
                );
                setQuestionsPending(null);
                setMode("normal");
                forceRefresh();
                setEnrichingEid(newExternalId);
                setFlash({
                  msg: `→ re-enriching ${newExternalId.slice(0, 8)} with answers…`,
                  color: C.brand,
                });
                runEnrichAsync(newExternalId)
                  .then((res) => {
                    setEnrichingEid(null);
                    forceRefresh();
                    if (res.kind === "error") {
                      setFlash({
                        msg: `enrich failed: ${res.error}`,
                        color: C.err,
                      });
                      return;
                    }
                    if (res.kind === "questions") {
                      setFlash({
                        msg: `↯ more questions on ${res.newEid.slice(0, 8)} — press e again`,
                        color: C.warn,
                      });
                      return;
                    }
                    setFlash({
                      msg: `✓ enriched → ${res.newEid.slice(0, 8)} (p promote, o see original)`,
                      color: C.ok,
                    });
                  })
                  .catch((e: any) => {
                    setEnrichingEid(null);
                    setFlash({
                      msg: `enrich error: ${e?.message ?? String(e)}`,
                      color: C.err,
                    });
                  });
              } catch (e: any) {
                setFlash({
                  msg: `answer apply failed: ${e?.message ?? String(e)}`,
                  color: C.err,
                });
              }
            }}
            onCancel={() => {
              setQuestionsPending(null);
              setMode("normal");
            }}
          />
        </Box>
      )}

      {mode === "help" && (
        <Box marginTop={1}>
          <HelpOverlay />
        </Box>
      )}

      {/* Sessions overlay — shown only on demand via 's'. The single-column
          layout demoted Sessions out of the main view; this is the on-ramp
          back to it (debugging stuck sessions, claim-holder cwds, etc.). */}
      {mode === "sessions-overlay" && (
        <Box marginTop={1} flexDirection="column">
          <SessionsPanel
            rows={filtered.sessions}
            selected={0}
            focused
            now={now}
          />
          <Text color={C.dim}> Esc / s / q to close</Text>
        </Box>
      )}

      {/* Live-feed overlay — shown only on demand via 'l'. Same data as the
          old always-on panel, but only when the operator asks for it. */}
      {mode === "feed-overlay" && (
        <Box marginTop={1} flexDirection="column">
          <LiveFeedPanel records={feedRecords} state={feedState} focused />
          <Text color={C.dim}>
            {" "}
            Esc / l / q to close · F pause · End resume
          </Text>
        </Box>
      )}

      {/* Drill-down overlay (§5): Escape close · a abandon · r release-claim
          · e enrich. Opened from Tasks panel via Enter; onClose below flips
          mode back to "normal" so the main keybinds re-activate. The task
          is re-resolved from `snap` on every tick so DB updates while the
          modal is open refresh the view (verify/judge output appearing
          mid-run is the common case). */}
      {mode === "drill-down" &&
        drillDownEid &&
        (() => {
          const currentTask = findTaskByEid(snap, drillDownEid);
          if (!currentTask) {
            // Task vanished (e.g. abandoned by another process). Snap back to
            // normal on the next tick — we intentionally do this inline rather
            // than in a useEffect to keep render-side cleanup close to its cause.
            return null;
          }
          return (
            <Box marginTop={1}>
              <DrillDownOverlay
                view={buildDrillDownView(
                  currentTask,
                  resolveTaskCwd(currentTask, snap.claims),
                )}
                onClose={() => {
                  setDrillDownEid(null);
                  setMode("normal");
                }}
                onAbandon={() => {
                  if (currentTask.status === "done") {
                    setFlash({
                      msg: "task already done — cannot abandon",
                      color: C.warn,
                    });
                    return;
                  }
                  setConfirm({ kind: "abandon", task: currentTask });
                  setDrillDownEid(null);
                  setMode("confirm");
                }}
                onRelease={() => {
                  const claim = findClaimForTask(currentTask, snap.claims);
                  if (!claim) {
                    setFlash({
                      msg: "no active claim to release for this task",
                      color: C.warn,
                    });
                    return;
                  }
                  setConfirm({ kind: "release", claim });
                  setDrillDownEid(null);
                  setMode("confirm");
                }}
                onEnrich={() => {
                  setDrillDownEid(null);
                  setMode("normal");
                  triggerEnrich(currentTask);
                }}
              />
            </Box>
          );
        })()}
    </Box>
  );
}

// Look up the current state of a task by external_id across the snapshot's
// task buckets. Returns null if the task no longer exists (deleted or status
// transition that dropped it from `latest`). Used by the drill-down so the
// overlay always reflects the live row — the overlay itself is stateless wrt
// the TaskRow.
export function findTaskByEid(snap: Snapshot, eid: string): TaskRow | null {
  const all: TaskRow[] = [
    ...snap.tasks.drafts,
    ...snap.tasks.pending,
    ...snap.tasks.claimed,
    ...snap.tasks.done,
  ];
  return all.find((t) => t.external_id === eid) ?? null;
}

// Find the claim row whose holder_cwd basename matches the task's repo. This
// mirrors renderCurrentTaskArea's pairing logic — tasks.claimed_by is a PPID
// while claims.session_id is a Claude UUID, so we can't join on identity and
// fall back to cwd basename. Returns null when the task has no active claim
// (e.g. status != "claimed" or the claim row was already released).
function findClaimForTask(task: TaskRow, claims: ClaimRow[]): ClaimRow | null {
  if (task.repo.startsWith("any:")) {
    return claims[0] ?? null;
  }
  return (
    claims.find(
      (c) => c.holder_cwd && task.repo.endsWith(basename(c.holder_cwd)),
    ) ?? null
  );
}

// Pick the cwd the drill-down should use to resolve "commits since claim".
// Matches renderCurrentTaskArea: for single-repo tasks use the matching
// claim's holder_cwd; for multi-repo selectors fall back to the first live
// claim's cwd (drill-down only renders one commit list).
function resolveTaskCwd(task: TaskRow, claims: ClaimRow[]): string | null {
  const claim = findClaimForTask(task, claims);
  return claim?.holder_cwd ?? null;
}

// ── current-task area (§2 of docs/tui-ux-v2.md) ──────────────────────────────

// Pick the most-recent claimed task + its matching claim row and render the
// CurrentTaskCard. Falls back to the IdleBanner ("— idle (queue: N pending)
// —") when nothing is claimed. Kept inline in tui.tsx because it needs the
// live Snapshot + filtered claim list on every tick.
function renderCurrentTaskArea(
  snap: Snapshot,
  claims: ClaimRow[],
  now: number,
  focused: boolean,
  alerts: Alert[] = [],
): React.ReactElement | null {
  const task = snap.tasks.claimed[0] ?? null;
  if (!task) {
    // Suppress the IdleBanner when the empty-queue alert is firing — the
    // alert is more specific ("queue empty for 143m"), and rendering both
    // states the same fact twice. Header counts already convey the rest.
    const hasEmptyQueueAlert = alerts.some((a) => a.kind === "empty-queue");
    if (hasEmptyQueueAlert) return null;
    return <IdleBanner pendingCount={snap.tasks.counts.pending} />;
  }
  // Pair the task with a claim — tasks.claimed_by encodes a PPID
  // (`pid_…` / `term_…_…`) while claims.session_id is a Claude UUID, so we
  // match by cwd basename and fall back to the newest live claim.
  const claim =
    claims.find(
      (c) => c.holder_cwd && task.repo.endsWith(basename(c.holder_cwd)),
    ) ??
    claims[0] ??
    null;
  // For multi-repo selectors (`any:infra`, `any:<persona>`) the task has no
  // single home repo; scan every live claim's cwd so the card isn't blind to
  // commits landed in a sibling directory.
  const repoCwds = task.repo.startsWith("any:")
    ? claims.map((c) => c.holder_cwd).filter((c): c is string => !!c)
    : (claim?.holder_cwd ?? null);
  const commit = latestCommitSinceClaim(task.claimed_at, repoCwds);
  const info = buildCurrentTaskInfo({
    task,
    claim,
    events: snap.events,
    now,
    commit,
  });
  return <CurrentTaskCard info={info} focused={focused} />;
}

// ── logo ──────────────────────────────────────────────────────────────────────

// Small 3-line wordmark rendered above the dashboard. Box-drawing glyphs keep
// it monospace-safe across terminals. Trailing "╸" on the q gives it a tail
// so it reads differently from the o.
const LOGO_LINES = [
  "┏┓  ┏━┓ ╺┳╸ ┏━┓ ┏┓╻ ┏━┓ ",
  "┣┻┓ ┣━┫  ┃  ┃ ┃ ┃┗┫ ┃ ┃ ",
  "┗━┛ ╹ ╹  ╹  ┗━┛ ╹ ╹ ┗━┻╸",
] as const;

export function Logo(): React.ReactElement {
  return (
    <Box flexDirection="column">
      {LOGO_LINES.map((line, i) => (
        <Text key={i} color={C.brand} bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}

// ── enrich / promote / questions helpers ──────────────────────────────────────

// parseQuestions splits the enrich_questions text (stored by applyEnrichment
// on the QUESTIONS path) into a list the overlay can iterate. We accept both
// "1. text" and "1) text" numbering and fold continuation lines into the
// previous question so opus-style multi-line questions stay intact.
export function parseQuestions(
  raw: string | null | undefined,
): ParsedQuestion[] {
  if (!raw || !raw.trim()) return [];
  const out: ParsedQuestion[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
    if (m) {
      out.push({ n: m[1]!, text: m[2]!.trim() });
    } else if (out.length > 0 && line.trim()) {
      out[out.length - 1]!.text += " " + line.trim();
    }
  }
  return out;
}

export type EnrichOutcome =
  | { kind: "questions"; newEid: string }
  | { kind: "enriched"; newEid: string }
  | { kind: "error"; newEid: string; error: string };

// runEnrichAsync spawns `batonq enrich <eid>` and inspects the DB afterwards
// to determine which branch applyEnrichment took. Used by the TUI's `e`
// keybind. The CLI's stdout contains "external_id: <old> → <new>" when body
// rewrote, which lets us locate the updated row even though eid shifted.
export async function runEnrichAsync(
  eid: string,
  dbPath: string = DEFAULT_DB_PATH,
): Promise<EnrichOutcome> {
  const proc = Bun.spawn([findBatonqBin(), "enrich", eid], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    return {
      kind: "error",
      newEid: eid,
      error: stderr.trim() || stdout.trim() || `exit ${code}`,
    };
  }
  const m = stdout.match(/external_id:\s*([0-9a-f]+)\s*→\s*([0-9a-f]+)/i);
  const currentEid = m ? m[2]! : eid;
  const db = openStateDb(dbPath);
  try {
    const row = db
      .query(
        "SELECT enrich_questions, body, original_body FROM tasks WHERE external_id = ?",
      )
      .get(currentEid) as any;
    if (row?.enrich_questions) {
      return { kind: "questions", newEid: currentEid };
    }
    return { kind: "enriched", newEid: currentEid };
  } finally {
    db.close();
  }
}

export function runPromote(
  task: TaskRow,
  setFlash: (f: { msg: string; color: string }) => void,
): void {
  const r = spawnSync(findBatonqBin(), ["promote", task.external_id], {
    encoding: "utf8",
  });
  if (r.status === 0) {
    setFlash({
      msg: `✓ promoted ${task.external_id.slice(0, 8)} → pending`,
      color: C.ok,
    });
  } else {
    setFlash({
      msg: `promote failed: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`,
      color: C.err,
    });
  }
}

// submitClarifyingAnswers writes the Q&A the user typed into the TUI overlay
// back to the DB + TASKS.md via tasks-core, so the caller can immediately
// re-run enrich with the augmented body. Kept here (not in tasks-core) because
// it opens a real DB handle and is tied to the TUI's DEFAULT_* paths.
export function submitClarifyingAnswers(
  eid: string,
  qa: ClarifyingAnswer[],
  tasksPath: string = DEFAULT_TASKS_PATH,
  dbPath: string = DEFAULT_DB_PATH,
): { oldExternalId: string; newExternalId: string } {
  const db = openStateDb(dbPath);
  try {
    return appendClarifyingAnswers(db, tasksPath, eid, qa);
  } finally {
    db.close();
  }
}

export function QuestionsOverlay({
  eid,
  questions,
  onSubmit,
  onCancel,
}: {
  eid: string;
  questions: ParsedQuestion[];
  onSubmit: (answers: ClarifyingAnswer[]) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [answers, setAnswers] = useState<string[]>(() =>
    questions.map(() => ""),
  );
  const [focusIdx, setFocusIdx] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      const next = key.shift
        ? (focusIdx - 1 + questions.length) % questions.length
        : (focusIdx + 1) % questions.length;
      setFocusIdx(next);
      return;
    }
    if (key.return) {
      if (answers.some((a) => !a.trim())) return;
      onSubmit(
        questions.map((q, i) => ({
          question: q.text,
          answer: answers[i] ?? "",
        })),
      );
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={C.brand}
      paddingX={1}
    >
      <Text bold color={C.brand}>
        Clarifying questions — draft {eid.slice(0, 8)}
      </Text>
      {questions.map((q, i) => {
        const active = focusIdx === i;
        return (
          <Box key={i} flexDirection="column" marginTop={1}>
            <Text color={active ? C.brand : C.paper}>
              {active ? "› " : "  "}
              {q.n}. {q.text}
            </Text>
            <Box paddingLeft={2}>
              <Text color={C.dim}>a: </Text>
              <Box flexGrow={1}>
                <TextInput
                  value={answers[i] ?? ""}
                  onChange={(v) =>
                    setAnswers((a) => a.map((x, j) => (j === i ? v : x)))
                  }
                  focus={active}
                />
              </Box>
            </Box>
          </Box>
        );
      })}
      <Text color={C.dim}>
        Tab/Shift-Tab: field · Enter: submit (all required) · Esc: cancel
      </Text>
    </Box>
  );
}

export function AddTaskForm({
  initialRepo = "",
  onSubmit,
  onCancel,
  onInvalidSubmit,
}: {
  initialRepo?: string;
  onSubmit: (t: NewTask) => void;
  onCancel: () => void;
  onInvalidSubmit?: (reason: string) => void;
}): React.ReactElement {
  const [form, setForm] = useState<NewTask>({
    repo: initialRepo,
    body: "",
    verify: "",
    judge: "",
  });
  const [focus, setFocus] = useState<FormField>("body");

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      const idx = FORM_FIELDS.indexOf(focus);
      const next = key.shift
        ? (idx - 1 + FORM_FIELDS.length) % FORM_FIELDS.length
        : (idx + 1) % FORM_FIELDS.length;
      setFocus(FORM_FIELDS[next]!);
      return;
    }
    if (key.return) {
      const v = validateNewTask(form);
      if (!v.ok) {
        onInvalidSubmit?.(v.reason ?? "invalid");
        return;
      }
      onSubmit(form);
    }
  });

  const rows: { key: FormField; label: string; hint?: string }[] = [
    { key: "repo", label: "Repo   " },
    { key: "body", label: "Body   ", hint: "(required)" },
    { key: "verify", label: "Verify ", hint: "(optional)" },
    { key: "judge", label: "Judge  ", hint: "(optional)" },
  ];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={C.brand}
      paddingX={1}
    >
      <Text color={C.brand} bold>
        new task
      </Text>
      {rows.map((r) => {
        const active = focus === r.key;
        return (
          <Box key={r.key} flexDirection="row">
            <Text color={active ? C.brand : C.dim}>
              {active ? "› " : "  "}
              {r.label}
            </Text>
            <Box flexGrow={1}>
              <TextInput
                value={form[r.key] ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, [r.key]: v }))}
                focus={active}
                placeholder={active ? "" : (r.hint ?? "")}
              />
            </Box>
          </Box>
        );
      })}
      <Text color={C.dim}>
        Tab/Shift-Tab: field · Enter: submit · Esc: cancel
      </Text>
    </Box>
  );
}

export function runAbandon(
  task: TaskRow,
  setFlash: (f: { msg: string; color: string }) => void,
): void {
  const r = spawnSync(findBatonqBin(), ["abandon", task.external_id], {
    encoding: "utf8",
  });
  if (r.status === 0) {
    setFlash({ msg: `abandoned ${task.external_id}`, color: C.ok });
  } else {
    setFlash({
      msg: `abandon failed: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`,
      color: C.err,
    });
  }
}

// runRestartLoop kills any running agent-coord-loop and detaches a fresh one
// via `nohup`, redirecting stdout/stderr to /tmp/batonq-loop.log. Using
// `detached: true` + stdio "ignore" keeps the new loop alive after the TUI
// exits — the whole point is that pressing L fixes a wedged loop without
// leaving the dashboard.
export function runRestartLoop(
  setFlash: (f: { msg: string; color: string }) => void,
): void {
  // Kill the loop AND its claude-p child explicitly. Relying on parent-death
  // to reap the child leaves orphaned `claude -p` processes running
  // gtimeout/claude trees that would outlive the restart and race the new
  // loop for events.jsonl writes.
  spawnSync("pkill", ["-f", "agent-coord-loop"], { encoding: "utf8" });
  spawnSync("pkill", ["-f", "claude -p"], { encoding: "utf8" });
  const bin = resolveLoopBin();
  if (!bin) {
    setFlash({
      msg: "restart failed: agent-coord-loop not found on PATH",
      color: C.err,
    });
    return;
  }
  try {
    const logPath = "/tmp/batonq-loop.log";
    const fs = require("node:fs");
    const out = fs.openSync(logPath, "a");
    const child = spawn("nohup", [bin], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    setFlash({
      msg: `✓ batonq-loop restarted (pid ${child.pid}, log: ${logPath})`,
      color: C.ok,
    });
  } catch (e: any) {
    setFlash({
      msg: `restart failed: ${e?.message ?? String(e)}`,
      color: C.err,
    });
  }
}

function resolveLoopBin(): string | null {
  // Prefer `batonq-loop` on PATH (what the installer drops), fall back to the
  // legacy `agent-coord-loop` name and the in-repo binary for dev checkouts.
  for (const name of ["batonq-loop", "agent-coord-loop"]) {
    const r = spawnSync("command", ["-v", name], {
      encoding: "utf8",
      shell: "/bin/sh",
    });
    const found = (r.stdout ?? "").trim();
    if (found) return found;
  }
  const local = new URL("../bin/batonq-loop", import.meta.url).pathname;
  try {
    require("node:fs").accessSync(local);
    return local;
  } catch {
    return null;
  }
}

export function runRelease(
  claim: ClaimRow,
  setFlash: (f: { msg: string; color: string }) => void,
): void {
  const r = spawnSync(findBatonqBin(), ["release", claim.file_path], {
    encoding: "utf8",
  });
  if (r.status === 0) {
    setFlash({
      msg: `released ${shortPath(claim.file_path, 40)}`,
      color: C.ok,
    });
  } else {
    setFlash({
      msg: `release failed: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`,
      color: C.err,
    });
  }
}

export function findBatonqBin(): string {
  return new URL("../bin/batonq", import.meta.url).pathname;
}

export function defaultRepoForCwd(cwd: string = process.cwd()): string {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (r.status === 0) {
    const root = (r.stdout ?? "").trim();
    if (root) return basename(root);
  }
  return "any:infra";
}

export function submitAddTask(
  form: NewTask,
  setFlash: (f: { msg: string; color: string }) => void,
  _tasksPath: string = DEFAULT_TASKS_PATH,
): void {
  // Route through `batonq add` so the TUI uses the same DB-first, Zod-gated
  // path as the CLI. Drafts still flow through the existing enrich/promote
  // workflow — the `--status draft` flag preserves that semantic. The first
  // positional arg retained for backwards-compat with the old signature.
  void _tasksPath;
  const repo = form.repo.trim() || defaultRepoForCwd();
  const body = form.body.replace(/\s+/g, " ").trim();
  if (!body) {
    setFlash({ msg: "add failed: body is required", color: C.err });
    return;
  }
  const args = ["add", "--body", body, "--repo", repo, "--status", "draft"];
  if (form.verify?.trim()) args.push("--verify", form.verify.trim());
  if (form.judge?.trim()) args.push("--judge", form.judge.trim());
  const r = spawnSync(findBatonqBin(), args, { encoding: "utf8" });
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    setFlash({
      msg: `add failed: ${stderr.split("\n").slice(0, 2).join(" ") || `exit ${r.status}`}`,
      color: C.err,
    });
    return;
  }
  // Extract external_id from `task added: <eid>` stdout. Fall back to our
  // own computation if parsing fails (shouldn't, but keeps the flash honest).
  const m = (r.stdout ?? "").match(/task added:\s+(\S+)/);
  const eid = m?.[1] ?? externalId(repo, body);
  setFlash({
    msg: `✓ Draft added (id ${eid.slice(0, 8)}). Enrich + promote to queue.`,
    color: C.ok,
  });
}

if (import.meta.main) {
  render(<App />);
}
