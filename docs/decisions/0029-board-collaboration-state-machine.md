# ADR-0029: Board collaboration state machine and recoverable ownership
Background: live discovery correctly exposes peer topics but equates discovery with full-context participation; notes lack accountable runtime actors and close/lock interruption has no deterministic recovery.
Decision: every session receives a complete metadata catalog of open topics; only explicit `join` receives full notes, while `watch`/`defer` persist a reason and receive metadata-only changes.
Decision: unjoined agent-authored CRITICAL text never crosses into another session; catalog exposes critical metadata so the receiving agent can explicitly join/read.
Decision: runtime-derived stable session actor IDs are required for new structured writes; legacy topic/note shapes remain readable and writable as legacy.
Decision: material claims and challenge/verification/retraction references form an append-only graph; close requires a valid convergence verdict that resolves, retracts, verifies, challenges, or explicitly accepts each open material claim.
Decision: topic locks use owner process-start identity plus monotonically fenced ownership token; release/write checks token ownership and stale recovery never relies on elapsed time alone.
Decision: close stages a journalled transaction with a single archive-JSONL commit point; recovery deterministically completes or restores the active form and preserves evidence. Journal recovery requires its lock token to match any live lock; mismatch fails loud.
Reason: retain shared discovery and complete joined evidence while preventing unsolicited context contamination, fake responsibility, split-brain writers, and ambiguous crash states.
Rejected: automatic relevance scoring/vector retrieval, cross-topic CRITICAL broadcast, raw PID/timeout lock theft, and silent recovery/truncation.
