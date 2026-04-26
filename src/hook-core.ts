// hook-core — pure helpers extracted from agent-coord-hook.
// Kept free of I/O side-effects beyond fs reads and statfs so tests can drive them
// against temp fixtures without mocking.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const MAX_HASH_BYTES = 1_048_576;

// Quote-aware: the `(?<!["'][^"']*)` lookbehind prevents false positives on
// destructive tokens inside quoted strings (e.g. `echo "rm -rf" > note.md`
// shouldn't trip the hook — the `rm` there is data, not a command).
export const DESTRUCTIVE =
  /(?<!["'][^"']*)\b(rm|mv|truncate|shred)\b|\bgit\s+reset\s+--hard\b|\bgit\s+checkout\s+--\s|\bdd\s+of=/;

export function hashFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    const h = createHash("sha256");
    if (size <= MAX_HASH_BYTES) {
      h.update(readFileSync(path));
    } else {
      const buf = readFileSync(path);
      h.update(buf.subarray(0, MAX_HASH_BYTES));
      h.update(`|size=${size}`);
    }
    return "sha256:" + h.digest("hex");
  } catch {
    return null;
  }
}

// Verify-gate trigger detector. Matches `batonq done <eid>` (or the legacy
// `agent-coord done`, or the dev `bun src/agent-coord done`). Returns the
// external_id (lowercase hex, ≥6 chars) or null if the command isn't a
// done-call.
//
// This is the ONLY structurally-preventive anti-cheat measure we have for the
// "agent declares done without doing the work" failure mode — and only for
// the Claude Code runner. Detecting the call here lets the PreToolUse hook
// run verify_cmd inline and block the Bash invocation if verify fails. See
// agent-coord-hook bash mode for the wiring.
export function extractDoneEid(cmd: string): string | null {
  if (!cmd) return null;
  // Match: "...batonq done <hex>" or "...agent-coord done <hex>" anywhere
  // in the command (handles `&&`, `||`, `;`, leading `echo y |`, env-prefixes,
  // shell wrappers, etc.). Hex is 6+ chars to allow short eids; existing eids
  // are 8 chars. Trailing flag suffix ignored.
  const m = cmd.match(/\b(?:batonq|agent-coord)\s+done\s+([0-9a-f]{6,})\b/i);
  return m ? m[1]!.toLowerCase() : null;
}

export function extractBashPaths(cmd: string, cwd: string): string[] {
  const tokens = cmd
    .replace(/[|;&<>]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ""))
    .filter(
      (t) =>
        t &&
        !t.startsWith("-") &&
        !/^(rm|mv|cp|dd|git|reset|hard|of|checkout|truncate|shred|sudo|sh|bash|zsh|echo)$/i.test(
          t,
        ) &&
        (t.includes("/") || t.includes(".")),
    );
  return tokens
    .map((t) => (isAbsolute(t) ? t : resolve(cwd, t)))
    .filter((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
}
