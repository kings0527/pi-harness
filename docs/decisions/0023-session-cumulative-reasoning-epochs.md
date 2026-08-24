# ADR-0023: Session-cumulative reasoning-epoch rotation
Background: the 32K epoch budget reset at every user-like boundary, so long multi-turn sessions accumulated ~16-20K reasoning per turn and never rotated while their context grew to 730K and thinking degraded to telegraphic fragments; rotation only fired inside single oversized turns.
Decision: reasoning tokens accumulate per session since the last rotation (not per user turn); after each marker the next rotation threshold advances by the budget, so any long session rotates steadily regardless of turn boundaries.
Decision: rotation still requires a tool-calling assistant message and still preserves the unconsumed tool protocol bridge; the marker now instructs writing a durable factual checkpoint (Board note/file) before the closed thinking is stripped.
Reason: mid-turn boundaries are the only strippable window in a long session, and a fresh reasoning pass needs persisted evidence to avoid shallow telegraphic reasoning.
Tradeoff: more rotation markers cost a few tokens each and give up hidden-reasoning continuity earlier; the checkpoint instruction keeps durable state complete (ADR-0012).
