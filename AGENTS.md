# PI-Harness — Agent Instructions

## Architecture

- `core/` — Pure Node.js library, runtime-agnostic. ZERO imports from `@earendil-works/*` or any pi package.
- `extensions/` — Thin adapter layer. ONLY place that touches pi Extension API (`pi.on()`, `pi.registerTool()`).
- `skills/` — Markdown workflow guides (SKILL.md with YAML frontmatter). Loaded by pi on demand.
- `prompts/` — Constant prompt templates injected into systemPrompt via `extensions/doctrine.ts`.
- `knowledge/` — Long-term memory in three fixed tiers (ADR-0014): current subproject at `<project-root>/knowledge/` (default), shared repo at `<workspace-root>/knowledge/`, cross-workspace at `~/.pi-harness/knowledge/`. Auto-created on write only.
- `handoff/` — Session handoffs live at `<project-root>/handoff/` only.
- `agents/` — Role cards (JSON) for spawn subagents.

## Core Invariants

1. `grep -r "@earendil" core/` MUST return empty — core has no pi dependency.
2. Total constant token injection (meta-principles + doctrine + tool descriptions) MUST stay < 1000 tokens.
   Current full-corpus proxy: 369 words / 2633 UTF-8 bytes, conservative estimate ≤878 tokens.
3. Context is never silently truncated. Full knowledge indexes and participating Board notes are injected;
   same-project open topics are discovered at each user-turn boundary and feed state is isolated by session.
   At an estimated 20% of the active model window, runtime emits one warning and preserves all content (ADR-0012).
   Passive references freeze per user turn and exact bytes persist in `.pi-board/context-snapshots/`; CRITICAL notes
   become visible, provenance-bearing messages instead of hidden references (ADR-0013).
   Completed raw thinking is the sole exception: it stays intact in session JSONL for audit but is removed from later
   provider epochs and summarizer inputs; all durable evidence remains complete (ADR-0021).
4. Board storage: `.pi-board/` (project-local, append-only JSONL + markdown snapshots).
5. Fixed placement (ADR-0014): project knowledge ONLY at the pi session root, workspace knowledge ONLY at the
   nearest Git root, global knowledge ONLY under `~/.pi-harness/`; context deduplicates identical roots and never
   scans sibling subprojects. Handoffs stay at the session project root. Paths may not escape or traverse symlinks.
6. All architectural decisions documented in `docs/decisions/` (10-line ADR format).
7. Anti-drift discipline is enforced by `extensions/anti-drift.ts` at runtime. The hook ONLY warns on
   tool calls identical to the immediately previous one (operator-visible via stderr + events.jsonl).
   It does NOT inject into model context, count steps/tokens, or auto-escalate to any strict mode.
   The 4-rule prompt is always-on judgment guidance; the full reference skill loads only on description match.
8. Reasoning epochs are proactive capacity boundaries, not drift detectors: default 32K reasoning tokens, one
   protocol-valid bridge for the just-finished tool call, then no completed scratchpad/signature replay (ADR-0021).

## Development Commands

```bash
npm test                    # Run tests (node:test)
node --experimental-strip-types --check <file>.ts  # Syntax check single file
grep -r "@earendil" core/   # Verify core isolation (must be empty)
pi install ./ -l --approve  # Install locally for testing
pi -p --approve "<prompt>"  # Non-interactive test run
```

## When Adding Features

- New hook → Write ADR in `docs/decisions/` first (background, decision, rationale, ≤10 lines)
- New tool → Single tool with action parameter preferred (HANDOFF §2.6: "最少工具")
- New skill → `skills/<name>/SKILL.md` with YAML frontmatter `description` field
- New knowledge entry → MUST include `来源: <source-link>` (traceability enforced by code);
  scope=project writes current subproject, scope=workspace writes the shared Git root, scope=global writes home

## Do NOT

- Modify `HANDOFF.md` (read-only design authority)
- Import `@earendil-works/*` in `core/` (runtime-agnostic boundary)
- Create knowledge/handoff stores outside ADR-0014's selected fixed roots
- Silently truncate knowledge, Board notes, archived summaries, subagent output, or diagnostic evidence (ADR-0012)
- Push constant token injection above 1000 tokens total
- Add embeddings, vector DB, or auto-memory systems (ADR-0002)
- Bundle third-party pi packages (ADR-0000)
- Force push or commit secrets/tokens

## Key Design Principles

- **File-first**: All state is `cat`-inspectable files, no black boxes
- **Judgment for LLM, constraints for code**: Hooks enforce hard invariants; prompts guide judgment calls
- **Thin extensions**: Logic lives in `core/`, extensions only do registration + wiring
