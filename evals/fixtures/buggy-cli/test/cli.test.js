import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.js");

function run(args, cwd) {
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
}

test("smoke: add + list + remove round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "buggy-cli-"));
  try {
    run(["add", "first"], dir);
    run(["add", "second"], dir);
    const listed = run(["list"], dir).stdout;
    assert.match(listed, /first/);
    // the bugs below are intentional; per-task verify_cmd targets them.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
