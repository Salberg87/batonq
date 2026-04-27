// pre-die-hook.test — drives the agent-coord-pre-die-hook bash script
// against real git fixtures to confirm Phase 1 of the auto-commit-before-die
// design (Track D §4). The hook is the back door for the failure mode that
// motivated this work: a dispatched runner dies with uncommitted edits and
// no `batonq done` call, leaving orphaned work on the active branch.
//
// What gets asserted:
//   1. Clean tree → hook is a no-op (no branch created)
//   2. Dirty tree (modified file) → wip branch created, active branch clean
//   3. Untracked files → also preserved
//   4. Sequential failures bump the attempt number (wip/<eid>/1, /2, ...)
//   5. Detached HEAD short-circuits cleanly
//   6. Non-git cwd short-circuits cleanly
//   7. BATONQ_PRE_DIE_DISABLE=1 short-circuits without touching anything
//
// Tests do NOT exercise the `batonq abandon` integration because that
// requires a live state.db; the hook fast-exits with a logged warning when
// abandon fails, so verifying the git-side preservation is sufficient.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_BIN = join(import.meta.dir, "..", "src", "agent-coord-pre-die-hook");

// realpathSync resolves macOS /var/folders → /private/var/folders so git's
// resolved toplevel matches the cwd we hand the hook.
function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pre-die-")));
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "initial\n");
  run(["add", "."]);
  run(["commit", "-qm", "initial"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runHook(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(HOOK_BIN, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function gitBranches(cwd: string): string[] {
  const r = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    { cwd, encoding: "utf8" },
  );
  return (r.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function gitDirty(cwd: string): boolean {
  const tracked = spawnSync("git", ["diff-index", "--quiet", "HEAD"], { cwd });
  if (tracked.status !== 0) return true;
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd, encoding: "utf8" },
  );
  return ((untracked.stdout ?? "") as string).trim().length > 0;
}

describe("pre-die-hook", () => {
  test("clean tree → no branch created, no error", () => {
    const repo = makeRepo();
    try {
      const r = runHook(repo.dir, ["abc12345", "0", "claude", "sonnet"]);
      expect(r.status).toBe(0);
      const branches = gitBranches(repo.dir);
      expect(branches.some((b) => b.startsWith("batonq/wip/"))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("modified tracked file → preserved to wip branch, active branch clean", () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo.dir, "README.md"), "agent edit\n");
      expect(gitDirty(repo.dir)).toBe(true);

      const r = runHook(repo.dir, ["abc12345", "124", "claude", "sonnet"]);
      expect(r.status).toBe(0);
      // Stderr carries the hook's diagnostic output
      expect(r.stderr).toMatch(/preserving work for abc12345/);

      // Active branch (master) should be clean again
      expect(gitDirty(repo.dir)).toBe(false);

      // Wip branch should exist and contain the change
      const branches = gitBranches(repo.dir);
      expect(branches).toContain("batonq/wip/abc12345/1");

      // Show the wip commit's message + diff stat
      const log = spawnSync(
        "git",
        ["log", "--oneline", "batonq/wip/abc12345/1", "-1"],
        { cwd: repo.dir, encoding: "utf8" },
      );
      expect(log.stdout).toMatch(/wip\(batonq\):/);
      expect(log.stdout).toMatch(/claude\/sonnet/);
      expect(log.stdout).toMatch(/attempt 1/);
      expect(log.stdout).toMatch(/exit 124/);
    } finally {
      repo.cleanup();
    }
  });

  test("untracked file → preserved (git add -A captures it)", () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo.dir, "new.ts"), "// agent wrote this\n");
      runHook(repo.dir, ["abc12345", "1", "codex", "default"]);

      const show = spawnSync(
        "git",
        ["show", "--stat", "batonq/wip/abc12345/1"],
        { cwd: repo.dir, encoding: "utf8" },
      );
      expect(show.stdout).toMatch(/new\.ts/);
    } finally {
      repo.cleanup();
    }
  });

  test("sequential dirty exits → attempt number increments", () => {
    const repo = makeRepo();
    try {
      // Attempt 1
      writeFileSync(join(repo.dir, "README.md"), "edit 1\n");
      runHook(repo.dir, ["abc12345", "124", "claude", "sonnet"]);
      // Attempt 2 (master clean again, simulate another dirty run)
      writeFileSync(join(repo.dir, "README.md"), "edit 2\n");
      runHook(repo.dir, ["abc12345", "124", "claude", "sonnet"]);

      const branches = gitBranches(repo.dir);
      expect(branches).toContain("batonq/wip/abc12345/1");
      expect(branches).toContain("batonq/wip/abc12345/2");
    } finally {
      repo.cleanup();
    }
  });

  test("detached HEAD → short-circuits without modifying state", () => {
    const repo = makeRepo();
    try {
      // Detach HEAD by checking out the commit sha directly
      const sha = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        encoding: "utf8",
      }).stdout!.trim();
      spawnSync("git", ["checkout", "--detach", sha], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      writeFileSync(join(repo.dir, "README.md"), "edit on detached\n");

      const r = runHook(repo.dir, ["abc12345", "124", "claude", "sonnet"]);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/detached HEAD/);

      const branches = gitBranches(repo.dir);
      expect(branches.some((b) => b.startsWith("batonq/wip/"))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("non-git cwd → short-circuits without error", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pre-die-nogit-")));
    try {
      writeFileSync(join(tmp, "stray.txt"), "no repo\n");
      const r = runHook(tmp, ["abc12345", "0", "claude", "sonnet"]);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/not inside a git repo/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("BATONQ_PRE_DIE_DISABLE=1 → short-circuits even with dirty tree", () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo.dir, "README.md"), "agent edit\n");
      const r = runHook(repo.dir, ["abc12345", "124", "claude", "sonnet"], {
        BATONQ_PRE_DIE_DISABLE: "1",
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/BATONQ_PRE_DIE_DISABLE=1/);
      // Tree should still be dirty — disable means really disable
      expect(gitDirty(repo.dir)).toBe(true);
      const branches = gitBranches(repo.dir);
      expect(branches.some((b) => b.startsWith("batonq/wip/"))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("missing eid → short-circuits cleanly", () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo.dir, "README.md"), "agent edit\n");
      const r = runHook(repo.dir, []);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/missing eid/);
      // Tree still dirty — no preservation without an eid
      expect(gitDirty(repo.dir)).toBe(true);
    } finally {
      repo.cleanup();
    }
  });
});

describe("pre-die-hook integration with agent-coord-loop", () => {
  test("loop script references the pre-die-hook binary", () => {
    const loop = join(import.meta.dir, "..", "src", "agent-coord-loop");
    expect(existsSync(loop)).toBe(true);
    const content = require("node:fs").readFileSync(loop, "utf8");
    // The loop must look up the hook (installed name OR legacy name OR
    // sibling fallback) and pass eid + exit code + agent + model.
    expect(content).toMatch(/batonq-pre-die-hook|agent-coord-pre-die-hook/);
    expect(content).toMatch(/PRE_DIE_HOOK.*EID.*DISPATCH_EXIT/s);
  });

  test("loop captures DISPATCH_EXIT instead of swallowing with `|| true`", () => {
    const loop = join(import.meta.dir, "..", "src", "agent-coord-loop");
    const content = require("node:fs").readFileSync(loop, "utf8");
    // The pre-die hook needs the dispatch's exit code to log meaningfully —
    // gtimeout returns 124 specifically for timeout, which is the failure
    // mode this whole feature exists to address.
    expect(content).toMatch(/DISPATCH_EXIT=\$\?/);
  });

  test("loop extracts external_id from pick output before dispatch", () => {
    const loop = join(import.meta.dir, "..", "src", "agent-coord-loop");
    const content = require("node:fs").readFileSync(loop, "utf8");
    expect(content).toMatch(/EID="\$\(extract_pick_field external_id\)"/);
  });
});
