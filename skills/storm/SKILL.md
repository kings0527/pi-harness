---
description: "Multi-model adversarial debate (storm mode). Trigger when hitting judgment calls with multiple defensible positions."
---

# Storm Mode (Multi-Model Debate)

## When to trigger

- You have exhausted your own approaches and lack confidence in your conclusion.
- The question is inherently a judgment call with multiple defensible positions.
- You realize you might be in a blind spot (the same logic keeps looping without new insight).

## How to trigger

```
spawn action=debate, topic="<current-topic>", question="<the specific point to debate>"
```

## Prerequisites

- Storm must be enabled: `/storm on <model1>,<model2>`
- A board topic must be open (the debate posts to it)

## What happens

1. Advocate (model 1) is spawned first — posts the strongest case FOR the position.
2. After advocate completes and posts to board, Critic (model 2) is spawned — reads advocate's arguments and posts the strongest case AGAINST.
3. Both follow strict debate discipline (evidence-based, steel-man, no drift).
4. After debate, you synthesize: where do they agree? Where is evidence strongest? What remains unresolved?

## Do NOT trigger when

- Storm is disabled (`/storm` shows OFF)
- The task is factual/mechanical with clear answers
- You haven't first tried to solve it yourself
