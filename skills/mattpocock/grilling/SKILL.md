---
name: grilling
description: "Stress-test a plan, architecture, or ambiguous idea via a Design Tree interview. Use when the user asks to be grilled ('grill me', '追问/拷问一下方案') or wants to resolve all hidden design assumptions before coding."
---

# Grilling (Design-Tree Frontier Interview)

Interview the user relentlessly until every load-bearing assumption is resolved. Model the problem space as a **design tree**: each root decision branches into downstream decisions that depend on it.

## Rules

1. **Ask only the current frontier.** The **frontier** is the set of open decisions whose prerequisites are already settled. Ask the entire current frontier in one round, numbered clearly, with your concrete recommended answer on each:

```markdown
❓ **Q1** — **<decision title>**: <concise trade-off / options>

➡️ **推荐**：<your recommended choice and 1-sentence reason>

---

❓ **Q2** — **<decision title>**: <concise trade-off / options>

➡️ **推荐**：<your recommended choice and 1-sentence reason>
```

2. **Word every question so "yes / 同意" accepts your recommendation.** Never force the user to type "no" to agree with you.
3. **Facts are your job; decisions are the user's.** Never ask the user a question that reading code, configs, git history, or `knowledge` can answer. Dispatch a fresh-context read-only subagent (or `flux` when multiple areas need probing) to gather facts; ask any independent frontier questions immediately without blocking on unrelated lookups.
4. **Advance round by round.** Each user reply prunes branches and unlocks the next frontier. Hold dependent downstream questions for the round after their parent is settled.
5. **Clear termination.** Stop when the frontier is empty (no silent assumptions left). Present a tight summary of settled decisions (ready to post as a `board` `plan` or execute) and wait for confirmation before modifying production files.
