# ADR-0022: Goal auto-continuation via steering
Background: /goal only re-injects the objective once per user turn; a reporting turn ends the agent with no runtime force to keep working, so the operator nudges every round ("继续"、"继续呢？").
Decision: on agent_end, while the goal is active, queue a goal_continue steer (the same delivery channel ADR-0021 uses) that re-asserts the objective, completion tags, and blocker policy; per user turn at most 4 auto-continuations, reset on each real user turn.
Decision: aborted/error turns never auto-continue; paused/achieved/cleared goals stop continuation; completion remains Board-note verified by tool_result (ADR-0015).
Reason: steering is the only loop pi exposes to resume an ended turn, turning the goal from a passive reminder into a runtime keep-working driver.
Tradeoff: up to 4 extra loops per user turn can cost tokens when the model stalls; the cap bounds it and the operator can interrupt at any time.
