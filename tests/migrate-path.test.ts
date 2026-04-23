// migrate-path — exercises the legacy-DB unification migration.
//
// Covers every entry point into migratePath(): each legacy source in
// isolation, the newest-wins tie-break when both exist, and the no-op
// branches (fresh install, already-migrated, target already present).

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalDbPath,
  migratePath,
  newestNonEmptyLegacy,
} from "../src/migrate-path";

function setup(): { home: string; claude: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "batonq-migrate-path-"));
  const claude = join(home, ".claude");
  mkdirSync(claude, { recursive: true });
  return {
    home,
    claude,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe("migratePath", () => {
  test("migrates from legacy agent-coord-state.db when that is the only source", () => {
    const { home, claude, cleanup } = setup();
    try {
      const legacy = join(claude, "agent-coord-state.db");
      writeFileSync(legacy, "LEGACY-AGENT-COORD-PAYLOAD");

      const logs: string[] = [];
      migratePath({ home, log: (m) => logs.push(m) });

      expect(readFileSync(canonicalDbPath(home), "utf8")).toBe(
        "LEGACY-AGENT-COORD-PAYLOAD",
      );
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(`${legacy}.legacy.bak`)).toBe(true);
      expect(logs.some((l) => l.startsWith("Migrated DB to"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("migrates from intermediate batonq-state.db when that is the only source", () => {
    const { home, claude, cleanup } = setup();
    try {
      const legacy = join(claude, "batonq-state.db");
      writeFileSync(legacy, "INTERMEDIATE-BATONQ-STATE");

      migratePath({ home, silent: true });

      expect(readFileSync(canonicalDbPath(home), "utf8")).toBe(
        "INTERMEDIATE-BATONQ-STATE",
      );
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(`${legacy}.legacy.bak`)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("picks the newest non-empty source when both legacy files exist", () => {
    const { home, claude, cleanup } = setup();
    try {
      const older = join(claude, "batonq-state.db");
      const newer = join(claude, "agent-coord-state.db");
      writeFileSync(older, "OLDER-INTERMEDIATE");
      writeFileSync(newer, "NEWER-AGENT-COORD");
      // Force older's mtime to be genuinely older so the heuristic has
      // something to compare.
      const past = new Date(Date.now() - 60_000);
      utimesSync(older, past, past);

      expect(newestNonEmptyLegacy(home)).toBe(newer);
      migratePath({ home, silent: true });

      expect(readFileSync(canonicalDbPath(home), "utf8")).toBe(
        "NEWER-AGENT-COORD",
      );
      // Both legacy paths get backed up — the loser is still stale from the
      // perspective of any old binary still on PATH.
      expect(existsSync(`${older}.legacy.bak`)).toBe(true);
      expect(existsSync(`${newer}.legacy.bak`)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("is idempotent: second run is a silent no-op on the already-migrated layout", () => {
    const { home, claude, cleanup } = setup();
    try {
      writeFileSync(join(claude, "agent-coord-state.db"), "payload");

      const firstLogs: string[] = [];
      migratePath({ home, log: (m) => firstLogs.push(m) });
      expect(firstLogs.some((l) => l.startsWith("Migrated DB to"))).toBe(true);

      // Mutate the migrated file to prove the second run doesn't re-copy.
      writeFileSync(canonicalDbPath(home), "POST-MIGRATION-WRITE");

      const secondLogs: string[] = [];
      migratePath({ home, log: (m) => secondLogs.push(m) });

      expect(secondLogs.length).toBe(0);
      expect(readFileSync(canonicalDbPath(home), "utf8")).toBe(
        "POST-MIGRATION-WRITE",
      );
    } finally {
      cleanup();
    }
  });

  test("no-op when canonical target already exists (even with legacy present)", () => {
    const { home, claude, cleanup } = setup();
    try {
      // User did a fresh install: canonical target already populated.
      mkdirSync(join(claude, "batonq"), { recursive: true });
      writeFileSync(canonicalDbPath(home), "FRESH-CANONICAL");
      // But a legacy DB is still sitting around from an older install.
      const legacy = join(claude, "agent-coord-state.db");
      writeFileSync(legacy, "SHOULD-NOT-BE-COPIED");

      const logs: string[] = [];
      migratePath({ home, log: (m) => logs.push(m) });

      expect(logs.length).toBe(0);
      expect(readFileSync(canonicalDbPath(home), "utf8")).toBe(
        "FRESH-CANONICAL",
      );
      expect(existsSync(legacy)).toBe(true);
      expect(existsSync(`${legacy}.legacy.bak`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("fresh install (no legacy, no target) does nothing and creates no files", () => {
    const { home, claude, cleanup } = setup();
    try {
      const logs: string[] = [];
      migratePath({ home, log: (m) => logs.push(m) });

      expect(logs.length).toBe(0);
      expect(existsSync(canonicalDbPath(home))).toBe(false);
      expect(existsSync(join(claude, "batonq"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("ignores zero-byte legacy files (the batonq.db stub from an aborted upgrade)", () => {
    const { home, claude, cleanup } = setup();
    try {
      // agent-coord-state.db is non-empty (the real data),
      // batonq-state.db is a zero-byte artefact — must not be chosen.
      writeFileSync(join(claude, "agent-coord-state.db"), "REAL-DATA");
      writeFileSync(join(claude, "batonq-state.db"), "");

      migratePath({ home, silent: true });

      expect(readFileSync(canonicalDbPath(home), "utf8")).toBe("REAL-DATA");
    } finally {
      cleanup();
    }
  });

  test("copies -shm and -wal siblings alongside the main DB", () => {
    const { home, claude, cleanup } = setup();
    try {
      const legacy = join(claude, "agent-coord-state.db");
      writeFileSync(legacy, "MAIN");
      writeFileSync(`${legacy}-shm`, "SHARED-MEMORY");
      writeFileSync(`${legacy}-wal`, "WRITE-AHEAD-LOG");

      migratePath({ home, silent: true });

      const target = canonicalDbPath(home);
      expect(readFileSync(target, "utf8")).toBe("MAIN");
      expect(readFileSync(`${target}-shm`, "utf8")).toBe("SHARED-MEMORY");
      expect(readFileSync(`${target}-wal`, "utf8")).toBe("WRITE-AHEAD-LOG");
    } finally {
      cleanup();
    }
  });
});
