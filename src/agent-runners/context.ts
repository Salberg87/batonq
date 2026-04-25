// agent-runners/context.ts — context gathering strategies (oxo port).
//
// Background: ~/DEV/oxo/src/core/orchestrator.py defines a `ContextStrategy`
// enum (none|simple|rlm|auto) controlling how the orchestrator builds the
// per-task prompt. We port the same vocabulary so cross-port tooling stays
// comparable, but only `none` and `simple` have real implementations here —
// `rlm` (Recursive Language-Model exploration) is a much bigger lift and
// stays stubbed until we wire up a sub-agent loop for it.
//
// Strategies:
//   - none:   no context gathering, caller passes the body raw.
//   - simple: keyword-extract the body, grep the repo for each keyword, and
//             return a 5-line slice (±2 lines) around each hit. Cheap and
//             deterministic — no LLM round-trip.
//   - rlm:    NOT IMPLEMENTED. Emits a one-line warning to stderr and falls
//             back to `simple`. The fallback (rather than throwing) lets
//             existing tasks keep running while we build out the RLM engine.
//   - auto:   delegate to `detectTaskType`. quick_fix → simple. Anything
//             else → rlm-fallback-simple. Net effect today: every auto task
//             runs `simple`, but the routing intent is recorded in code so
//             flipping the rlm switch later is a one-line change.
//
// Output shape: a markdown-ish string starting with "## Relevant code" and
// "### <file>:<line>" subheadings, each followed by a fenced 5-line slice.
// Returns "" when nothing was found or strategy is "none" — callers should
// only prepend the context block when the result is truthy.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectTaskType } from "./routing";

export const CONTEXT_STRATEGIES = ["none", "simple", "rlm", "auto"] as const;
export type ContextStrategy = (typeof CONTEXT_STRATEGIES)[number];

export const DEFAULT_CONTEXT_STRATEGY: ContextStrategy = "none";

// English + Norwegian stop-words. Kept short — the goal isn't perfect NLP,
// just to keep grep from matching every "the" / "for" in the codebase.
const STOP_WORDS = new Set<string>([
  "the",
  "a",
  "an",
  "is",
  "are",
  "to",
  "for",
  "in",
  "on",
  "and",
  "or",
  "of",
  "with",
  "by",
  "from",
  "at",
  "as",
  "be",
  "this",
  "that",
  "it",
  "if",
  "but",
  "not",
  "no",
  "so",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "will",
  "can",
  "could",
  "should",
  "would",
  "may",
  "might",
  "must",
  "any",
  "all",
  "som",
  "og",
  "eller",
  "i",
  "på",
  "av",
  "til",
  "for",
  "med",
  "den",
  "det",
  "en",
  "et",
  "er",
  "var",
  "har",
  "ikke",
  "fra",
  "skal",
  "kan",
  "vil",
]);

const KEYWORD_LIMIT = 3;
const HITS_PER_KEYWORD = 3;
const CONTEXT_LINES = 2; // ±2 lines around hit = 5-line window

const RLM_WARNING =
  "[context] rlm strategy not implemented yet; falling back to simple\n";

interface GrepHit {
  file: string;
  line: number;
}

function extractKeywords(body: string, max: number): string[] {
  // Identifier-ish tokens: letters/underscore start, then alnum/underscore.
  // Length ≥ 4 to skip noise like "fix" / "the" / "i". Order preserved
  // (earlier mentions tend to be more topical), de-duped lower-case.
  const matches = body.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const w = raw.toLowerCase();
    if (STOP_WORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(raw); // preserve original case for grep
    if (out.length >= max) break;
  }
  return out;
}

function grepKeyword(
  keyword: string,
  repoRoot: string,
  maxResults: number,
): GrepHit[] {
  const r = spawnSync(
    "grep",
    [
      "-rn",
      "-I", // skip binary files
      "--exclude-dir=.git",
      "--exclude-dir=node_modules",
      "--exclude-dir=dist",
      "--exclude-dir=build",
      "--exclude-dir=coverage",
      "--exclude-dir=__pycache__",
      "--",
      keyword,
      ".",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  // grep exits 1 when no matches — that's not an error for us.
  if (!r.stdout) return [];
  const hits: GrepHit[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    // Format: ./path/to/file:LINE:matched content
    const m = line.match(/^\.\/(.+?):(\d+):/);
    if (!m) continue;
    hits.push({ file: m[1], line: Number(m[2]) });
    if (hits.length >= maxResults) break;
  }
  return hits;
}

function readSlice(
  file: string,
  repoRoot: string,
  hitLine: number,
  contextLines: number,
): string {
  const full = resolve(repoRoot, file);
  if (!existsSync(full)) return "";
  let content: string;
  try {
    content = readFileSync(full, "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n");
  const startIdx = Math.max(0, hitLine - 1 - contextLines);
  const endIdx = Math.min(lines.length, hitLine + contextLines);
  const slice = lines.slice(startIdx, endIdx);
  return slice
    .map((text, i) => `${String(startIdx + i + 1).padStart(4, " ")}: ${text}`)
    .join("\n");
}

function gatherSimple(body: string, repoRoot: string): string {
  const keywords = extractKeywords(body, KEYWORD_LIMIT);
  if (keywords.length === 0) return "";

  const sections: string[] = [];
  const seenSlices = new Set<string>();

  for (const kw of keywords) {
    const hits = grepKeyword(kw, repoRoot, HITS_PER_KEYWORD);
    for (const hit of hits) {
      const key = `${hit.file}:${hit.line}`;
      if (seenSlices.has(key)) continue;
      seenSlices.add(key);
      const slice = readSlice(hit.file, repoRoot, hit.line, CONTEXT_LINES);
      if (!slice) continue;
      sections.push(
        `### ${hit.file}:${hit.line} (keyword: ${kw})\n\`\`\`\n${slice}\n\`\`\``,
      );
    }
  }
  if (sections.length === 0) return "";
  return ["## Relevant code", ...sections].join("\n\n");
}

/**
 * Gather context for a task body using the given strategy. Returns "" when
 * the strategy is `none` or nothing relevant was found — callers should only
 * prepend a context block when the result is truthy.
 *
 * `rlm` and the rlm-branch of `auto` log a one-line warning to stderr and
 * fall back to `simple`. That keeps tasks running while we build the real
 * RLM engine, instead of forcing the caller to handle a "not implemented"
 * error.
 */
export function gatherContext(
  body: string,
  strategy: ContextStrategy,
  repoRoot: string,
): string {
  switch (strategy) {
    case "none":
      return "";
    case "simple":
      return gatherSimple(body, repoRoot);
    case "rlm":
      process.stderr.write(RLM_WARNING);
      return gatherSimple(body, repoRoot);
    case "auto": {
      const taskType = detectTaskType(body);
      if (taskType === "quick_fix") return gatherSimple(body, repoRoot);
      process.stderr.write(RLM_WARNING);
      return gatherSimple(body, repoRoot);
    }
  }
}
