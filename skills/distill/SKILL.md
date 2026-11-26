---
name: distill
description: "Turn a closed Board topic into sourced knowledge entries. Use after `board action=close` when findings must survive the session."
---

# Distill: Elevate Topic Conclusions to Knowledge

Every step pulls typed graph facts from the closed Board topic so only reusable, specific, evidenced conclusions enter long-term knowledge.

## When

- `board action=close` succeeded and returned "Next: distill…";
- or a topic is already closed but its findings live only in `.pi-board/`.

A topic MUST be closed before distilling. Open topics still change; distilling
them freezes a moving target.

## Inputs

```
board action=list                      # find the closed topic id
board action=read topic=<id>           # works on archives too; the JSONL is authoritative
```

`.pi-board/topics/archive/<id>.summary.md` and `.decisions.md` are **derived**
views generated at close. Read them for orientation, but cite and judge from the
JSONL notes — the summary is a convenience, not evidence.

## Step 1 — Collect candidates by graph fact, not by re-reading prose

The Board is typed. Pull candidates in this order instead of judging every line:

1. **`convergence` note** — its `verdict` is the settled conclusion; its
   `unresolved` list is the set of facts you are explicitly *not* claiming.
2. **`decision` notes** — each `targets` entry is a fact the team settled.
3. **`claim` notes with `material: true` and an active `verification`** — these
   passed the close gate, so they are the strongest evidence in the topic.
4. **`critical` notes** (`priority: critical`) — everything deliberately pinned.
5. **`evidence` notes referenced by (2) or (3)** — the raw observations behind
   the conclusions.

Do **not** distill: plans, `declare` notes, retracted notes, challenges that were
never decided, or the `unresolved` items themselves (recording an accepted
unknown as knowledge turns a bounded gap into a false fact).

## Step 2 — Filter each candidate

Keep it only if all three hold:

- **Reusable** — it would change a future decision, not just describe this task.
- **Specific** — paths, offsets, commands, versions, error text; not "be careful".
- **Evidenced** — you can name the note that proves it.

Two good entries beat ten vague ones. Discard aggressively.

## Step 3 — Deduplicate before writing

```
grep / inspect `knowledge/index.md` (and `~/.pi-harness/knowledge/index.md` for global scope)
```

- Already covered, same conclusion → skip; do not duplicate.
- Covered but the new evidence **contradicts** it → go to Step 5.
- Not covered → Step 4.

## Step 4 — Write the entry

```
board action=distill
  path="<domain>/<subdomain>/<file>.md"
  content="<full entry markdown>"
  source="<topic-id>#<seq>[, #<seq>...]"
  description="<one line for the index row>"
  scope=project|workspace|global
```

Scope is fixed placement, not preference:

| scope | root | use when |
|---|---|---|
| `project` (default) | `<session cwd>/knowledge/` | the conclusion is about this subproject |
| `workspace` | nearest Git root `knowledge/` | at least two related subprojects share it |
| `global` | `~/.pi-harness/knowledge/` | unrelated cross-project fact (tool behaviour, protocol) |

The runtime rejects an entry without `source`, or without `description`. The
file gets a trailing `来源: <source>` line and `index.md` gains its row — both
are automatic; do not hand-edit them afterward.

## Step 5 — Conflict instead of overwrite

When new evidence contradicts an existing entry in the same root:

```
board action=distill-conflict
  path="<existing entry path>"
  description="<what the new evidence shows and why it contradicts>"
  source="<topic-id>#<seq>"
  scope=<same scope as the entry>
```

The conflict block is appended while preserving original bytes. Then add the corrected finding as a **separate** entry (`board action=distill` with a new path).

## Step 6 — Verify

Confirm the new row appears in `<root>/knowledge/index.md` and its target file ends with `来源: <topic>#<seq>`.
knowledge action=list scope=<scope>     # the new rows are present
knowledge action=audit scope=<scope>    # no dead links introduced
```

## Rules (MUST)

1. **Provenance is mandatory** — every entry cites `<topic>#<seq>`. Unsourced
   entries are rejected by the runtime, not by convention.
2. **Fixed placement** — project / workspace / global as tabled above; handoffs
   stay in `<project-root>/handoff/`.
3. **Never silently overwrite** — contradictions go through `action=conflict`,
   which only appends.
4. **Quality over quantity** — discard anything failing Step 2.
5. **Preserve original wording** — copy exact paths, commands, offsets and error
   strings from the note; do not paraphrase evidence into a summary.
6. **Retire, do not delete** — supersede by prefixing the index row with
   `[SUPERSEDED]`, `[ARCHIVED]` or `[DEPRECATED]`. Retired rows fold into the
   demoted catalog section and stay citable as history. Never delete the row or
   the file; re-distilling the same path reactivates it.
7. **Write history, not timeless present, for mutable code** — prose cannot outrun commits. Whenever a distilled claim describes mutable code or runtime behaviour, anchor it to a date or commit SHA (e.g. `As of dsh-pi-harness@46532cb (2026-11-26), ...`) rather than bare "currently" / "now" / "is", so future sessions immediately spot when code has moved on.

## Example

Topic `ghidra-crash-investigation` closed with:

- `#3 claim(material)` "Ghidra < 10.1 misaligns XOR patterns in ARM Thumb mode" → verified by `#5`
- `#7 decision` "Force 32-bit disassembly first, then re-analyze" (targets `#3`)
- `#9 convergence` verdict "misalignment confirmed; x86 out of scope", `unresolved: [#11]`
- `#11 declare` "focus on ARM, ignore x86 for now"

Distill decision:

- ✅ `#3` + `#5` → `reverse-engineering/ghidra/arm-thumb-xor-misalignment.md`, `scope=global` (tool behaviour, cross-project)
- ✅ `#7` → same entry, as the workaround section (it is a decision targeting `#3`)
- ❌ `#11` — a direction, not knowledge; and it is listed as unresolved, not settled

```markdown
# Ghidra ARM Thumb XOR Pattern Misalignment

Ghidra versions < 10.1 misalign XOR patterns when disassembling ARM Thumb
mode binaries.

## Workaround

Force 32-bit disassembly analysis first, then re-analyze in Thumb mode. This
forces Ghidra to establish correct alignment boundaries before Thumb
interpretation.

---

来源: ghidra-crash-investigation#3, #5, #7
```
