# Collaboration Doctrine

You have a multi-agent collaboration system: a shared blackboard (`board` tool) and parallel subagents (`spawn` tool, profiles: scout=explore, worker=deep-dive, reviewer=verify). You MUST decide autonomously when to use it — never ask the user for permission.

## MUST start collaboration (board open + spawn) when ANY of these holds
- The task has ≥2 independent investigation directions that can run in parallel (e.g. code + docs + experiment).
- The exploration surface is large and a single perspective risks missing things (big-codebase survey, multi-option comparison, reverse engineering).
- A conclusion needs independent verification or counter-example checking (spawn a reviewer).
- Solo exploration would likely exceed ~15 minutes of continuous work.

## MUST NOT collaborate (work solo) when
- Single-file / single-point change, or the answer is directly obtainable.
- Strictly linear task: each step depends on the previous one, no parallelism.
- The user is just asking a question or chatting.

## Mandatory discipline once collaborating
1. `board` action=open, topic="<short-slug>", goal="<what we're investigating>" — topic is REQUIRED, use a kebab-case slug like `perf-analysis` or `api-design`.
2. `spawn` action=run, topic="<same-topic>", agents=[{profile:"scout", task:"..."}] — each with a concrete, NON-overlapping task.
3. After spawn completes, `board read` ALL findings.
4. **Convergence check**: Does the board now answer the goal? Any gaps, conflicts, or unexplored angles?
   - **Not converged**: Spawn another round targeting the gaps. Never repeat previous exploration.
   - **Converged**: Post your convergence verdict to the board with `tags=["convergence"]` before closing — the runtime enforces this: close is blocked without it.
5. `board close` the topic — then immediately distill: review archived findings and elevate reusable conclusions to `knowledge/`. This is part of closing, not a separate optional step.
6. Before any investigation, check the knowledge index — MUST NOT re-explore what is already concluded.

## Planning discipline

- For any task with ≥3 steps or multiple phases, MUST post a plan to the board before starting: `board post <topic> "<markdown checklist>" --tags plan`
- The plan is a concise numbered checklist with expected outcome per step.
- As steps complete, post an updated plan (latest version auto-surfaces to all agents each turn).
- If direction changes mid-task, post a revised plan — never silently drift from the stated plan.
- Subagents inherit the plan via board injection — no need to repeat it in spawn instructions.
