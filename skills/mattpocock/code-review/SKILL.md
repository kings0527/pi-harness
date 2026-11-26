---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (documented coding standards + Fowler smell baseline) and Spec (does the code match the plan/spec?). Runs both reviews in parallel fresh-context subagents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to 'review since X'."
---

# Code Review (Two-Axis Orthogonal Review)

Two-axis review of the diff between `HEAD` (or current working tree when reviewing uncommitted work) and a fixed point:

- **Standards**: does the code conform to this repo's documented coding standards and smell baseline?
- **Spec**: does the code faithfully implement the originating plan / spec / issue?

Both axes run as **parallel subagents started with a fresh context window** (`subagent` in DSH, `spawn` in pi) so they never pollute each other's context or inherit implementation bias, then this skill aggregates their returned findings.

## Process

### 1. Pin the fixed point

Use whatever fixed point the user supplied (a commit SHA, branch name, tag, `main`, `HEAD~5`, or uncommitted diff against `HEAD`). If ambiguous, ask.

Capture the diff command once (e.g. `git diff <fixed-point>...HEAD` against merge-base, plus `git log <fixed-point>..HEAD --oneline`). Confirm the ref resolves (`git rev-parse <fixed-point>`) and the diff is non-empty before dispatching subagents.

### 2. Identify the spec source

Look for the originating spec in this order:

1. A spec path or requirements explicitly supplied by the user.
2. Active or recently closed `board` topic for this work (`plan` note + settled `decision` notes).
3. A spec / design / handoff file under `docs/`, `specs/`, `handoff/`, or `.scratch/` matching the feature or branch.
4. Issue references in commit messages (`#123`, `Closes #45`, `!67`) fetched via `gh`/`glab` if available.
5. If none exists, ask the user; if they confirm there is no spec, skip the **Spec** subagent and note "no spec available".

### 3. Identify the standards sources

Search the repo for files documenting coding rules (`AGENTS.md`, `CLAUDE.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md`, relevant `knowledge/` entries).

On top of repo rules, the Standards axis always carries the **Fowler smell baseline** (_Refactoring_, ch.3):

- **The repo overrides.** Documented repo standards always win over a baseline heuristic.
- **Always a judgement call.** Baseline smells are labelled heuristics ("possible Feature Envy"), never hard violations. Skip anything deterministic tooling/linters already enforce.

Smell baseline (*what it is* → *how to fix*):

- **Mysterious Name**: function, variable, or type whose name hides what it does or holds → rename it; if no honest name comes, the design is murky.
- **Duplicated Code**: same logic shape in multiple hunks/files → extract the shared shape and call from both.
- **Feature Envy**: method reaches into another object's data more than its own → move the method onto the data it envies.
- **Data Clumps**: the same few fields/params keep travelling together → bundle them into one type.
- **Primitive Obsession**: raw string/number standing in for a domain concept with invariants → give the concept its own type/constructor.
- **Repeated Switches**: same `switch`/`if`-cascade on the same discriminant recurs → consolidate into one table/polymorphic boundary.
- **Shotgun Surgery**: one logical change forces scattered edits across many files → gather what changes together into one deep module.
- **Divergent Change**: one module is edited for several unrelated reasons → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have → delete and inline until a real second caller exists.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't know → hide the walk behind one method at the seam.
- **Middle Man**: wrapper/class/function that mostly delegates onward (fails the deletion test) → cut it and call the target directly.
- **Refused Bequest**: implementer/subclass that ignores or overrides most of its contract → drop the wrong abstraction, use composition.

### 4. Dispatch both subagents in parallel (fresh context)

Launch two read-only subagents in parallel in the foreground and aggregate the reports they return:

**Standards subagent brief** — include:
- The exact diff command and commit list.
- Standards files found in Step 3, **plus the full smell baseline from Step 3 pasted inline**.
- Instruction: *"Report, per file/hunk where relevant: (a) every breach of a documented repo standard (cite file + rule); (b) any baseline smell you spot (name it and quote the hunk). Distinguish hard documented violations from judgement calls. Repo standards override baseline smells. Skip anything enforced by typecheck/linter. Keep under 400 words."*

**Spec subagent brief** — include:
- The diff command and commit list.
- Full text or path of the spec / Board plan from Step 2.
- Instruction: *"Report: (a) requirements missing or partial; (b) unrequested behavior / scope creep; (c) requirements whose implementation diverges from the spec's intent or edge cases. Quote the spec/plan line for each finding. Keep under 400 words."*

### 5. Aggregate without merging axes

Present the two reports under `## Standards` and `## Spec` headings. Do **not** merge or rerank across axes: code that obeys every standard while building the wrong thing ("Standards pass, Spec fail") and code that nails the spec while rotting conventions ("Spec pass, Standards fail") must both stay visible.

Close with a one-line summary: total findings per axis and the sharpest issue *within each axis*.
