---
name: anti-drift-discipline
description: >-
  Anti-drift discipline for chaotic analysis tasks. Use when searching for signal
  in noise: reverse engineering, root cause analysis, debugging, vulnerability
  hunting, or any task where you must find a needle in a haystack without losing
  direction. Do NOT use for clear implementation, simple Q&A, or single-path tasks.
---

# Anti-Drift Discipline (judgment reference, not runtime enforcement)

The four core rules are always in your system prompt (see prompts/anti-drift.md).
This file is the extended reference: layer model, evidence classification,
fingerprint semantics, stall recovery, and termination criteria. Read it when
a task enters exploratory mode.

## What the runtime does — and does not do

The runtime hook (`extensions/anti-drift.ts`) does exactly one thing: it
detects when a tool call is identical to the immediately previous tool call
(same tool, same target, same parameters) and writes a warning to stderr
and `events.jsonl`. The warning is for the human operator. It does NOT
appear in your context. The LLM is trusted to know what it is doing —
including when "monkey-sort" exploration is the right move.

What the runtime does NOT do:
- It does NOT count steps, tokens, or neutral actions.
- It does NOT auto-escalate to any "strict" mode.
- It does NOT inject state, counters, or fingerprints into your context.
- It does NOT block, gate, or interrupt your flow.

If you want to silence the runtime entirely (e.g. for a session that
intentionally retries), set `PI_ANTIDRIFT_DISABLED=1`.

## What "drift" actually means here

Drift is losing the goal. It is NOT:
- repeating an action intentionally to confirm an observation,
- reading a large file once per line during a long analysis,
- trying many variants of a parameter when the search space warrants it,
- "monkey-sorting" through hypotheses before committing to one.

A long, exploratory, even inefficient investigation is fine, as long as
every action still serves the goal you stated at the start.

## Layer model (build your own — do not rely on a fixed table)

Define layers for the current task at start. Examples (illustrative, not exhaustive):

| Domain | Layer chain |
|---|---|
| reverse engineering (with protections) | detection → protection → logic → data |
| production incident | symptom → environment → interface → concurrency → state → persistence |
| browser exploit | input → parser → IR/optimization → memory model → scheduler → sandbox |
| JS VMP | payload → scheduler → virtual ISA → state machine → semantics → bindings |

Only one active_layer at a time. Cross-layer evidence may be recorded, but
investigating another layer requires an explicit `from → to: reason` switch.

## Discriminating probe

Before any non-trivial action, answer:

```
H: what hypothesis am I testing?
O: what observation would distinguish it?
D: how would each outcome change the next decision?
```

Execute only if the action will (a) confirm or refute a hypothesis,
(b) constrain the search range, (c) set up a follow-up probe, or
(d) produce a verifiable intermediate artifact.

This is judgment. The runtime does not enforce it.

## Evidence classification

After every probe, classify the result:

| Class | Meaning |
|---|---|
| CONFIRM  | result supports the active hypothesis |
| REFUTE   | result disproves the active hypothesis |
| CONSTRAIN| narrows or reshapes the search range |
| ENABLE   | sets up a future discriminating probe |
| NEUTRAL  | no decision-changing information |

Only the first four count as progress. But "NEUTRAL" is not a sin —
it is information about the probe, not a verdict on the explorer.
A long stretch of NEUTRAL results during a deep analysis (e.g. reading
a 50,000-line disassembly) is legitimate; you may be loading context
for a future decision.

## Stall recovery

If you notice you have stopped making decision-changing progress, vary
exactly one of:

```
hypothesis | layer | tool | input | granularity | observation point
```

If you are in a long, low-yield stretch that you know is part of the work
(loading context, mapping a large surface, replaying traffic), do NOT
"vary" just to satisfy a heuristic. Press on; the goal is what matters.

## Event-anchored checkpoints (NOT per-step)

Write a full anchor only on these events:
- active hypothesis confirmed or refuted
- active layer switch
- search route change
- about to compress context
- high-cost or irreversible action imminent
- phase result to user

Per-step anchors are NOT required and pollute context. There is no
runtime pressure to produce them.

Anchor format:

```
confirmed:
ruled_out:
uncertain:
active:
next:
exit_condition:
```

## Termination

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

Do NOT substitute repeated retries for a block declaration. And do NOT
declare "blocked" just because progress feels slow — declare blocked when
the current path genuinely cannot continue.
