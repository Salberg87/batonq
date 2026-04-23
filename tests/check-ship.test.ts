// check-ship.test — guards scripts/check-ship.sh and the
// `batonq ship-status` subcommand that wraps it.
//
// The script is the single source of truth for ship-readiness: each row in
// docs/ship-criteria.md is a shell assertion, and the script must parse the
// file, run each assert, and report PASS/FAIL + a summary. These tests
// exercise the parser with a mock criteria file (so the real ship-criteria
// state can't make them flaky) and smoke-test the CLI wrapper to make sure
// `batonq ship-status` actually reaches the script.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = resolve(REPO_ROOT, "scripts", "check-ship.sh");
const BATONQ_BIN = resolve(REPO_ROOT, "bin", "batonq");

describe("scripts/check-ship.sh", () => {
  test("parses a mock criteria file and reports expected pass/fail counts", () => {
    const workdir = mkdtempSync(join(tmpdir(), "batonq-ship-"));
    try {
      // A mock criteria file with deterministic outcomes: two passing
      // asserts (`true` and an existing file check), two failing asserts
      // (`false` and a non-existent file), plus surrounding markdown prose
      // and a commented-out placeholder that must be ignored.
      const criteria = [
        "# Ship criteria (mock)",
        "",
        "Some prose that must be ignored.",
        "",
        "```",
        "SHIP-<id> | <placeholder> | echo ignored",
        "```",
        "",
        "# SHIP-999 | commented out criterion | false",
        "",
        "SHIP-A01 | trivially passing check | true",
        "SHIP-A02 | trivially failing check | false",
        "SHIP-A03 | repo dir exists | test -d .",
        "SHIP-A04 | nonexistent file missing | test -f /definitely/not/a/real/path/zzz",
        "",
      ].join("\n");
      const criteriaPath = join(workdir, "criteria.md");
      writeFileSync(criteriaPath, criteria);

      const res = spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          SHIP_CRITERIA_FILE: criteriaPath,
          SHIP_CHECK_TIMEOUT: "30",
        },
        encoding: "utf8",
        cwd: REPO_ROOT,
      });

      // Report mode: always exits 0 regardless of criterion outcomes.
      expect(res.status).toBe(0);

      const out = res.stdout;
      expect(out).toContain("PASS  SHIP-A01  trivially passing check");
      expect(out).toContain("FAIL  SHIP-A02  trivially failing check");
      expect(out).toContain("PASS  SHIP-A03  repo dir exists");
      expect(out).toContain("FAIL  SHIP-A04  nonexistent file missing");

      // The <placeholder> row from the prose block and the commented
      // `SHIP-999` line must not surface as criteria.
      expect(out).not.toContain("SHIP-<id>");
      expect(out).not.toContain("SHIP-999");

      // Summary line: 2/4 passing with A02 and A04 as blockers. The
      // ordering in the blocker list mirrors the criteria file order.
      expect(out).toMatch(
        /2\/4 criteria passing\. Blockers: SHIP-A02, SHIP-A04/,
      );
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("missing criteria file is a soft failure (exit 0, no crash)", () => {
    const res = spawnSync("sh", [SCRIPT], {
      env: {
        ...process.env,
        SHIP_CRITERIA_FILE: "/tmp/definitely-not-a-real-criteria-file-xyz.md",
      },
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    // Report-mode contract: even an operator error (bad path) shouldn't
    // break an automation pipeline that scrapes the output.
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("criteria file not found");
  });
});

describe("batonq ship-status", () => {
  test("wrapper exits 0 and prints criteria-passing summary", () => {
    // Confidence check: the CLI wrapper resolves scripts/check-ship.sh
    // correctly and surfaces its stdout + summary line. We point at a
    // tiny fixture criteria file so this test doesn't re-run the full
    // real ship-suite (which itself runs `bun test`, causing runaway
    // recursion + timeouts when invoked from inside `bun test`).
    const workdir = mkdtempSync(join(tmpdir(), "batonq-ship-wrap-"));
    try {
      const criteriaPath = join(workdir, "mini.md");
      writeFileSync(
        criteriaPath,
        [
          "SHIP-M01 | always passes | true",
          "SHIP-M02 | always fails | false",
          "",
        ].join("\n"),
      );
      const res = spawnSync(BATONQ_BIN, ["ship-status"], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          SHIP_CRITERIA_FILE: criteriaPath,
          SHIP_CHECK_TIMEOUT: "10",
        },
        timeout: 20_000,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("criteria passing");
      expect(res.stdout).toContain("PASS  SHIP-M01");
      expect(res.stdout).toContain("FAIL  SHIP-M02");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
