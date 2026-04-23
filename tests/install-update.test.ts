// install-update — end-to-end: install.sh must always overwrite existing
// binaries AND install a legacy `agent-coord` alias. The original bug this
// guards against: the rename from agent-coord → batonq left every upgraded
// machine with a stale `~/bin/agent-coord` that still wrote to the legacy
// DB path. Clone-pipe install must fix that on the next run.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SH = join(REPO_ROOT, "install.sh");

describe("install.sh (update path)", () => {
  test("overwrites an existing stale ~/bin/agent-coord and installs ~/bin/batonq", () => {
    const home = mkdtempSync(join(tmpdir(), "batonq-install-update-"));
    try {
      const bindir = join(home, "bin");
      mkdirSync(bindir, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });

      // Seed a stale agent-coord binary with a recognisable marker. The
      // real-world equivalent is an old pre-rename binary that still writes
      // to the legacy DB path.
      const stale = join(bindir, "agent-coord");
      writeFileSync(stale, "#!/bin/sh\necho STALE-MARKER\n");
      chmodSync(stale, 0o755);

      // Stub the install.sh dependencies we can't easily provide in CI:
      // the `git clone` step normally fetches from GitHub; we short-circuit
      // by running a patched install.sh that skips the clone and points
      // directly at the repo we're already in.
      const patched = readFileSync(INSTALL_SH, "utf8")
        .replace(
          /clone_repo\(\) \{[\s\S]*?\n\}\n/,
          `clone_repo() { TMP_DIR="${REPO_ROOT}"; ok "Using local repo $TMP_DIR"; }\n`,
        )
        // Strip check_bun / check_gtimeout / jq-required / git-required so
        // the test doesn't depend on the host's tool inventory. They're
        // exercised by install.sh itself in regular use.
        .replace(/check_bun\n/, ": # check_bun skipped\n")
        .replace(/check_timeout_cmd\n/, ": # check_timeout_cmd skipped\n")
        .replace(
          /command -v git >\/dev\/null 2>&1 \|\| fail "git is required but not installed\."\n/,
          ": # git check skipped\n",
        )
        .replace(
          /merge_settings  "\$\{bindir\}"\n/,
          ": # merge_settings skipped\n",
        )
        // The bindir auto-detection keys off PATH; force it to our tmp bin.
        .replace(
          /detect_bindir\(\) \{[\s\S]*?return 1\n\}\n/,
          `detect_bindir() { echo "${bindir}"; }\n`,
        );

      const patchedPath = join(home, "install-patched.sh");
      writeFileSync(patchedPath, patched);
      chmodSync(patchedPath, 0o755);

      const r = spawnSync("sh", [patchedPath], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bindir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      });

      expect(r.status).toBe(0);

      // batonq is installed fresh.
      const batonqPath = join(bindir, "batonq");
      expect(existsSync(batonqPath)).toBe(true);
      expect(statSync(batonqPath).mode & 0o111).toBeGreaterThan(0);

      // agent-coord was OVERWRITTEN — not left as the stale stub.
      expect(existsSync(stale)).toBe(true);
      const afterBody = readFileSync(stale, "utf8");
      expect(afterBody).not.toContain("STALE-MARKER");
      // Both files are byte-identical — the install writes the same
      // src/agent-coord under both names.
      expect(readFileSync(batonqPath, "utf8")).toBe(afterBody);

      // Hook alias also installed.
      expect(existsSync(join(bindir, "agent-coord-hook"))).toBe(true);
      expect(existsSync(join(bindir, "batonq-hook"))).toBe(true);

      // Canonical state dir created as part of post-install.
      expect(existsSync(join(home, ".claude", "batonq"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("verify_db_paths warns loudly when a legacy DB is still present", () => {
    // Isolate verify_db_paths behaviour: source-only, no cloning. We eval
    // the function and check its exit banner against the warn pattern.
    const home = mkdtempSync(join(tmpdir(), "batonq-verify-db-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const legacy = join(home, ".claude", "agent-coord-state.db");
      writeFileSync(legacy, "LEGACY");

      // Extract the verify_db_paths function and the constants it closes over
      // from install.sh so this test stays honest: if verify_db_paths ever
      // drifts from the install script, we fail loudly instead of silently
      // asserting against a stale copy. Using dotall-ish [\s\S] because the
      // function body spans newlines.
      const installSh = readFileSync(INSTALL_SH, "utf8");
      const constsMatch = installSh.match(
        /CLAUDE_DIR=[\s\S]*?LEGACY_DBS=[^\n]*/,
      );
      const fnMatch = installSh.match(/verify_db_paths\(\) \{[\s\S]*?\n\}/);
      const warnMatch = installSh.match(/warn\(\)[^\n]*\n/);
      const okMatch = installSh.match(/ok\(\)[^\n]*\n/);
      expect(constsMatch).not.toBeNull();
      expect(fnMatch).not.toBeNull();
      expect(warnMatch).not.toBeNull();
      expect(okMatch).not.toBeNull();
      const script = `#!/bin/sh
set -eu
HOME="${home}"
NAME="batonq"
${warnMatch![0]}${okMatch![0]}
${constsMatch![0]}
${fnMatch![0]}
verify_db_paths
`;
      const scriptPath = join(home, "verify.sh");
      writeFileSync(scriptPath, script);
      chmodSync(scriptPath, 0o755);

      const r = spawnSync("sh", [scriptPath], {
        env: { ...process.env, HOME: home, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });

      expect(r.status).toBe(0);
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      expect(out).toMatch(/Legacy DB present/);
      expect(out).toMatch(/agent-coord-state\.db/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
