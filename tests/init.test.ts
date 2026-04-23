// init — `batonq init` first-run wizard. Two contracts to defend:
//
//   1. fresh HOME (no settings.json)  →  init merges three batonq hooks
//      (PreToolUse pre, PreToolUse bash, PostToolUse post) into a freshly
//      created settings.json, all pointing at a batonq-hook command path.
//
//   2. existing HOME with batonq hooks already present  →  init is a no-op
//      on settings.json. The byte-for-byte file is unchanged. This is the
//      idempotency guarantee — re-running init must never duplicate the
//      hook entries or rewrite an unrelated user-managed config.
//
// Both tests use --yes so no prompt is awaited; we run via spawnSync against
// the real src/agent-coord script with $HOME pointed at a tmp dir so the
// CLI's HOME-derived constants resolve to an isolated state tree.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "src", "agent-coord");

function runInit(home: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("bun", [CLI, "init", "--yes"], {
    env: {
      ...process.env,
      HOME: home,
      // Force non-TTY so promptYesNo's TTY branch can't fire even by accident
      // — every prompt path must short-circuit on --yes.
      BATONQ_TEST: "1",
    },
    encoding: "utf8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("batonq init", () => {
  test("fake-HOME with no settings.json installs hooks", () => {
    const home = mkdtempSync(join(tmpdir(), "batonq-init-fresh-"));
    try {
      const settingsPath = join(home, ".claude", "settings.json");
      expect(existsSync(settingsPath)).toBe(false);

      const r = runInit(home);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("hooks installed");
      expect(r.stdout).toContain("example task added");

      // settings.json now exists and contains all three hook matchers
      // pointing at a batonq-hook (or legacy agent-coord-hook) command.
      expect(existsSync(settingsPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));

      const cmds = (event: string): string[] =>
        (cfg.hooks?.[event] ?? []).flatMap((b: any) =>
          (b.hooks ?? []).map((h: any) => h.command),
        );
      const pre = cmds("PreToolUse");
      const post = cmds("PostToolUse");

      // Each matcher must be present, with the right subcommand suffix.
      expect(
        pre.some(
          (c: string) =>
            /batonq-hook|agent-coord-hook/.test(c) && / pre$/.test(c),
        ),
      ).toBe(true);
      expect(
        pre.some(
          (c: string) =>
            /batonq-hook|agent-coord-hook/.test(c) && / bash$/.test(c),
        ),
      ).toBe(true);
      expect(
        post.some(
          (c: string) =>
            /batonq-hook|agent-coord-hook/.test(c) && / post$/.test(c),
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("re-running with hooks already present is a no-op on settings.json", () => {
    const home = mkdtempSync(join(tmpdir(), "batonq-init-noop-"));
    try {
      // Seed a settings.json that already carries the three batonq hook
      // entries plus a foreign block we don't own. The foreign block is
      // here to assert we don't rewrite anything outside the batonq scope
      // (any byte-level diff would imply we re-serialised the file).
      mkdirSync(join(home, ".claude"), { recursive: true });
      const seeded = {
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Read|Edit|Write|MultiEdit",
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/batonq-hook pre",
                  timeout: 2,
                },
              ],
            },
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/batonq-hook bash",
                  timeout: 2,
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Edit|Write|MultiEdit",
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/batonq-hook post",
                  timeout: 2,
                },
              ],
            },
          ],
        },
      };
      const settingsPath = join(home, ".claude", "settings.json");
      const seededText = JSON.stringify(seeded, null, 2) + "\n";
      writeFileSync(settingsPath, seededText);
      const seededBytes = readFileSync(settingsPath);

      const r = runInit(home);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("hooks already configured");
      // Critical: settings.json bytes must be byte-for-byte unchanged.
      const afterBytes = readFileSync(settingsPath);
      expect(afterBytes.equals(seededBytes)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
