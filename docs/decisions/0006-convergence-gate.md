# 0006: Convergence gate — close requires an on-board convergence verdict

## Decision
`board close` is blocked by a `tool_call` hook (`extensions/convergence.ts`) unless the topic has at least one note tagged `convergence`. A second hook warns (never blocks) from the 4th spawn round per topic.

## Rationale
- HANDOFF §6.2: the write authority over completion markers belongs to the runtime, never to the LLM — a prompt-only rule lets an agent close without ever evaluating the board.
- Division of labor: *whether* the goal is met is a judgment call and stays with the LLM (hook does zero semantic analysis); *that* the judgment was made explicit on the board is an existence check, which belongs to code.
- Blocking returns `{ block: true, reason }` (verified against pi's `ToolCallEventResult`), so the agent gets an actionable reason and self-corrects in-loop.
