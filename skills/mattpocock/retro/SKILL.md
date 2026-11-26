---
name: retro
description: "Session and environment retrospective. Use after finishing a complex task, hitting repeated friction/retries, or when asked to review how the harness, tools, checks, skills, or knowledge can prevent recurring mistakes."
---

# Retro: Improve the Environment, Not Just the Code

Conduct a retrospective on the current (or specified) session to harden the **agent environment** so future runs move faster and hit fewer traps.

## Core Triage Law ("LLM judges, code constrains")

Classify every mistake, stall, or friction point before proposing a fix:

1. **Mechanical / invariant violation** (wrong API shape, missed build/lint step, path/schema rule, silent command failure) → **Build a deterministic check** (unit/contract test, linter rule, script gate, pre-commit check). Never write prose in `AGENTS.md` or a skill for what deterministic code can enforce.
2. **Environment / tool-economy friction** (took 10 calls to find a file, noisy CLI/MCP output, missing repro harness or log access) → **Fix navigation or tooling** (add a concise `KNOWLEDGE.md` navigation pointer, tighten a wrapper script, expose a single check command).
3. **Non-obvious codebase or tool gotcha** (protocol quirk, version trap, root cause confirmed with evidence) → **Distill into tiered `knowledge`** using the `distill` skill, anchored to date + `repo@commit` and `<topic>#<seq>` provenance.
4. **Prompt / skill sediment & no-ops** (bloated `AGENTS.md` or `SKILL.md`, stale instructions, weak prose the model ignored) →Load `writing-for-agents` and **prune or sharpen** (delete no-ops, replace prohibitions with positive targets, disclose rare branches behind pointers).

## Steps

1. **Inspect primary evidence** for the session: tool retries, failed hypotheses, closed/open `board` notes (if any), and expensive exploration detours.
2. **Group findings** into the four buckets above, ordered **most severe / highest-leverage first**. Skip one-off typos with zero recurrence value.
3. **Present concrete, actionable offers** (exact test/check to add, exact `knowledge` entry to distill, exact lines to prune or sharpen) and apply whichever the user approves.
