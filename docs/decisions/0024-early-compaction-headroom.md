# ADR-0024: Earlier compaction with honest output observation
Background: headroom compaction fired only near ~72% of the 1M window because the completion reserve was inflated by the provider's requested 384K max_tokens; 3-day sessions compacted once while context sat at 730K and reasoning degraded.
Decision: assessContextHeadroom accepts a compactRatio (default 0.66, PI_CONTEXT_COMPACT_RATIO override) that lowers the compaction threshold to min(reserve-based, ratio-based).
Decision: observed output is recorded from actual message_end usage.output, capped at 64K, instead of the requested max_tokens, so the reserve reflects real completions rather than provider defaults.
Reason: degradation is already visible from ~600K on flash models, so compacting earlier keeps the model inside its reliable attention range.
Tradeoff: more frequent compaction costs summarization tokens and can lose fine-grained turn detail; factual checkpoint instructions keep evidence complete.
