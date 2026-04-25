// agent-coord-loop.test — guards the Path A runner and its liveness watchdog.
//
// Covers:
//   1. shellcheck passes on agent-coord-loop and agent-coord-loop-watchdog.
//   2. Watchdog kills a mock long-running child when events.jsonl goes stale.
//   3. Watchdog respects the warm-up window (no kill during warm-up).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LOOP_SCRIPT = join(REPO_ROOT, "src", "agent-coord-loop");
const WATCHDOG_SCRIPT = join(REPO_ROOT, "src", "agent-coord-loop-watchdog");
const COMPAT_SCRIPT = join(REPO_ROOT, "src", "batonq-platform-compat.sh");

const shellcheck = spawnSync("command", ["-v", "shellcheck"], {
  shell: true,
  encoding: "utf8",
});
const hasShellcheck = shellcheck.status === 0;

// -x follows sourced scripts so the `source=./batonq-platform-compat.sh`
// directive is honoured; -P SCRIPTDIR resolves that relative path against the
// analyzed file's directory rather than the test's CWD.
const SHELLCHECK_ARGS = ["-x", "-P", "SCRIPTDIR"];

describe("agent-coord-loop: shellcheck", () => {
  test.skipIf(!hasShellcheck)("loop script passes shellcheck", () => {
    const r = spawnSync("shellcheck", [...SHELLCHECK_ARGS, LOOP_SCRIPT], {
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test.skipIf(!hasShellcheck)("watchdog script passes shellcheck", () => {
    const r = spawnSync("shellcheck", [...SHELLCHECK_ARGS, WATCHDOG_SCRIPT], {
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test.skipIf(!hasShellcheck)(
    "platform-compat helper passes shellcheck",
    () => {
      const r = spawnSync("shellcheck", [...SHELLCHECK_ARGS, COMPAT_SCRIPT], {
        encoding: "utf8",
      });
      expect(r.stdout + r.stderr).toBe("");
      expect(r.status).toBe(0);
    },
  );
});

// Resolve the timeout-binary name the same way the watchdog does, so the
// harness spawns a process that `pkill -f "$TIMEOUT_NAME"` will actually
// match (gtimeout on macOS, timeout on Linux CI).
const TIMEOUT_CMD = (() => {
  const r = spawnSync(
    "bash",
    ["-c", `. "${COMPAT_SCRIPT}"; batonq_timeout_cmd`],
    { encoding: "utf8" },
  );
  return (r.stdout ?? "").trim() || "timeout";
})();

// Spawn a long-running victim process under a harness shell so the watchdog's
// `pkill -P <parent>` has a real child tree to reap. The harness waits for the
// victim, then exits — which is how we observe the kill: the harness's exit
// code flips to non-zero (SIGTERM propagated).
function spawnVictim(): {
  parentPid: number;
  wait: () => Promise<{ code: number | null; signal: string | null }>;
} {
  // The harness runs `<timeout> 600 sleep 600` as a child of a bash parent so
  // the watchdog's `pkill -P <parent> -f "<timeout>"` has something to match.
  // The echoed PID is the bash parent — that's what we pass to the watchdog.
  //
  // Trailing `exit $?` serves two purposes:
  //  1. Keeps bash from tail-call-exec'ing the timeout command — without it,
  //     bash 5 (Linux CI) replaces itself with `timeout`, so there's no
  //     bash→timeout parent-child link for pkill -P to walk. bash 3.2 (macOS
  //     local) doesn't optimize this way, which is why the breakage was
  //     CI-only.
  //  2. Propagates the timeout's exit code (143 when SIGTERM'd, or signal)
  //     so the kills-stale test can observe a non-zero exit.
  const proc = spawn(
    "bash",
    ["-c", `echo "$$"; ${TIMEOUT_CMD} 600 sleep 600; exit $?`],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const parentPidPromise = new Promise<number>((resolveFn) => {
    let buf = "";
    proc.stdout!.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        resolveFn(parseInt(buf.slice(0, nl).trim(), 10));
      }
    });
  });

  const wait = () =>
    new Promise<{ code: number | null; signal: string | null }>((resolveFn) => {
      proc.on("exit", (code, signal) => resolveFn({ code, signal }));
    });

  return {
    get parentPid(): number {
      throw new Error("use getParentPid()");
    },
    wait,
    async getParentPid(): Promise<number> {
      return parentPidPromise;
    },
  } as {
    parentPid: number;
    wait: () => Promise<{ code: number | null; signal: string | null }>;
    getParentPid: () => Promise<number>;
  };
}

// Cross-platform helper tests: the bash scripts must run on both macOS
// (BSD stat / gtimeout) and Linux (GNU stat / timeout). We verify the
// compat helpers branch correctly by mocking `uname` with a shim on PATH,
// then asserting the function picks the right flags / command name.
describe("batonq-platform-compat.sh", () => {
  let tmp: string;
  let shimBin: string;
  let dataFile: string;
  const realMtime = 1_700_000_000; // any fixed epoch seconds

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "batonq-compat-"));
    shimBin = join(tmp, "bin");
    mkdirSync(shimBin, { recursive: true });
    dataFile = join(tmp, "target.txt");
    writeFileSync(dataFile, "hello\n");
    utimesSync(dataFile, realMtime, realMtime);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeUnameShim(osName: string) {
    const shim = join(shimBin, "uname");
    writeFileSync(shim, `#!/bin/sh\necho ${osName}\n`);
    chmodSync(shim, 0o755);
  }

  function sourceAndRun(funcCall: string): {
    stdout: string;
    stderr: string;
    status: number | null;
  } {
    // Prepend our shim dir so `uname` resolves to our fake, but keep the
    // real PATH so `stat` / `command` / `echo` still resolve to coreutils.
    const env = {
      ...process.env,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
    };
    const r = spawnSync("bash", ["-c", `. "${COMPAT_SCRIPT}"; ${funcCall}`], {
      env,
      encoding: "utf8",
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status,
    };
  }

  test("batonq_timeout_cmd returns gtimeout when uname=Darwin", () => {
    writeUnameShim("Darwin");
    const r = sourceAndRun("batonq_timeout_cmd");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("gtimeout");
  });

  test("batonq_timeout_cmd returns timeout when uname=Linux", () => {
    writeUnameShim("Linux");
    const r = sourceAndRun("batonq_timeout_cmd");
    expect(r.status).toBe(0);
    // On a Linux host `timeout` is on PATH so the function echoes `timeout`;
    // on a macOS host it may fall through to `gtimeout` because `timeout`
    // isn't installed. Both are valid outcomes for the Linux branch — the
    // point is that gtimeout-only is NOT the mandatory answer on Linux.
    expect(["timeout", "gtimeout"]).toContain(r.stdout.trim());
  });

  test("batonq_mtime on native uname returns correct mtime", () => {
    // Don't shim uname — use the real one. This proves the native code
    // path works on whatever platform CI runs on.
    const r = spawnSync(
      "bash",
      ["-c", `. "${COMPAT_SCRIPT}"; batonq_mtime "${dataFile}"`],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(parseInt(r.stdout.trim(), 10)).toBe(realMtime);
  });

  test("batonq_mtime with uname=Darwin invokes BSD stat (-f %m)", () => {
    writeUnameShim("Darwin");
    // Shim `stat` to record its args so we can assert which flag batonq_mtime
    // selected. Echo a recognisable sentinel so we also see it made it past
    // the case branch.
    const statShim = join(shimBin, "stat");
    const argLog = join(tmp, "stat-args.log");
    writeFileSync(statShim, `#!/bin/sh\necho "$@" >> "${argLog}"\necho 42\n`);
    chmodSync(statShim, 0o755);
    const r = sourceAndRun(`batonq_mtime "${dataFile}"`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("42");
    const recorded = require("node:fs").readFileSync(argLog, "utf8").trim();
    expect(recorded).toBe(`-f %m ${dataFile}`);
  });

  test("batonq_mtime with uname=Linux invokes GNU stat (-c %Y)", () => {
    writeUnameShim("Linux");
    const statShim = join(shimBin, "stat");
    const argLog = join(tmp, "stat-args.log");
    writeFileSync(statShim, `#!/bin/sh\necho "$@" >> "${argLog}"\necho 99\n`);
    chmodSync(statShim, 0o755);
    const r = sourceAndRun(`batonq_mtime "${dataFile}"`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("99");
    const recorded = require("node:fs").readFileSync(argLog, "utf8").trim();
    expect(recorded).toBe(`-c %Y ${dataFile}`);
  });

  test("batonq_mtime returns 0 for a missing file", () => {
    const r = sourceAndRun(`batonq_mtime "${tmp}/does-not-exist"`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0");
  });
});

describe("agent-coord-loop-watchdog", () => {
  let tmp: string;
  let eventsLog: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "batonq-watchdog-"));
    eventsLog = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test(
    "kills stale child tree once staleness threshold is exceeded",
    async () => {
      // Pre-create an events.jsonl with mtime in the distant past so it looks
      // stale the moment the watchdog's first check fires.
      writeFileSync(eventsLog, "{}\n");
      const longAgo = Math.floor(Date.now() / 1000) - 99999;
      utimesSync(eventsLog, longAgo, longAgo);

      const victim = spawnVictim();
      const parentPid: number = await (victim as any).getParentPid();

      const watchdog = spawn(
        "bash",
        [WATCHDOG_SCRIPT, String(parentPid), eventsLog],
        {
          env: {
            ...process.env,
            BATONQ_WATCHDOG_STALE_SEC: "5",
            BATONQ_WATCHDOG_WARMUP_SEC: "0",
            BATONQ_WATCHDOG_POLL_SEC: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // Bound the test: if the victim is still alive after 10s, fail.
      const timeout = new Promise<{ code: null; signal: null }>((resolveFn) =>
        setTimeout(() => resolveFn({ code: null, signal: null }), 10_000),
      );

      const result = await Promise.race([victim.wait(), timeout]);

      // Clean up the watchdog either way — it should have exited on its own
      // after killing, but be safe.
      watchdog.kill("SIGKILL");

      // The victim should have been signalled (SIGTERM) by pkill. Exit code
      // should be either null (signal-killed) or 143 (128 + 15) depending on
      // how bash reports it.
      const killed =
        result.signal === "SIGTERM" ||
        result.code === 143 ||
        // Some bash versions exit 130/137 if propagation lands oddly — any
        // non-zero exit within the bound proves the kill fired.
        (result.code !== null && result.code !== 0);
      expect(killed).toBe(true);
    },
    { timeout: 15_000 },
  );

  test(
    "respects warm-up window (no kill during warm-up)",
    async () => {
      writeFileSync(eventsLog, "{}\n");
      const longAgo = Math.floor(Date.now() / 1000) - 99999;
      utimesSync(eventsLog, longAgo, longAgo);

      const victim = spawnVictim();
      const parentPid: number = await (victim as any).getParentPid();

      const watchdog = spawn(
        "bash",
        [WATCHDOG_SCRIPT, String(parentPid), eventsLog],
        {
          env: {
            ...process.env,
            BATONQ_WATCHDOG_STALE_SEC: "1",
            // 10s warm-up — the victim must still be alive during this window
            // even though the log is obviously stale.
            BATONQ_WATCHDOG_WARMUP_SEC: "10",
            BATONQ_WATCHDOG_POLL_SEC: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // Wait 4 seconds — less than warm-up. Victim must still be running.
      const early = new Promise<"survived">((resolveFn) =>
        setTimeout(() => resolveFn("survived"), 4_000),
      );
      const dead = victim.wait().then(() => "killed" as const);

      const outcome = await Promise.race([early, dead]);
      expect(outcome).toBe("survived");

      // Clean up: kill both so the test doesn't leak processes.
      watchdog.kill("SIGKILL");
      spawnSync("bash", ["-c", `kill -9 ${parentPid} 2>/dev/null; true`]);
      await victim.wait().catch(() => undefined);
    },
    { timeout: 15_000 },
  );
});

// Dispatch tests: drive the loop with a mock `batonq` on PATH so we can
// inspect the argv it builds for `agent-run`. The mock writes its argv to a
// known file on the first `batonq agent-run` call and emits NO_TASK on the
// second `batonq pick` so the loop drops into its 60s sleep — at that point
// we tear it down. Nothing here exercises the real Claude/codex/gemini
// CLIs; we're verifying the routing/fallback logic in the bash loop.
describe("agent-coord-loop: dispatch via batonq agent-run", () => {
  let tmp: string;
  let mockBin: string;
  let argsLog: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "batonq-dispatch-"));
    mockBin = join(tmp, "bin");
    mkdirSync(mockBin, { recursive: true });
    argsLog = join(tmp, "agent-run-args.log");
    // The loop reads ~/.claude/commands/pick-next.md at startup; HOME=tmp
    // redirects that read into our scratch dir.
    mkdirSync(join(tmp, ".claude", "commands"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "commands", "pick-next.md"), "stub");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeMockBatonq(opts: {
    pickAgent: string;
    pickModel: string;
  }): void {
    // The mock acts as `batonq pick` (returns one TASK_CLAIMED then NO_TASK
    // on subsequent calls), `batonq agent-run` (records argv), and
    // `batonq done`/`abandon` (no-ops). The pick-once-then-empty pattern
    // keeps the loop from looping forever and racing the test cleanup.
    const script = `#!/bin/sh
case "$1" in
  pick)
    if [ -f "${tmp}/pick_done" ]; then
      echo "NO_TASK"
      echo "queue empty"
      exit 0
    fi
    touch "${tmp}/pick_done"
    cat <<'PICK_EOF'
TASK_CLAIMED
external_id: deadbeef0001
repo:        batonq
priority:    normal
agent:       ${opts.pickAgent}
model:       ${opts.pickModel}
session:     pid_99

TASK:
do nothing meaningful

When complete:   batonq done deadbeef0001
If abandoning:   batonq abandon deadbeef0001
PICK_EOF
    ;;
  agent-run)
    shift
    # Record each argv element on its own line so the test can grep without
    # caring about quoting (multi-line --prompt values would otherwise muddle
    # a single-line dump).
    : > "${argsLog}"
    for a in "$@"; do
      printf '%s\\n' "$a" >> "${argsLog}"
    done
    exit 0
    ;;
  done|abandon)
    exit 0
    ;;
  *)
    echo "mock batonq: unhandled subcommand $1" >&2
    exit 2
    ;;
esac
`;
    const path = join(mockBin, "batonq");
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  function writeAvailableTool(name: string): void {
    // No-op stub so `command -v <name>` succeeds during the loop's
    // availability gate. We don't actually invoke the tool.
    const path = join(mockBin, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }

  // Spawn the loop with a controlled PATH and HOME, wait until the mock
  // batonq writes its argv log, then SIGKILL the whole process group so the
  // watchdog (a backgrounded child of the loop) is reaped along with bash.
  async function runLoopUntilDispatched(
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    const proc = spawn("bash", [LOOP_SCRIPT], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const start = Date.now();
      while (!existsSync(argsLog) && Date.now() - start < 8_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        // already dead
      }
      await new Promise((r) => proc.on("exit", () => r(undefined)));
    }
    if (!existsSync(argsLog)) {
      throw new Error(
        "loop never invoked agent-run within 8s — mock batonq or watchdog wiring is wrong",
      );
    }
    return require("node:fs").readFileSync(argsLog, "utf8") as string;
  }

  test(
    "dispatches with the agent and model emitted by `batonq pick`",
    async () => {
      writeMockBatonq({ pickAgent: "gemini", pickModel: "flash" });
      writeAvailableTool("gemini");

      const recorded = await runLoopUntilDispatched({
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH ?? ""}`,
        HOME: tmp,
      });

      // argv should include --tool=gemini and --model=flash. We don't pin
      // ordering — the loop is free to reshape argv layout in the future.
      expect(recorded).toContain("--tool=gemini");
      expect(recorded).toContain("--model=flash");
    },
    { timeout: 15_000 },
  );

  test(
    "BATONQ_FORCE_AGENT overrides the picked agent",
    async () => {
      // Pick says gemini, but operator pinned codex via env.
      writeMockBatonq({ pickAgent: "gemini", pickModel: "flash" });
      writeAvailableTool("gemini");
      writeAvailableTool("codex");

      const recorded = await runLoopUntilDispatched({
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH ?? ""}`,
        HOME: tmp,
        BATONQ_FORCE_AGENT: "codex",
      });

      expect(recorded).toContain("--tool=codex");
      expect(recorded).not.toContain("--tool=gemini");
    },
    { timeout: 15_000 },
  );

  test(
    "falls back to claude when the picked agent is not on PATH",
    async () => {
      // Use a deliberately bogus tool name so we don't have to filter the
      // real PATH. Picking "gemini" here would make the test flaky on dev
      // boxes that have gemini-cli installed (command -v would succeed and
      // the fallback wouldn't fire). A random-suffix name is guaranteed
      // missing on every host.
      const missing = "batonq-fake-tool-zzz9999";
      writeMockBatonq({ pickAgent: missing, pickModel: "flash" });
      writeAvailableTool("claude");

      const recorded = await runLoopUntilDispatched({
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH ?? ""}`,
        HOME: tmp,
      });

      expect(recorded).toContain("--tool=claude");
      expect(recorded).not.toContain(`--tool=${missing}`);
    },
    { timeout: 15_000 },
  );
});
