// tui — ink-based dashboard for batonq.
// 4 panels: Sessions, Tasks, Active claims, Event stream. Auto-refresh every 2s.
// Keybinds: q quit · Tab cycle · j/k nav · / filter · n new · a abandon · r release · ? help
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
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { homedir } from "node:os";
import {
  appendTaskToPending,
  externalId,
  validateNewTask,
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
  SessionsPanel,
  TasksPanel,
} from "./tui-panels";

type PanelKey = "sessions" | "tasks" | "claims" | "events";
const PANELS: PanelKey[] = ["sessions", "tasks", "claims", "events"];

type Mode = "normal" | "filter" | "help" | "confirm" | "add-task";
type ConfirmAction =
  | { kind: "abandon"; task: TaskRow }
  | { kind: "release"; claim: ClaimRow };

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

export function App() {
  const { exit } = useApp();
  const { now, bump: forceRefresh } = useTick(REFRESH_MS);
  const snap = useSnapshot(now);

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
    if (mode === "add-task") {
      // Keys in add-task mode are handled by <AddTaskForm/> itself.
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
        else runRelease(confirm.claim, setFlash);
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
    }
  });

  if (!snap || !filtered) {
    return (
      <Box padding={1} flexDirection="column">
        <Text color={C.brand} bold>
          batonq
        </Text>
        <Text color={C.dim}>loading state…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={C.brand} bold>
          batonq
        </Text>
        <Text color={C.dim}> tui · refresh {REFRESH_MS / 1000}s · </Text>
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
          />
          <EventsPanel
            rows={filtered.events}
            selected={selected.events}
            focused={focus === "events"}
            now={now}
          />
        </Box>
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
              : `release claim on ${shortPath(confirm.claim.file_path, 50)}? (y/n)`}
          </Text>
        )}
        {flash && <Text color={flash.color}>{flash.msg}</Text>}
        {mode === "normal" && !flash && (
          <Text color={C.dim}>
            q quit · Tab focus · j/k nav · / filter · n new · a abandon · r
            release · ? help
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

      {mode === "help" && (
        <Box marginTop={1}>
          <HelpOverlay />
        </Box>
      )}
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
  tasksPath: string = DEFAULT_TASKS_PATH,
): void {
  const repo = form.repo.trim() || defaultRepoForCwd();
  const task: NewTask = {
    repo,
    body: form.body,
    verify: form.verify,
    judge: form.judge,
  };
  try {
    appendTaskToPending(tasksPath, task);
    const eid = externalId(
      task.repo.trim(),
      task.body.replace(/\s+/g, " ").trim(),
    );
    const sync = spawnSync(findBatonqBin(), ["sync-tasks"], {
      encoding: "utf8",
    });
    if (sync.status !== 0) {
      setFlash({
        msg: `added, but sync-tasks failed: ${(sync.stderr ?? "").trim() || `exit ${sync.status}`}`,
        color: C.warn,
      });
      return;
    }
    setFlash({ msg: `✓ Task added (id ${eid.slice(0, 8)})`, color: C.ok });
  } catch (e: any) {
    setFlash({ msg: `add failed: ${e.message ?? String(e)}`, color: C.err });
  }
}

if (import.meta.main) {
  render(<App />);
}
