# ADR-0021: Proactive reasoning epochs
Background: replaying raw assistant thinking across a very long tool loop can make a transient shorthand style self-reinforcing.
Decision: treat thinking as protocol-scoped scratch state, while user text, visible answers, tool calls/results, Board, knowledge, and artifacts remain durable evidence.
Decision: a fixed reasoning-token budget queues a persisted user-like epoch marker before the next model call; no prose-pattern detector participates.
Decision: provider context removes thinking only from completed epochs and preserves the current tool-use epoch unchanged for signature validity.
Decision: compaction and branch-summary inputs exclude all thinking blocks before the standalone summarizer sees them.
Decision: proactive compaction uses a factual checkpoint instruction; epoch markers carry no task summary and do not replace source evidence.
Reason: bounding raw-thought replay cuts the causal feedback loop before degeneration rather than recognizing its output afterward.
Tradeoff: an epoch boundary deliberately gives up hidden-reasoning continuity while retaining the complete inspectable task state.
