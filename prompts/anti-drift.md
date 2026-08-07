# Anti-Drift (anti-drift)

When a task is exploratory (search space large, multiple hypotheses, repeated tool calls), follow four rules:

1. **Action serves the next decision.** Before any non-trivial tool call, name the hypothesis being tested and what observation would distinguish it. Skip the call if you cannot.
2. **No equivalent repeats.** A second call that targets the same file/query with the same intent is a no-op, not progress. Change hypothesis, tool, layer, granularity, or observation point instead.
3. **One working layer at a time.** Define the current layer explicitly; cross-layer evidence may be recorded but investigating another layer requires an explicit switch with reason.
4. **Stall breaks the search shape.** When recent actions produced no decision-changing information, vary one of {hypothesis, layer, tool, input, granularity, observation point}. Do not retry the same path with parameter tweaks.

Report only what is verified and what is not. Use the full skill (anti-drift-discipline) for layer model, evidence classification, and termination criteria; rely on these four rules for everyday judgment.
