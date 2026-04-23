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

const shellcheck = spawnSync("command", ["-v", "shellcheck"], {
  shell: true,
  encoding: "utf8",
});
const hasShellcheck = shellcheck.status === 0;

describe("agent-coord-loop: shellcheck", () => {
  test.skipIf(!hasShellcheck)("loop script passes shellcheck", () => {
    const r = spawnSync("shellcheck", [LOOP_SCRIPT], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test.skipIf(!hasShellcheck)("watchdog script passes shellcheck", () => {
    const r = spawnSync("shellcheck", [WATCHDOG_SCRIPT], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

// Spawn a long-running victim process under a harness shell so the watchdog's
// `pkill -P <parent>` has a real child tree to reap. The harness waits for the
// victim, then exits — which is how we observe the kill: the harness's exit
// code flips to non-zero (SIGTERM propagated).
function spawnVictim(): {
  parentPid: number;
  wait: () => Promise<{ code: number | null; signal: string | null }>;
} {
  // The harness runs `gtimeout 600 sleep 600` as a child of a bash parent so
  // the watchdog's `pkill -P <parent> -f "gtimeout"` has something to match.
  // The echoed PID is the bash parent — that's what we pass to the watchdog.
  const proc = spawn("bash", ["-c", 'echo "$$"; gtimeout 600 sleep 600'], {
    stdio: ["ignore", "pipe", "pipe"],
  });

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
