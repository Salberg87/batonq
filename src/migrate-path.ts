// migrate-path — one-shot migration of the state DB to the canonical
// directory-based path (`~/.claude/batonq/state.db`).
//
// Why this exists: the earlier rename migration (src/migrate.ts) moved
// `agent-coord-state.db` → `batonq-state.db` at the src level, but the
// installed `~/bin/agent-coord` binary on upgraded machines kept writing to
// the old flat path, leaving three DB files (`agent-coord-state.db`,
// `batonq-state.db`, `batonq.db`) in `~/.claude/`. This migration unifies all
// legacy sources into one canonical path.
//
// Semantics:
//   - Target: `${HOME}/.claude/batonq/state.db` (directory-based so future
//     files like archive.db / snapshots/ can live alongside).
//   - Sources: `${HOME}/.claude/agent-coord-state.db`,
//              `${HOME}/.claude/batonq-state.db`
//   - On first run (target absent + at least one non-empty source): copy the
//     NEWEST non-empty source to the target, then rename ALL legacy sources
//     (and their -shm / -wal siblings) to `*.legacy.bak`.
//   - On second run (target present): no-op, returns silently.
//   - Fresh install (target absent + no sources): no-op, leaves the target
//     uncreated so the hook's lazy-create signal still works.
//   - Concurrent callers (hook racing CLI at startup): serialised via an
//     O_EXCL lockfile — only one process migrates; the other hits the fast
//     path on the next call.

import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();

export type MigratePathOptions = {
  home?: string;
  silent?: boolean;
  log?: (msg: string) => void;
};

export function canonicalDbPath(home: string = HOME): string {
  return `${home}/.claude/batonq/state.db`;
}

export function canonicalDbDir(home: string = HOME): string {
  return `${home}/.claude/batonq`;
}

export function legacySources(home: string = HOME): string[] {
  return [
    `${home}/.claude/agent-coord-state.db`,
    `${home}/.claude/batonq-state.db`,
  ];
}

export function alreadyMigratedPath(home: string = HOME): boolean {
  return existsSync(canonicalDbPath(home));
}

// Returns the newest non-empty legacy DB path, or null if none qualify.
export function newestNonEmptyLegacy(home: string = HOME): string | null {
  type C = { path: string; mtime: number };
  let best: C | null = null;
  for (const path of legacySources(home)) {
    if (!existsSync(path)) continue;
    let mtime = 0;
    let size = 0;
    try {
      const st = statSync(path);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    if (size === 0) continue;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best ? best.path : null;
}

export function migratePath(opts: MigratePathOptions = {}): void {
  const home = opts.home ?? HOME;
  const log = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));

  if (alreadyMigratedPath(home)) return;

  const source = newestNonEmptyLegacy(home);
  if (!source) return; // fresh install, nothing to do

  const target = canonicalDbPath(home);
  const targetDir = canonicalDbDir(home);
  const lockPath = `${home}/.claude/batonq-migrate-path.lock`;

  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o644);
  } catch {
    return; // another process is already migrating
  }

  try {
    // Re-check under lock: a racing process may have finished between our
    // fast-path check and acquiring the lock.
    if (alreadyMigratedPath(home)) return;

    mkdirSync(targetDir, { recursive: true });

    cpSync(source, target, { preserveTimestamps: true });
    for (const suffix of ["-shm", "-wal"]) {
      const sib = `${source}${suffix}`;
      if (existsSync(sib)) {
        cpSync(sib, `${target}${suffix}`, { preserveTimestamps: true });
      }
    }

    // Back up ALL legacy sources (even the one we didn't pick) so a stale
    // old-binary write can't later fork state by appending to the loser.
    const backups: string[] = [];
    for (const base of legacySources(home)) {
      for (const suffix of ["", "-shm", "-wal"]) {
        const path = `${base}${suffix}`;
        if (!existsSync(path)) continue;
        let bak = `${path}.legacy.bak`;
        if (existsSync(bak)) bak = `${path}.legacy.bak.${Date.now()}`;
        try {
          renameSync(path, bak);
          backups.push(bak);
        } catch (e: any) {
          log(`migrate-path: could not back up ${path}: ${e?.message ?? e}`);
        }
      }
    }

    if (!opts.silent) {
      log(
        `Migrated DB to ${target} (from ${source}). Legacy sources backed up at ${backups.join(", ")}`,
      );
    }
  } finally {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}
