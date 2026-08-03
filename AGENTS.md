# PI-Harness — Agent Instructions

## Architecture

- `core/` — Pure Node.js library, runtime-agnostic. ZERO imports from `@earendil-works/*` or any pi package.
- `extensions/` — Thin adapter layer. ONLY place that touches pi Extension API (`pi.on()`, `pi.registerTool()`).
- `skills/` — Markdown workflow guides (SKILL.md with YAML frontmatter). Loaded by pi on demand.
- `prompts/` — Constant prompt templates injected into systemPrompt via `extensions/doctrine.ts`.
- `knowledge/` — Long-term memory store (git-versioned markdown + index.md).
- `agents/` — Role cards (JSON) for spawn subagents.

## Core Invariants

1. `grep -r "@earendil" core/` MUST return empty — core has no pi dependency.
2. Total constant token injection (meta-principles + doctrine + tool descriptions) MUST stay < 1000 tokens.
3. Context feed budget: ≤ 3000 bytes per turn (managed in `extensions/context-feed.ts`).
4. Board storage: `.pi-board/` (project-local, append-only JSONL + markdown snapshots).
5. All architectural decisions documented in `docs/decisions/` (10-line ADR format).

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
- New knowledge entry → MUST include `来源: <source-link>` (traceability enforced by code)

## Do NOT

- Modify `HANDOFF.md` (read-only design authority)
- Import `@earendil-works/*` in `core/` (runtime-agnostic boundary)
- Push constant token injection above 1000 tokens total
- Add embeddings, vector DB, or auto-memory systems (ADR-0002)
- Bundle third-party pi packages (ADR-0000)
- Force push or commit secrets/tokens

## Key Design Principles

- **File-first**: All state is `cat`-inspectable files, no black boxes
- **Judgment for LLM, constraints for code**: Hooks enforce hard invariants; prompts guide judgment calls
- **Thin extensions**: Logic lives in `core/`, extensions only do registration + wiring
