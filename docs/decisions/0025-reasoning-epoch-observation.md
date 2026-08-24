# ADR-0025: Reasoning-epoch observation and protocol toggle
Background: the strip-on-replay fix (ADR-0021) was never exercised in the long sessions that motivated it, and DeepSeek-format endpoints require reasoning_content on assistant messages, which stripping empties to "" and breaks the reasoning_details signature chain.
Decision: every assistant message appends a thinking_observation event (thinking chars, telegraphic marks of the （—— pattern, marks-per-1000 ratio, request context tokens) to events.jsonl, so telegraphic density can be correlated with context size over long runs.
Decision: completed-epoch stripping is gated by PI_REASONING_EPOCH_STRIP (default on); set 0/false/off for the protocol-compliant arm that keeps reasoning in provider context while rotation markers keep re-anchoring.
Decision: summarizer inputs stay scrubbed of scratchpad regardless of the toggle; session JSONL remains the intact audit store.
Reason: a clean A/B over long tasks decides between the context-size hypothesis and the self-reinforcement hypothesis with data instead of speculation.
Tradeoff: events.jsonl grows one line per assistant message; the off arm pays context tokens for replayed thinking.
