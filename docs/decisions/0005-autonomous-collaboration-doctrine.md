# ADR-0005: Autonomous collaboration doctrine via resident systemPrompt injection

## Decision

Inject `prompts/collaboration-doctrine.md` (+ meta-principles) into the systemPrompt
via the `before_agent_start` hook (`extensions/doctrine.ts`), rather than exposing it
as a skill with progressive disclosure.

## Rationale

The "when to collaborate" judgment must be resident: a cold-started agent that doesn't
know the collaboration system exists will never think to look up a skill about it.
Skills work for "how", not for "whether". systemPrompt injection costs ~800 tokens once
per session, is chained safely across extensions (pi 0.83 semantics), and makes board/spawn
usage a self-triggered decision instead of a user instruction.
