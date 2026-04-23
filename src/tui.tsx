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

import React, { useEffect, useMemo, useState } from "react";
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
  filterClaims,
  filterEvents,
  filterSessions,
  filterTasks,
  loadSnapshot,
  openStateDb,
  shortPath,
  type ClaimRow,
  type EventRow,
  type SessionRow,
  type Snapshot,
  type TaskRow,
} from "./tui-data";
import {
  C,
  ClaimsPanel,
  EventsPanel,
  HelpOverlay,
  LoopStatusFooter,
  SessionsPanel,
  TasksPanel,
} from "./tui-panels";
import {
  eventsAgeSec,
  findLoopCurrentTask,
  probeClaudeInfo,
  probeLoopPid,
  type LoopStatus,
} from "./loop-status";

type PanelKey = "sessions" | "tasks" | "claims" | "events";
const PANELS: PanelKey[] = ["sessions", "tasks", "claims", "events"];

type Mode = "normal" | "filter" | "help" | "confirm" | "add-task" | "questions";
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

function useTick(ms: number): { now: number; bump: () => void } {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return { now: t, bump: () => setT(Date.now()) };
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

// Build a LoopStatus snapshot — three shell probes + one DB lookup, so it's
// tied to the main refresh tick and not a separate interval. The events-age
// cell compares `now` against the events.jsonl mtime; keybind 'L' opens the
// restart-loop confirm (see useInput below).
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

  const [focus, setFocus] = useState<PanelKey>("tasks");
  const [selected, setSelected] = useState<Record<PanelKey, number>>({
    sessions: 0,
    tasks: 0,
    claims: 0,
    events: 0,
  });
  const [mode, setMode] = useState<Mode>("normal");
  const [filters, setFilters] = useState<Record<PanelKey, string>>({
    sessions: "",
    tasks: "",
    claims: "",
    events: "",
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

  const filtered = useMemo(() => {
    if (!snap) return null;
    return {
      sessions: filterSessions(snap.sessions, filters.sessions),
      tasks: filterTasks(snap.tasks.latest, filters.tasks),
      claims: filterClaims(snap.claims, filters.claims),
      events: filterEvents(snap.events, filters.events),
    };
  }, [snap, filters]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);

  useInput((input, key) => {
    if (mode === "help") {
      setMode("normal");
      return;
    }
    if (mode === "add-task" || mode === "questions") {
      // Keys in these modes are handled by the embedded form/overlay.
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
    if (key.tab) {
      const idx = PANELS.indexOf(focus);
      setFocus(PANELS[(idx + 1) % PANELS.length]!);
      return;
    }
    if (input === "j" || key.downArrow) {
      setSelected((s) => ({
        ...s,
        [focus]: Math.min(
          s[focus] + 1,
          Math.max(0, maxIndex(focus, filtered) - 1),
        ),
      }));
      return;
    }
    if (input === "k" || key.upArrow) {
      setSelected((s) => ({ ...s, [focus]: Math.max(0, s[focus] - 1) }));
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
      if (focus !== "tasks") {
        setFlash({ msg: "'a' only works on Tasks panel", color: C.warn });
        return;
      }
      const t = filtered?.tasks[selected.tasks];
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
      if (focus !== "claims") {
        setFlash({ msg: "'r' only works on Claims panel", color: C.warn });
        return;
      }
      const c = filtered?.claims[selected.claims];
      if (!c) {
        setFlash({ msg: "no claim selected", color: C.warn });
        return;
      }
      setConfirm({ kind: "release", claim: c });
      setMode("confirm");
      return;
    }
    if (input === "e") {
      // 'e'/_enrich keybind: enrich selected draft via `batonq enrich <id>`.
      if (focus !== "tasks") {
        setFlash({ msg: "'e' only works on Tasks panel", color: C.warn });
        return;
      }
      const t = filtered?.tasks[selected.tasks];
      if (!t) {
        setFlash({ msg: "no task selected", color: C.warn });
        return;
      }
      if (t.status !== "draft") {
        setFlash({ msg: "'e' only works on draft tasks", color: C.warn });
        return;
      }
      if (t.enrich_questions) {
        // Stored questions from a prior enrich — open overlay without
        // re-spawning claude. Saves a round-trip AND keeps the test path
        // deterministic when DB is pre-seeded.
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
      return;
    }
    if (input === "p") {
      // 'p'/_promote keybind: flip selected draft → pending (pick will see it).
      if (focus !== "tasks") {
        setFlash({ msg: "'p' only works on Tasks panel", color: C.warn });
        return;
      }
      const t = filtered?.tasks[selected.tasks];
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
      if (focus !== "tasks") return;
      const t = filtered?.tasks[selected.tasks];
      if (!t || t.status !== "draft" || !t.original_body) {
        setFlash({
          msg: "no enriched draft selected (o reveals the user's original body)",
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
      <Box paddingX={1} flexDirection="column">
        <Logo />
      </Box>
      <Box paddingX={1}>
        <Text color={C.dim}>tui · refresh {REFRESH_MS / 1000}s · </Text>
        <Text color={C.paper}>focus: </Text>
        <Text color={C.brand} bold>
          {focus}
        </Text>
        <Text color={C.dim}> (? for help)</Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          <SessionsPanel
            rows={filtered.sessions}
            selected={selected.sessions}
            focused={focus === "sessions"}
            now={now}
          />
          <ClaimsPanel
            rows={filtered.claims}
            selected={selected.claims}
            focused={focus === "claims"}
            now={now}
          />
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <TasksPanel
            latest={filtered.tasks}
            counts={snap.tasks.counts}
            selected={selected.tasks}
            focused={focus === "tasks"}
            expandedOriginals={expandedOriginals}
          />
          <EventsPanel
            rows={filtered.events}
            selected={selected.events}
            focused={focus === "events"}
            now={now}
          />
        </Box>
      </Box>

      <Box paddingX={1}>
        <LoopStatusFooter status={loopStatus} />
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
            → enriching {enrichingEid.slice(0, 8)} (claude --model opus,
            streaming)…
          </Text>
        )}
        {mode === "normal" && !flash && !enrichingEid && (
          <Text color={C.dim}>
            q quit · Tab focus · j/k nav · / filter · n new · e enrich · p
            promote · o original · a abandon · r release · L restart loop · ?
            help
          </Text>
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
    </Box>
  );
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

function maxIndex(
  focus: PanelKey,
  filtered: {
    sessions: SessionRow[];
    tasks: TaskRow[];
    claims: ClaimRow[];
    events: EventRow[];
  } | null,
): number {
  if (!filtered) return 1;
  const lens: Record<PanelKey, number> = {
    sessions: filtered.sessions.length,
    tasks: filtered.tasks.length,
    claims: filtered.claims.length,
    events: filtered.events.length,
  };
  return Math.max(1, lens[focus]);
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
