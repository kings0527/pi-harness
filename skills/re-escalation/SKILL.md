---
name: re-escalation
description: >-
  RE strategy escalation protocol. Use when current reverse engineering approach has failed 3+ times to force systematic path switching and prevent wasted effort.
---

# SKILL: Reverse Engineering Escalation Protocol

> **AI LOAD INSTRUCTION**: Strategy escalation skill for reverse engineering. Load this when your current approach is failing repeatedly. This skill provides systematic rules for WHEN to stop, WHAT to try next, and HOW to avoid the #1 RE failure mode: endlessly retrying the same broken approach. Based on analysis of 1000+ real RE sessions where agents wasted 80%+ effort on dead-end paths.

## 0. RELATED ROUTING

- [re-router](../re-router/SKILL.md) — re-assess target and pick a completely different path
- [mobile-dynamic-re](../mobile-dynamic-re/SKILL.md) — dynamic analysis approach
- [emulation-re](../emulation-re/SKILL.md) — offline emulation approach
- [native-static-re](../native-static-re/SKILL.md) — static analysis approach

## 1. STOP CONDITIONS — Hard Rules

These are NON-NEGOTIABLE. When any condition is met, you MUST stop current approach:

| # | Condition | Mandatory Action |
|---|-----------|-----------------|
| S1 | Same error message/failure 3 consecutive times | STOP. Analyze WHY it fails, not just retry |
| S2 | Same approach with minor variations failed 5 times total | STOP. Escalate to next level (§2) |
| S3 | Spent >30 min on single sub-problem with zero measurable progress | STOP. Re-read §3 diagnostic checklist |
| S4 | Target actively detects and blocks your tool/technique | STOP. You need to defeat detection FIRST (→ anti-debugging-techniques) |
| S5 | Approach requires resource you don't have (device/key/server) | STOP. Switch to approach that doesn't need it |

### What "measurable progress" means:
- ✅ Identified a new function/address relevant to goal
- ✅ Successfully hooked a target and got non-trivial output
- ✅ Decoded/decrypted a previously opaque value
- ✅ Narrowed search space significantly
- ❌ "Tried another variation" without new information
- ❌ "Read more code" without finding the target
- ❌ "Modified script slightly" with same error result

## 2. FIVE-LEVEL ESCALATION PATH

When current level fails, ALWAYS escalate to the next level. Never skip levels unless you have clear evidence the intermediate levels won't work.

```
┌─────────────────────────────────────────────────────────────┐
│ L1: DIRECT APPROACH                                          │
│ • Direct Frida hook / Direct IDA decompile / Direct trace   │
│ • Expected: works on unprotected targets                    │
│ • Failure signal: crash, empty result, immediate detection  │
├─────────────────────────────────────────────────────────────┤
│ L2: STEALTH APPROACH                                         │
│ • Delayed injection / spawn mode / renamed agent binary      │
│ • Early-hook (before app init) / Intercept at deeper layer  │
│ • Expected: works when L1 detected by simple checks         │
│ • Failure signal: still detected, app refuses to run        │
├─────────────────────────────────────────────────────────────┤
│ L3: DEFEAT DETECTION                                         │
│ • Identify detection mechanism (→ anti-debugging-techniques) │
│ • Patch detection / Hook detection APIs / Bypass checks     │
│ • Expected: works when detection is identifiable            │
│ • Failure signal: detection too complex / multi-layered     │
├─────────────────────────────────────────────────────────────┤
│ L4: CHANGE APPROACH ENTIRELY                                 │
│ • Dynamic failed? → Switch to emulation (offline, no detect)│
│ • Emulation failed? → Switch to pure static analysis        │
│ • Static unreadable? → Switch to trace-based (Stalker/trace)│
│ • Reload re-router to pick fundamentally different path     │
├─────────────────────────────────────────────────────────────┤
│ L5: REDUCE SCOPE / ACCEPT PARTIAL                           │
│ • Can't get full algorithm? Get partial (some constants)    │
│ • Can't reproduce offline? Capture enough I/O for replay    │
│ • Can't bypass all protection? Target weakest link only     │
│ • Document what's known + what blocks full solution          │
└─────────────────────────────────────────────────────────────┘
```

## 3. DIAGNOSTIC CHECKLIST — Before Escalating

Before moving to next level, answer these questions to ensure you're not missing something obvious:

### Layer Confusion Check
- [ ] Am I fighting the RIGHT layer? (detection vs obfuscation vs business logic)
- [ ] Did I accidentally bypass a needed initialization by hooking too early?
- [ ] Is my failure at the TOOL level (wrong API usage) rather than the TARGET level?

### Environment Check  
- [ ] Is the target detecting my environment? (jailbreak/root/emulator/debugger)
- [ ] Am I missing a required setup step? (certificate install, proxy config, env variable)
- [ ] Is there a timing issue? (hook too late, race condition, async initialization)

### Information Check
- [ ] Do I have enough static analysis to know WHERE to hook?
- [ ] Am I hooking the right function/address? (verify with xrefs and callers)
- [ ] Is the function I'm targeting actually called in this code path?

### Scope Check
- [ ] Is my target correct? (is this the function that actually computes the result?)
- [ ] Am I confusing a wrapper with the real implementation?
- [ ] Could the algorithm be in a different module/dylib/so than expected?

## 4. COMMON FAILURE PATTERNS (from session analysis)

| Pattern | Root Cause | Correct Response |
|---------|-----------|-----------------|
| "Hook fires but returns nil/empty" | Hooked too early (object not initialized) or wrong overload | Delay hook timing; verify object lifecycle |
| "App crashes immediately after hook" | Anti-tamper integrity check detects modification | Defeat integrity check first (L3), or use observation-only approach |
| "Same 'file not found' / 'skill not found' loop" | Referencing non-existent resource | Stop trying to load it; use alternative approach or inline knowledge |
| "Function decompiles to massive switch/CFF" | Control Flow Flattening | Don't try to read statically; use trace/emulation to recover paths |
| "Emulator hangs on init_array" | Unsupported instruction or infinite loop in initializer | Skip problematic init_array entries; patch or intercept |
| "Correct hook but wrong return value format" | ObjC Block ABI / C++ vtable / complex return struct | Study calling convention; hook at a higher level that uses simpler types |
| "Environment leak detection blocks all approaches" | App checks 20+ environment signals | Systematic enumeration: list ALL checks, bypass one by one |
| "Algorithm output doesn't match expected" | Missing state / wrong field values / timing-dependent input | Capture ALL inputs at the exact call site; compare with known-good |

## 5. ESCALATION LOG TEMPLATE

When escalating, document your path to avoid repeating failed approaches:

```
## Escalation Record
- Target: [what you're trying to achieve]
- Started at: [timestamp/turn]
- Current Level: L[X] → Escalating to L[X+1]

### What was tried at L[X]:
1. [approach 1] → [result/failure]
2. [approach 2] → [result/failure]  
3. [approach 3] → [result/failure]

### Why L[X] is exhausted:
[specific evidence that this level cannot work]

### L[X+1] plan:
[what specifically will be different about the next approach]
```

## 6. COMPLEXITY ESTIMATION MATRIX

Use this to set expectations BEFORE starting:

| Protection Config | Estimated Effort | Success Probability | Recommended Path |
|-------------------|-----------------|--------------------|--------------------|
| No protection, clear code | 1-2 hours | 95% | Direct hook or static analysis |
| Light obfuscation (string encrypt, name mangle) | 4-8 hours | 80% | Static + dynamic combined |
| Anti-debug OR anti-hook (single layer) | 8-16 hours | 70% | Bypass detection → then analyze |
| Anti-debug + obfuscation (two layers) | 1-3 days | 60% | Emulation preferred |
| CFF + anti-hook + integrity checks | 2-5 days | 45% | Emulation + selective static |
| Multi-layer VM + env detection + CFF | 1-2 weeks | 30% | Emulation-first; accept partial results early |
| Server-side validation + client protection | Varies | 50% | Focus on capturing I/O; server logic is black-box |

### Budget Rules:
- If estimated effort > 3x available time → Immediately go to L5 (reduce scope)
- If success probability < 40% → Plan for partial results from the start
- If you're already at 50% of estimated time with no L1/L2 success → Jump to L4

## 7. META-RULES

1. **Never retry the exact same thing**. If you're about to do something you already did, STOP.
2. **Failure is information**. Every failed attempt tells you something — extract that information before trying again.
3. **Layer discipline**: Solve problems at the correct layer. Detection problems need detection solutions, not more analysis.
4. **Document before escalating**: Future you (or the next session) needs to know what was tried.
5. **Partial results are results**: 70% of the algorithm + clear documentation of the remaining 30% is better than 0% after exhausting all budget.
