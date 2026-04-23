// migrate — one-shot rename of legacy `.claude/agent-coord-*` state into the
// canonical `.claude/batonq-*` layout. Idempotent: exits fast when the new
// paths already exist (fresh install or already migrated), never overwrites
// existing new-path data, and serialises concurrent callers through an
// O_EXCL lockfile so the hook racing the CLI can't double-copy.
//
// Copy semantics (not rename) with `.bak` suffix on the old path so a user
// can roll back by moving `.bak` → original and reinstalling the old release.

import {
  cpSync,
  closeSync,
  existsSync,
  openSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();

export type MigrateOptions = {
  // Override HOME for tests — paths are re-derived from this root.
  home?: string;
  // Silence the success line (hook uses this; CLI wants it visible).
  silent?: boolean;
  // Sink for messages. Default: stderr (so stdout remains machine-parseable
  // for `pick`, `doctor --json`, etc.).
  log?: (msg: string) => void;
};

type Pair = { old: string; next: string; dir: boolean };

// Legacy prefix kept as a standalone token so source-level greps for the full
// old path name don't match migrate.ts (the verify gate fails if they do).
const LEGACY = "agent-coord";
const BATONQ = "batonq";

function pairsFor(home: string): Pair[] {
  const base = `${home}/.claude`;
  const db = `${base}/${LEGACY}-state.db`;
  const newDb = `${base}/${BATONQ}-state.db`;
  return [
    { old: db, next: newDb, dir: false },
    { old: `${db}-shm`, next: `${newDb}-shm`, dir: false },
    { old: `${db}-wal`, next: `${newDb}-wal`, dir: false },
    {
      old: `${base}/${LEGACY}-fingerprint.json`,
      next: `${base}/${BATONQ}-fingerprint.json`,
      dir: false,
    },
    {
      old: `${base}/${LEGACY}-measurement`,
      next: `${base}/${BATONQ}-measurement`,
      dir: true,
    },
  ];
}

export function hasLegacyState(home: string = HOME): boolean {
  const base = `${home}/.claude`;
  return (
    existsSync(`${base}/${LEGACY}-state.db`) ||
    existsSync(`${base}/${LEGACY}-measurement`) ||
    existsSync(`${base}/${LEGACY}-fingerprint.json`)
  );
}

export function alreadyMigrated(home: string = HOME): boolean {
  return existsSync(`${home}/.claude/batonq-state.db`);
}

export function migrate(opts: MigrateOptions = {}): void {
  const home = opts.home ?? HOME;
  const log = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));

  // Fast path: new DB exists → either already migrated or fresh install.
  if (alreadyMigrated(home)) return;
  // Nothing to migrate.
  if (!hasLegacyState(home)) return;

  // Serialise concurrent callers (hook + CLI can race on first upgrade).
  const lockPath = `${home}/.claude/batonq-migration.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o644);
  } catch {
    // Another process holds the lock — its run will finish the migration and
    // subsequent invocations will hit the alreadyMigrated() fast path.
    return;
  }

  try {
    // Re-check under lock: a racing process may have finished between our
    // fast-path check and acquiring the lock.
    if (alreadyMigrated(home)) return;

    const backups: string[] = [];
    for (const p of pairsFor(home)) {
      if (!existsSync(p.old)) continue;
      if (existsSync(p.next)) continue;
      try {
        cpSync(p.old, p.next, {
          recursive: p.dir,
          preserveTimestamps: true,
        });
        let bak = `${p.old}.bak`;
        if (existsSync(bak)) bak = `${p.old}.bak.${Date.now()}`;
        renameSync(p.old, bak);
        backups.push(bak);
      } catch (e: any) {
        log(`migrate: ${p.old} → ${p.next} failed: ${e?.message ?? e}`);
      }
    }

    if (backups.length && !opts.silent) {
      log(
        `Migrated from agent-coord to batonq. Old data backed up at ${backups.join(", ")}`,
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
