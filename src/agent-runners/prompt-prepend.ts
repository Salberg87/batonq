// agent-runners/prompt-prepend.ts — shared SKILL.md → user-prompt prepend.
//
// Codex (`exec`), Gemini (`-p`), and opencode (`run`) all consume the user
// prompt as a single argv slot. None expose a one-shot "system prompt" flag
// usable in headless mode without mutating per-cwd config (Gemini's
// GEMINI.md is per-cwd, opencode's `.opencode/agents/` likewise). So we
// inline the SKILL.md into the prompt with an explicit separator the model
// can latch onto. The `\n` prefix is intentional: it gives Claude-style
// structured prompts a clean newline boundary if the prompt itself starts
// non-whitespace.

const SEPARATOR_OPEN = "\n=== SYSTEM ===\n";
const SEPARATOR_MID = "\n\n=== USER ===\n";

/**
 * Prepend the SKILL.md content to the user prompt with a SYSTEM/USER
 * delimiter. Returns the prompt unchanged when `skillContent` is undefined
 * or empty. Exported standalone (no runner-specific glue) so each runner
 * can call it the same way and tests can verify the format once.
 */
export function applySkillToPrompt(
  prompt: string,
  skillContent: string | undefined,
): string {
  if (!skillContent) return prompt;
  return `${SEPARATOR_OPEN}${skillContent}${SEPARATOR_MID}${prompt}`;
}
