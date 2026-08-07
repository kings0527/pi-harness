---
name: anti-drift-discipline
description: >-
  Anti-drift discipline for chaotic analysis tasks. Use when searching for signal
  in noise: reverse engineering, root cause analysis, debugging, vulnerability
  hunting, or any task where you must find a needle in a haystack without losing
  direction. Do NOT use for clear implementation, simple Q&A, or single-path tasks.
---

# Anti-Drift Discipline (reference — runtime enforcement is in extensions/anti-drift.ts)

The four core rules are always in your system prompt (see prompts/anti-drift.md).
This file is the extended reference: layer model, evidence classification,
fingerprint/equivalence semantics, stall recovery, and termination criteria.
Read it when a task enters exploratory mode; the runtime hook will then enforce
these rules without requiring you to recite them every step.

## Activation (when to enter STRICT mode)

Enter STRICT when ANY of:
- Two semantically equivalent tool calls in a row (runtime hook will warn)
- A hypothesis was implicitly refuted by new evidence but you continued
- The same layer is being mixed with another layer in a single action
- The search frontier grows without an exit condition
- A previously ruled-out hypothesis reappears in working set

Exit STRICT when one full action produces a decision-changing observation.

## Working state (maintain once, update in place)

Persist the state in the blackboard (board tool) or a task-local file, NOT
in every turn's visible output. Use the runtime hook to inject it as ≤ 300 bytes.

```
goal:
success_criteria:
active_layer:
active_hypothesis:
ruled_out:
confirmed:
next_probe:
exit_condition:
```

## Rule 1: Scope and layer lock

Define the layer graph for the current task at start. Do NOT hard-code a
generic four-layer model. Examples:

| Domain | Layer chain (illustrative, not exhaustive) |
|---|---|
| reverse engineering (with protections) | detection → protection → logic → data |
| production incident | symptom → environment → interface → concurrency → state → persistence |
| browser exploit | input → parser → IR/optimization → memory model → scheduler → sandbox |
| JS VMP | payload → scheduler → virtual ISA → state machine → semantics → bindings |

Only one active_layer at a time. Cross-layer evidence may be recorded, but
investigating another layer requires an explicit `from → to: reason` switch.

## Rule 2: Discriminating probe

Before any non-trivial action, answer:

```
H: what hypothesis am I testing?
O: what observation would distinguish it?
D: how would each outcome change the next decision?
```

Execute only if the action will (a) confirm or refute a hypothesis,
(b) constrain the search range, (c) set up a follow-up probe, or
(d) produce a verifiable intermediate artifact.

Forbidden:
- "Read more code" with no termination condition
- Parameter tweaks without a theory
- Tool calls because the tool exists
- Re-running the same probe with cosmetic changes

## Rule 3: Evidence classification

After every probe, classify the result:

| Class | Meaning |
|---|---|
| CONFIRM  | result supports the active hypothesis |
| REFUTE   | result disproves the active hypothesis |
| CONSTRAIN| narrows or reshapes the search range |
| ENABLE   | sets up a future discriminating probe |
| NEUTRAL  | no decision-changing information |

Only the first four count as progress. The runtime hook classifies
`NEUTRAL` automatically from tool output shape; do not self-declare `CONFIRM`
without explicit evidence.

## Rule 4: Stall circuit breaker

Triggered automatically by the runtime hook after a configurable run of
NEUTRAL actions (default: 3). When triggered, vary exactly one of:

```
hypothesis | layer | tool | input | granularity | observation point
```

Then re-evaluate. Do not loop on parameter tweaks; that is the canonical
sign of an unfalsifiable hypothesis.

## Rule 5: Event-anchored checkpoints (NOT per-step)

Write a full anchor only on these events:
- active hypothesis confirmed or refuted
- active layer switch
- search route change
- stall circuit breaker triggered
- context about to be compressed
- high-cost or irreversible action imminent
- phase result to user

Anchor format:

```
confirmed:
ruled_out:
uncertain:
active:
next:
exit_condition:
```

Per-step anchors are NOT required and pollute context. The runtime hook
will only inject the current state, not historical anchors.

## Rule 6: Termination

Stop when ONE of:

**Solved** — success_criteria met with reproducible evidence.

**Bounded partial result** — distinguish:
```
verified_core:
unverified:
supported_claims:
unsupported_claims:
```

**Blocked** — state explicitly:
```
missing: evidence | permission | tool | sample
why_current_path_cannot_continue:
cheapest_unblocking_action:
```

Do NOT substitute repeated retries for a block declaration.
