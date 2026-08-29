# ADR-0027: Live Board discovery and session-isolated feed state
Background: a session joined only topics open at startup or touched by itself, so a peer opening a topic later in the same project remained invisible; module-global feed state could also be cleared by another session.
Decision: before every agent turn, discover and persist joins for all currently open topics in the project Board, then compute checkpoint/delta from that refreshed set.
Decision: keep participation, activated knowledge scopes, and warning dedupe state keyed by Pi session ID; session shutdown removes only that session state.
Boundary: delivery is turn-boundary pull, not an out-of-band interrupt while a model call is running; JSONL topic locks remain the cross-process write authority.
Reason: separate Pi processes already share `.pi-board`; repeated cheap discovery makes their read path match that shared-write model and the existing startup auto-join semantics.
Reason: per-session state prevents one same-process session start/switch from erasing another session's cursors or participation.
Rejected: filesystem watchers/push IPC (more lifecycle and portability failure modes) and permanent startup-only membership (misses peer-created work).
