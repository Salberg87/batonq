// agent-runners/routing.ts — task-type detection + oxo-inspired runner routing.
//
// Ports the routing rules from ~/DEV/oxo/agents.yaml. When a task's `agent`
// field is "any" (the default) the dispatcher classifies the task body via
// regex into one of the eight documented task types and resolves it to a
// preferred (agent, model) pair. Explicit agent values pin the runner and
// only the model is auto-picked.
//
// Why regex instead of an LLM call:
// - cheap, deterministic, testable
// - the routing decision happens BEFORE we spawn any agent — paying for an
//   LLM round-trip just to pick which LLM to spawn is silly
// - oxo's original Python implementation also used keyword matching; we
//   keep the same shape so behaviour stays comparable across the two ports
//
// Mapping (preferred only — fallback chains can be layered on later):
//   exploration       → gemini/flash   (1M context, fast, cheap)
//   implementation    → claude/sonnet  (default; reliable tool use)
//   architecture      → claude/opus    (best reasoning, edge cases)
//   review            → claude/sonnet  (balanced)
//   quick_fix         → claude/haiku   (cheap and fast)
//   bulk_analysis     → gemini/pro     (1M context fits whole codebases)
//   code_generation   → codex/default  (boilerplate, completions)
//   refactor          → codex/default  (good at following patterns)
//
// Detection is order-sensitive: more specific buckets are checked first so
// "fix typo in the architecture doc" lands in quick_fix rather than
// architecture, and "audit refactor risk" lands in review rather than
// refactor. Unrecognised bodies fall through to implementation, which
// resolves to the conservative claude/sonnet default.

import type { AgentTool, ModelNickname } from "./types";
import { IMPLEMENTED_TOOLS } from "./types";

export const TASK_TYPES = [
  "exploration",
  "implementation",
  "architecture",
  "review",
  "quick_fix",
  "code_generation",
  "bulk_analysis",
  "refactor",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface RoutingDecision {
  agent: AgentTool;
  model: ModelNickname;
}

/** Preferred (agent, model) per task type — mirrors oxo/agents.yaml routing. */
export const ROUTING_TABLE: Record<TaskType, RoutingDecision> = {
  exploration: { agent: "gemini", model: "flash" },
  implementation: { agent: "claude", model: "sonnet" },
  architecture: { agent: "claude", model: "opus" },
  review: { agent: "claude", model: "sonnet" },
  quick_fix: { agent: "claude", model: "haiku" },
  bulk_analysis: { agent: "gemini", model: "pro" },
  code_generation: { agent: "codex", model: "default" },
  refactor: { agent: "codex", model: "default" },
};

/**
 * Conservative fallback when a task body matches nothing AND no agent is
 * pinned. Equals ROUTING_TABLE.implementation by intent — claude/sonnet is
 * the documented "general-purpose coding" choice.
 */
export const DEFAULT_ROUTING: RoutingDecision = ROUTING_TABLE.implementation;

// Detection patterns. Order matters: top entries win when multiple match.
// Keep specific buckets above generic ones (quick_fix > implementation,
// bulk_analysis > exploration, architecture > refactor, review > refactor).
//
// Bilingual: TASKS.md mixes Norwegian and English freely, so each pattern
// accepts both. Norwegian alternates are appended inside the same group so
// the precedence order above still holds for mixed-language bodies.
const DETECTION_RULES: Array<{ type: TaskType; pattern: RegExp }> = [
  // quick_fix: trivial, mechanical edits. Wins over implementation/refactor
  // because "fix a typo" mentions "fix" which would otherwise look like a fix.
  {
    type: "quick_fix",
    pattern:
      /\b(typos?|fix typo|formatting|whitespace|lint(?:ing)?|prettier|reformat|trivial fix|one[- ]liner|rename (?:variable|var|const)|skrivefeil|formatering|opprydd(?:ing)?|fiks (?:typo|skrivefeil|formatering)|gi (?:nytt navn|nytt navn til) (?:variabel|konstant))\b/i,
  },
  // bulk_analysis: cross-codebase scans / large file ingest. Wins over
  // exploration so "analyze patterns across the codebase" goes to gemini/pro
  // rather than gemini/flash.
  {
    type: "bulk_analysis",
    pattern:
      /\b(across (?:the |whole |entire )?codebase|whole codebase|entire codebase|all files|every file|scan all|bulk analy(?:sis|ze)|patterns? across|analy[sz]e (?:all|every|the (?:whole|entire))|hele kodebasen|gjennom kodebasen|i hele (?:repoet|koden|kodebasen)|alle filer|alle filene|på tvers av (?:kodebasen|repoet)|skann (?:alle|hele)|analyser (?:alle|hele|på tvers))\b/i,
  },
  // architecture: design decisions and system-shape work. Wins over
  // refactor so "redesign the module architecture" goes to claude/opus.
  {
    type: "architecture",
    pattern:
      /\b(architecture|architect (?:the|a|this|new)|design (?:doc|decision|the (?:system|schema|api))|redesign|restructure (?:the )?(?:system|architecture)|system design|high[- ]level design|api design|arkitektur|systemdesign|redesign(?:e|er)?|omstrukturer (?:system(?:et)?|arkitektur(?:en)?)|design(?:e|er)? (?:system(?:et)?|skjema(?:et)?|api(?:et)?)|api[- ]?design)\b/i,
  },
  // review: code review, audits, bug-hunting. Wins over refactor so
  // "audit and refactor X" lands in review.
  {
    type: "review",
    pattern:
      /\b(code review|review (?:the )?(?:pr|pull request|code|diff|changes)|audit (?:the )?(?:code|repo|codebase|security|changes)|find bugs?|spot bugs?|security review|kodegjennomgang|gjennomgå (?:pr|pull request|kode(?:n|en)?|diff(?:en)?|endringer(?:ne)?)|gransk (?:kode(?:n|en)?|repo(?:et)?|kodebasen|sikkerhet(?:en)?|endringer(?:ne)?)|finn (?:bugs?|feil)|sikkerhetsgjennomgang)\b/i,
  },
  // exploration: understand/find/research the codebase.
  {
    type: "exploration",
    pattern:
      /\b(explore|investigate|research|understand (?:the |how )|map (?:out )?(?:the )?(?:repo|codebase)|codebase tour|find (?:where|all usages?|out how)|utforsk(?:e|er)?|undersøk(?:e|er)?|gransk(?:e|er)?|kartlegg(?:e|er)?|forstå (?:hvordan|hvor|hva)|finn ut (?:hvordan|hvor|hva))\b/i,
  },
  // refactor: pattern-following refactors without architecture-level scope.
  {
    type: "refactor",
    pattern:
      /\b(refactor(?:ing)?|extract (?:method|function|component|hook)|rename (?:method|function|class|module|file)|refaktor(?:ering|er|ere)?|trekk ut (?:metode|funksjon|komponent|hook)|gi (?:nytt navn|nytt navn til) (?:metode|funksjon|klasse|modul|fil))\b/i,
  },
  // code_generation: scaffolding, boilerplate, stubs.
  {
    type: "code_generation",
    pattern:
      /\b(generate (?:boilerplate|code|stubs?|scaffolding)|boilerplate|scaffold(?:ing)?|stub out|new (?:component|endpoint) (?:from|using) (?:template|spec)|generer(?:e|er)? (?:boilerplate|kode|stubb(?:er)?|stillas(?:et)?|mal(?:en)?)|stillas(?:ering)?|lag (?:stubb(?:er)?|mal(?:en)?))\b/i,
  },
  // implementation: explicit feature work. Listed last and broadest so
  // anything signal-bearing reaches it before the implicit fallback.
  {
    type: "implementation",
    pattern:
      /\b(implement|add (?:a )?(?:new )?(?:feature|method|function|endpoint|route|command)|build (?:a )?(?:new )?(?:feature|component|endpoint)|write (?:a )?(?:new )?(?:feature|function|method|endpoint)|new feature|feat\(|implementer(?:e|er)?|legg til (?:(?:en |ein |et |ett )?(?:ny |nytt |nye )?)?(?:feature|funksjon(?:alitet)?|metode|endepunkt|rute|kommando)|bygg (?:(?:en |ein |et |ett )?(?:ny |nytt |nye )?)?(?:feature|funksjon|komponent|endepunkt)|skriv (?:(?:en |ein |et |ett )?(?:ny |nytt |nye )?)?(?:feature|funksjon|metode|endepunkt)|ny funksjon(?:alitet)?|ny feature)\b/i,
  },
];

/**
 * Detect a task type from a free-form task body. Returns "implementation"
 * for bodies that match no known pattern — that's the conservative
 * "general coding" bucket that resolves to claude/sonnet downstream.
 */
export function detectTaskType(body: string): TaskType {
  for (const rule of DETECTION_RULES) {
    if (rule.pattern.test(body)) return rule.type;
  }
  return "implementation";
}

const KNOWN_AGENTS = new Set<string>(IMPLEMENTED_TOOLS);

/**
 * Resolve (agent, model) for a task.
 *
 *   agentField === "any"|null|undefined → detect type from body, return
 *     the preferred routing for that type.
 *   agentField === <implemented tool>   → pin that agent; pick a sensible
 *     default model (claude→sonnet, gemini→flash, codex→default,
 *     opencode→default).
 *   agentField === <unknown string>     → treat as unrecognised and fall
 *     back to claude/sonnet. Defensive guard for legacy DB rows or
 *     hand-edited values that slipped past the schema.
 */
export function routeTask(
  body: string,
  agentField?: string | null,
): RoutingDecision {
  if (agentField && agentField !== "any") {
    if (KNOWN_AGENTS.has(agentField)) {
      const explicit = agentField as AgentTool;
      return { agent: explicit, model: defaultModelFor(explicit) };
    }
    return { ...DEFAULT_ROUTING };
  }
  const type = detectTaskType(body);
  return { ...ROUTING_TABLE[type] };
}

function defaultModelFor(agent: AgentTool): ModelNickname {
  switch (agent) {
    case "claude":
      return "sonnet";
    case "gemini":
      return "flash";
    case "codex":
      return "default";
    case "opencode":
      return "default";
  }
}
