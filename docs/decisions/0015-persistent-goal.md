# 0015: /goal — session-persistent execution focus via context-hook reference message

## Decision
`/goal <condition>` stores a single active goal in `.pi-board/goal.json`. The goal is injected each turn via a `context` hook as a reference message (NOT systemPrompt, to preserve KV cache). Completion follows the convergence-gate pattern: LLM posts a `goal-met` tagged Board note; the goal extension hook detects the tag and marks goal achieved.

## Rationale
- Context hook (reference message) avoids cache miss: systemPrompt stays unchanged, KV cache prefix preserved.
- Convergence-gate pattern (ADR-0006) proven: judgment for LLM, existence check for code.
- File-first: `.pi-board/goal.json` is `cat`-inspectable. No hidden state.
- Single active goal enforced by code prevents attention dilution.
