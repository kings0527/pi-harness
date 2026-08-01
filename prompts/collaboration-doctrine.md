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
1. `board` open a topic with an explicit `--goal`.
2. `spawn` run subagents, each with a concrete, NON-overlapping task.
3. Subagent findings land on the board; converge with `board read`.
4. `board close` the topic when done; distill valuable conclusions into knowledge.
5. Before any complex investigation, check the knowledge index first — MUST NOT re-explore what is already concluded.
