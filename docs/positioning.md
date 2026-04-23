# Positioning — hero rewrite (2026-04-24)

## Context

Current hero (v0.1.0):

> **batonq** — A baton queue for parallel agents.

That tagline describes the _mechanism_ (baton-pass queue) and leaves the _why_
implicit. In conversations with operators running autonomous Claude loops the
actual pain is not "I need a queue" — it's **"my agents keep marking work
done without running the tests."** That's the concrete failure batonq was
hardened against (see `tasks.verify_ran_at IS NULL AND status='done'` — the
`juks-done` badge in the TUI, receipts in `~/.claude/batonq-state.db`).

It also resonates with the outside world right now. Anthropic published the
[April 23 Claude Code postmortem](https://www.anthropic.com/engineering/april-23-postmortem)
on 2026-04-23, describing three separate regressions (reasoning-effort
default, caching/forgetfulness bug, verbosity prompt) that shipped because
**evals failed to reproduce the degradation**. If Anthropic's own eval
pipeline can silently drift, a solo operator driving `claude -p` in a loop
has no chance of catching it by vibe — you need a gate that forces the agent
to _prove_ the work, not just claim it.

V1 positioning therefore leads with the anti-juks story, not the queue
mechanic.

## Three candidate taglines

### A — Punchy headline (10 words)

> **Stop AI coding agents from faking test results.**

Exactly 8 words; reads as a single imperative. First-person-singular framing
("you" implicit) puts the operator in the driver seat.

### B — Mechanism-anchored (15 words)

> **A task queue that refuses to mark work done until the verify gate actually ran.**

15 words. Names the product category ("task queue") and the differentiator
("until the verify gate actually ran") in one breath.

### C — Full subtitle (2 lines)

> **batonq is a coordination queue for parallel AI coding agents — with a
> verify-or-stay-claimed gate that catches the `done`-without-work receipts
> your loop was quietly producing.**

Two lines. Broadens from "test faking" to the full failure mode (claim closed
past the gate, receipts sitting in SQLite), anchors "coordination queue" as
the category, and keeps the parallel-agents promise from v0.1.

## Analysis

| Dimension                              | A (10 words)                                                                                                                                                      | B (15 words)                                                                                                                                                                                      | C (subtitle)                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sharpness** (one clear promise)      | Very high. Single verb ("stop"), single antagonist ("AI coding agents"), single crime ("faking test results"). Scannable in <1 second.                            | High. Two ideas co-exist (queue + verify gate), but the linkage is causal ("refuses to mark done until…"), so it doesn't feel like two messages.                                                  | Medium. Three nouns (queue, gate, receipts) do more work. Richer, but loses the bumper-sticker quality.                                                 |
| **Specificity** (what exactly changes) | Low–medium. Names the _crime_ but not the _fix_. A reader has to scroll to learn how batonq stops it. Risk: sounds like a linter or test harness.                 | High. "Verify gate actually ran" is a concrete mechanism — maps 1:1 to `verify_ran_at IS NOT NULL`. The reader can guess the shape of the tool from this.                                         | Very high. Mentions receipts, claim state, the parallel-agent context. Almost a mini-spec.                                                              |
| **Resonance with Apr 23 postmortem**   | Strong. The postmortem's subtext is "our evals didn't catch it." A, read right after that incident, lands as the consumer-side fix for the same shape of failure. | Strong. "Verify gate actually ran" directly rhymes with the postmortem's "evals initially didn't reproduce the issue" line — both are about gates that exist on paper but don't fire in practice. | Moderate. The receipts framing is true and vivid, but it's specific to batonq's internals; it doesn't piggyback on the Anthropic news cycle as cleanly. |
| **SEO / social hook**                  | Excellent for tweet / HN / Product Hunt — a complete sentence that stands alone.                                                                                  | Good. Slightly long for a one-liner but the best option for a `<meta name="description">`.                                                                                                        | Too long to stand alone; lives well as subtitle under a stronger headline.                                                                              |
| **Honesty risk**                       | Slight overclaim — batonq doesn't stop agents from _generating_ fake results; it stops those results from closing the task. Wording elides that distinction.      | None material. "Refuses to mark work done" is literally what the `done` command enforces when `verify:` is set.                                                                                   | None. Every claim maps to a concrete DB column.                                                                                                         |
| **Aging** (does it date fast?)         | Medium. Tied to the current LLM-agent news cycle. In 18 months "AI coding agents" may read as quaint.                                                             | Good. The mechanism description is durable — verify gates won't go out of fashion.                                                                                                                | Good. Same as B.                                                                                                                                        |

## Choice

**Use A as the H1 tagline. Use C as the two-line subtitle directly beneath
it. Keep B in reserve for `<meta description>` and social copy.**

Reasoning:

1. **A earns the click, C earns the install.** A is the sharpest
   bumper-sticker batonq has ever had — one sentence, one promise, matches
   exactly the failure mode the tool was hardened against. But it
   deliberately underspecifies _how_. C answers that question in the same
   hero block before the reader has to scroll. Stacking them gives the hero
   both hooks: curiosity on the first line, proof on the second.

2. **Leading with the juks story is defensible.** The receipts are real —
   the TUI already has a `juks-done` badge that highlights
   `status='done' AND verify_cmd IS NOT NULL AND verify_ran_at IS NULL`
   rows, and the historical `agent-coord-state.db` carries 39 such rows
   from before the verify gate was mandatory. This is not a marketing
   invention; it's a feature pointed at an observed failure mode.

3. **The Apr 23 postmortem is a once-a-quarter free signal boost.** Framing
   batonq as "the consumer-grade version of the gate Anthropic's own evals
   didn't have" is fair (both are about verify-gates firing when they say
   they fire) and it gives the README a reason to exist in this week's
   reader's mind. A does that work without naming Anthropic in the
   tagline itself — the association happens in the reader's head.

4. **B is valuable but not in the H1.** "A task queue that refuses to mark
   work done until the verify gate actually ran" is the perfect
   description for a PR listing, a launch tweet ≥140 chars, or the GitHub
   repo `description` field — it tells an engineer exactly what they're
   getting. It would feel redundant next to A+C; use it where A can't go.

## Applied to README

- **H1:** keep `batonq` (brand, no change).
- **First-paragraph tagline (bold):** "Stop AI coding agents from faking test
  results." — replaces the current "A baton queue for parallel agents."
- **Subtitle (two lines):** the C paragraph above, broken once so the emphasis
  lands on _"verify-or-stay-claimed gate"_.
- **Former "60-second pitch" section:** rename to "What is this?" and
  reframe the opening from "coordination chaos" to the juks-caught story,
  with a concrete receipts pointer (`tasks.verify_ran_at IS NULL AND
status='done'` / TUI `juks-done` badge). Keep the Claude-Squad / ccswarm
  contrast and the unix-verbs pitch — those are still load-bearing.

## Non-goals for this pass

- Not renaming the project.
- Not changing the logo.
- Not touching the Install / Quickstart / Commands sections — those are about
  _how_ and are fine as-is.
- Not adding a separate "Anthropic postmortem" section. The resonance should
  happen implicitly through the tagline; naming the postmortem in the README
  itself ties the project's identity to someone else's incident, which ages
  badly.
