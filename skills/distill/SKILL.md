---
description: "Distill topic conclusions into long-term knowledge. Use after `board close` to elevate findings."
---

# Distill: Elevate Topic Conclusions to Knowledge

After a topic is closed (`board close <topic>`), use this skill to systematically evaluate each finding and decide whether to preserve it in the long-term knowledge base.

## Prerequisites

- The topic MUST be closed (check with `board list` — status should be "closed")
- Read the topic's `summary.md` and `decisions.md` from `.pi-board/topics/archive/<topic>.summary.md` and `.pi-board/topics/archive/<topic>.decisions.md`

## Process

### Step 1: Review Closed Topic

Read the archive files:
```
read .pi-board/topics/archive/<topic>.summary.md
read .pi-board/topics/archive/<topic>.decisions.md
```

### Step 2: Identify Candidates

For each finding/decision in the topic, evaluate:
- **Is this reusable knowledge?** (Would it help in a future similar situation?)
- **Is it specific enough to be actionable?** (Vague observations don't qualify)
- **Does it have supporting evidence?** (Which seq numbers support it?)

### Step 3: For Each Candidate — Distill or Discard

For each candidate that passes Step 2:

1. **Choose a path** in the knowledge tree: `knowledge/{domain}/{subdomain}/{filename}.md`
   - Follow existing structure if the domain already has entries
   - Create new directories as needed

2. **Write the entry** with mandatory source link (the `board` tool's `distill` action):
   ```
   board action=distill path=<knowledge-path> content="<full entry markdown>" source="topic-<id>#seq-<N>,seq-<M>" description="<one-line for index>"
   ```
   Entries without a `source` are rejected by the runtime.

3. **Check for conflicts**: If the new finding contradicts an existing entry in `knowledge/`:
   - DO NOT modify or overwrite the existing entry
   - Instead, mark it as CONFLICT (the `board` tool's `distill-conflict` action — it only appends a CONFLICT block, never rewrites):
   ```
   board action=distill-conflict path=<existing-path> source="topic-<id>#seq-<N>" description="<what contradicts>"
   ```
   - Then add the new finding as a separate entry (`action=distill` with a different path)

### Step 4: Update Index

The `distill` action automatically updates `knowledge/index.md`. Verify the index after completion.

## Rules (MUST)

1. **溯源 (Traceability) is mandatory**: Every entry MUST include `来源: topic-<id>#seq-<N>` linking back to the original evidence. Entries without source links are REJECTED.

2. **NEVER silently overwrite**: When new knowledge contradicts existing entries, ALWAYS mark the conflict explicitly. Use the CONFLICT workflow above.

3. **Quality over quantity**: It's better to distill 2 high-quality entries than 10 vague ones. Discard anything that doesn't meet the "reusable + specific + evidenced" bar.

4. **Preserve original wording**: Don't over-summarize. The entry should be detailed enough to be useful without re-reading the original topic.

## Example

Topic `ghidra-crash-investigation` closed with findings:
- seq #3: "Ghidra < 10.1 misaligns XOR patterns in ARM Thumb mode"
- seq #7: "Workaround: force 32-bit disassembly first, then re-analyze"
- seq #12 (human critical): "Focus on ARM, ignore x86 for now"

Distill decision:
- ✅ Distill seq #3 + #7 → `knowledge/reverse-engineering/ghidra/arm-thumb-xor-misalignment.md`
- ❌ Discard seq #12 (project-specific direction, not reusable knowledge)

Result in knowledge:
```markdown
# Ghidra ARM Thumb XOR Pattern Misalignment

Ghidra versions < 10.1 misalign XOR patterns when disassembling ARM Thumb mode binaries.

## Workaround

Force 32-bit disassembly analysis first, then re-analyze in Thumb mode. This forces Ghidra to establish correct alignment boundaries before Thumb interpretation.

---

来源: topic-ghidra-crash-investigation#seq-3,seq-7
```
