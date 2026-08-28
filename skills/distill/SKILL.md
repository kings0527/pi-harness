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

0. **Choose the tier (ADR-0014 — fixed placement)**:
   - `scope=project` (default) → `<project-root>/knowledge/` at the pi session root. Use for the active subproject only.
   - `scope=workspace` → `<workspace-root>/knowledge/` at the nearest Git root. Use only when at least two related subprojects share the conclusion.
   - `scope=global` → `~/.pi-harness/knowledge/`. Use across unrelated workspaces.
   - Context loads the active project + workspace + global with root deduplication; sibling projects stay out.

1. **Choose a path** within the chosen root: `{domain}/{subdomain}/{filename}.md`
   - Follow existing structure if the domain already has entries
   - Create new subdirectories as needed (only INSIDE the root)

2. **Write the entry** with mandatory source link (the `board` tool's `distill` action):
   ```
   board action=distill path=<entry-path> content="<full entry markdown>" source="topic-<id>#seq-<N>,seq-<M>" description="<one-line for index>" scope=project|workspace|global
   ```
   Entries without a `source` are rejected by the runtime.

3. **Check for conflicts**: If the new finding contradicts an existing entry in the SAME root:
   - DO NOT modify or overwrite the existing entry
   - Instead, mark it as CONFLICT (the `board` tool's `distill-conflict` action — it only appends a CONFLICT block, never rewrites):
   ```
   board action=distill-conflict path=<existing-path> source="topic-<id>#seq-<N>" description="<what contradicts>" scope=project|workspace|global
   ```
   - Then add the new finding as a separate entry (`action=distill` with a different path)

### Step 4: Update Index

The `distill` action automatically updates `index.md` in the chosen root. Verify the index after completion.

## Rules (MUST)

1. **溯源 (Traceability) is mandatory**: Every entry MUST include `来源: topic-<id>#seq-<N>` linking back to the original evidence. Entries without source links are REJECTED.

2. **Fixed placement (ADR-0014)**: Subproject knowledge uses `project`, related-repo knowledge uses `workspace`, unrelated cross-repo knowledge uses `global`; handoffs stay at `<project-root>/handoff/`.

3. **NEVER silently overwrite**: When new knowledge contradicts existing entries, ALWAYS mark the conflict explicitly. Use the CONFLICT workflow above.

4. **Quality over quantity**: It's better to distill 2 high-quality entries than 10 vague ones. Discard anything that doesn't meet the "reusable + specific + evidenced" bar.

5. **Preserve original wording**: Don't over-summarize. The entry should be detailed enough to be useful without re-reading the original topic.

6. **Retiring, not deleting (ADR-0026)**: When an entry is superseded, mark its index row with a leading tag — `[SUPERSEDED]`, `[ARCHIVED]`, or `[DEPRECATED]` — e.g. `[SUPERSEDED] qnr/foo/bar.md | ...`. Retired rows fold out of the injected catalog into a demoted "retired" section (still cite-able as history) instead of sitting beside current knowledge. Never delete the row or the file; re-distilling the same path reactivates it (drops the tag). Dead links (missing files) are auto-excluded from injection and reported as health issues — repair the path or remove the row deliberately.

## Example

Topic `ghidra-crash-investigation` closed with findings:
- seq #3: "Ghidra < 10.1 misaligns XOR patterns in ARM Thumb mode"
- seq #7: "Workaround: force 32-bit disassembly first, then re-analyze"
- seq #12 (human critical): "Focus on ARM, ignore x86 for now"

Distill decision:
- ✅ Distill seq #3 + #7 → `reverse-engineering/ghidra/arm-thumb-xor-misalignment.md` with scope=global (cross-project tool limitation)
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
