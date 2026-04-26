// agent-runners/role-skills.ts — per-role SKILL.md loader.
//
// Each agent role (worker, judge, pr-runner, explorer, reviewer) has a
// canonical SKILL.md at https://github.com/Salberg87/batonq-skills. Runners
// inject it via the host CLI's native system-prompt mechanism (Claude:
// --append-system-prompt-file; codex/gemini/opencode: prepend separator on
// the user prompt — none of them expose a system flag for headless one-shot
// runs that doesn't require mutating per-cwd config).
//
// Cache strategy: `~/.batonq/skills/<role>/SKILL.md`, fetched once on first
// use via curl, kept forever. The repo is small (<5 KB per skill) and rarely
// changes; cache invalidation is opt-in via `BATONQ_SKILLS_REFRESH=1`.
//
// Synchronous on purpose: the runners use spawnSync, so the loader has to be
// callable from inside `run()` without restructuring the interface to async.
// Default fetcher shells out to curl via execSync; tests inject a synthetic
// fetcher to avoid network.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const AGENT_ROLES = [
  "worker",
  "judge",
  "pr-runner",
  "explorer",
  "reviewer",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(s: string): s is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(s);
}

/** Default cache root. Tests override via deps.cacheDir. */
export function defaultSkillCacheDir(): string {
  return `${homedir()}/.batonq/skills`;
}

/** Canonical raw URL on the public skills repo. */
export function skillUrl(role: AgentRole): string {
  return `https://raw.githubusercontent.com/Salberg87/batonq-skills/main/skills/batonq-${role}/SKILL.md`;
}

/** Cached file path for a given role + cache root. */
export function skillCachePath(role: AgentRole, cacheDir: string): string {
  return `${cacheDir}/${role}/SKILL.md`;
}

export interface SkillLoaderDeps {
  /** Cache root. Default `~/.batonq/skills`. */
  cacheDir?: string;
  /** Synchronous fetcher. Default uses curl via execSync. */
  fetcher?: (url: string) => string;
  /**
   * Force re-fetch even if cached. When omitted, falls back to the
   * `BATONQ_SKILLS_REFRESH=1` env var so callers can bust the cache without
   * touching code.
   */
  refresh?: boolean;
}

export interface LoadedSkill {
  role: AgentRole;
  path: string;
  content: string;
  /** True when this call hit the network (not the cache). */
  fetched: boolean;
}

/**
 * Load a role's SKILL.md from cache, fetching on first use. Returns the
 * cached file path (suitable for `--append-system-prompt-file`) and the
 * content (suitable for prompt-prepending in tools that lack a system flag).
 *
 * Returns `null` and logs a warning to stderr when the fetch fails on a
 * cold cache. We deliberately do NOT throw: the loop is the only realistic
 * caller, and crashing it because a single SKILL.md couldn't be fetched is
 * worse than running the agent without the role hint. Once the file is
 * cached locally further runs are offline-safe.
 *
 * If a cached copy exists and `refresh` is on, a refresh-fetch failure
 * keeps the existing cache rather than wiping it — same reasoning. Stale
 * skill > no skill > crashed loop.
 */
export function loadRoleSkill(
  role: AgentRole,
  deps: SkillLoaderDeps = {},
): LoadedSkill | null {
  const cacheDir = deps.cacheDir ?? defaultSkillCacheDir();
  const refresh = deps.refresh ?? process.env.BATONQ_SKILLS_REFRESH === "1";
  const path = skillCachePath(role, cacheDir);
  const haveCache = existsSync(path);

  if (!refresh && haveCache) {
    return { role, path, content: readFileSync(path, "utf8"), fetched: false };
  }

  const url = skillUrl(role);
  const fetcher = deps.fetcher ?? defaultFetcher;
  let content: string;
  try {
    content = fetcher(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[batonq] warn: could not fetch SKILL.md for role '${role}' (${msg}); ` +
        (haveCache
          ? `keeping cached copy at ${path}\n`
          : `running without role skill\n`),
    );
    if (haveCache) {
      return {
        role,
        path,
        content: readFileSync(path, "utf8"),
        fetched: false,
      };
    }
    return null;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { role, path, content, fetched: true };
}

/**
 * Default fetcher: curl with -fsSL so HTTP errors raise instead of writing
 * an HTML error body to the cache. 30s timeout — the file is tiny; anything
 * slower indicates a real network problem we shouldn't paper over.
 */
function defaultFetcher(url: string): string {
  return execSync(`curl -fsSL --max-time 30 ${quote(url)}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Shell-quote a single argument. URLs don't normally contain quotes; this
 * is belt-and-braces against future role-name expansions. */
function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
