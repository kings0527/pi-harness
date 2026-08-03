---
description: "Analyze failure patterns from events.jsonl. Use after completing a complex task to identify recurring issues."
---

# Analyze Failures: Mine Patterns from Event Log

After completing a complex investigation or encountering repeated issues, use this skill to systematically analyze the event log for failure patterns.

## Process

### Step 1: Read Event Log

```
read .pi-board/events.jsonl
```

Filter for failure-related events: `hook_warn`, `hook_fail_loud`, `hook_block`.

### Step 2: Cluster by Rule

Group failures by their `rule` field:
- `read-before-write` — files modified without reading first
- `diff-scope-observation` — too many files touched
- `fail-loud` — bash commands failing silently
- `convergence-gate` — premature close attempts
- `spawn-round-guard` — excessive spawn rounds

### Step 3: Identify Patterns

For each cluster with ≥2 occurrences, ask:
- **Root cause**: Why does this keep happening?
- **Is it a doctrine gap?** (Agent doesn't know better → improve doctrine)
- **Is it a skill gap?** (Agent can't do better → add tool/skill)
- **Is it environmental?** (External issue → document workaround)

### Step 4: Distill into Knowledge

For actionable patterns, create entries in `knowledge/failures/`:
- Path: `knowledge/failures/<pattern-name>.md`
- Content: description + root cause + mitigation
- Source: `events.jsonl entries at timestamps X, Y, Z`

Use `board` tool with `action=distill` to persist.

## When to Use

- After `board close` on a complex topic (especially if multiple spawn rounds occurred)
- When you notice the same hook_warn firing repeatedly
- Periodically (every ~5 topics) as maintenance

## Output

A brief report: which patterns found, severity, suggested mitigation. If a pattern suggests a doctrine change, flag it for human review.
