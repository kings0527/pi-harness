---
name: re-router
description: >-
  Reverse engineering task router. Use when starting any RE task to determine the correct analysis approach and skill to load.
---

# SKILL: Reverse Engineering Router — 5-Second Decision Guide

> **AI LOAD INSTRUCTION**: Meta-routing skill for reverse engineering tasks. Load this FIRST when facing any RE target to quickly determine the correct analysis path. Do NOT start analysis without routing — wrong initial direction wastes 80%+ of effort. This skill routes to specialized skills; it does NOT contain analysis techniques itself.

## 0. RELATED ROUTING (destination skills)

- [mobile-dynamic-re](../mobile-dynamic-re/SKILL.md) — Frida/Substrate dynamic hooking on iOS/Android
- [emulation-re](../emulation-re/SKILL.md) — Unicorn/unidbg/Chomper offline emulation
- [native-static-re](../native-static-re/SKILL.md) — IDA/Ghidra static analysis of native binaries
- [web-reverse-engineering](../web-reverse-engineering/SKILL.md) — Web frontend JS/WASM reverse
- [binary-protection-bypass](../binary-protection-bypass/SKILL.md) — ELF protection bypass for exploitation
- [anti-debugging-techniques](../anti-debugging-techniques/SKILL.md) — Anti-debug detection and bypass
- [symbolic-execution-tools](../symbolic-execution-tools/SKILL.md) — angr/Z3 automated solving
- [vm-and-bytecode-reverse](../vm-and-bytecode-reverse/SKILL.md) — Custom VM/bytecode analysis
- [code-obfuscation-deobfuscation](../code-obfuscation-deobfuscation/SKILL.md) — Deobfuscation techniques
- [re-escalation](../re-escalation/SKILL.md) — When current approach fails repeatedly

## 1. RAPID ASSESSMENT (ask these 4 questions)

Before choosing a path, determine:

1. **Target type**: What am I analyzing? (iOS app / Android app / Web JS / Native binary / Protocol / Firmware)
2. **Available assets**: What do I have? (source? IDA db? jailbroken device? rooted device? traffic capture? binary only?)
3. **Objective**: What's the goal? (algorithm extraction / signature reproduction / vulnerability / bypass detection / protocol decode)
4. **Protection level**: What defenses are present? (none / obfuscation / anti-debug / anti-hook / VM protection / multi-layer)

## 2. DECISION TREE — Route by Target Type

```
What is the target?
│
├── iOS App (Mach-O ARM64)
│   ├── Have jailbroken device + want dynamic analysis?
│   │   └── → mobile-dynamic-re (Frida/Substrate hooking)
│   ├── No jailbreak OR need offline reproduction?
│   │   └── → emulation-re (Chomper for iOS ARM64 emulation)
│   ├── Pure static analysis (IDA/Ghidra decompilation)?
│   │   └── → native-static-re (ARM64 Mach-O patterns)
│   └── Has anti-debug/anti-jailbreak detection?
│       └── → anti-debugging-techniques FIRST, then retry dynamic
│
├── Android App (.so / DEX)
│   ├── Have rooted device + Frida available?
│   │   └── → mobile-dynamic-re (Frida Java/Native hooking)
│   ├── No root OR need offline reproduction?
│   │   └── → emulation-re (unidbg for Android .so emulation)
│   ├── Java/Kotlin layer only (no native)?
│   │   └── → jadx decompilation + Xposed (covered in mobile-dynamic-re §Android)
│   └── Packed/encrypted APK?
│       └── → Unpack first (BlackDex/Frida dump), then re-assess
│
├── Web Frontend (JavaScript / WASM)
│   └── → web-reverse-engineering
│       ├── API signature/encryption? → §4 Algorithm Reverse
│       ├── Anti-bot/anti-crawler? → §5-§6 Detection Bypass
│       └── WASM module? → §4.5 WASM Reverse
│
├── Native Binary (ELF/PE, CTF or general)
│   ├── Goal is exploitation (pwn)?
│   │   └── → binary-protection-bypass → symbolic-execution-tools
│   ├── Goal is algorithm extraction?
│   │   └── → native-static-re (decompile + analyze)
│   ├── Has custom VM/bytecode?
│   │   └── → vm-and-bytecode-reverse
│   ├── Heavy obfuscation (CFF/opaque predicates/junk)?
│   │   └── → code-obfuscation-deobfuscation
│   └── Need automated solving (keygen/crackme)?
│       └── → symbolic-execution-tools (angr/Z3)
│
├── Network Protocol
│   ├── HTTP(S) API with encryption? → web-reverse-engineering §1
│   ├── Custom binary protocol? → Wireshark + native-static-re
│   └── Protobuf/gRPC? → protobuf-decoder tools + traffic analysis
│
└── Firmware / Embedded
    ├── Has DWARF debug info? → dwarf-expert + native-static-re
    └── Bare-metal / RTOS? → native-static-re + emulation-re (Qiling/Unicorn)
```

## 3. MULTI-LAYER TARGETS — Combination Strategy

When target has multiple protection layers, follow this priority order:

| Priority | Layer | Action |
|----------|-------|--------|
| 1st | Anti-debug / Anti-hook detection | Bypass FIRST — nothing else works until this is cleared |
| 2nd | Packing / Encryption | Unpack/decrypt to get readable binary |
| 3rd | Obfuscation (CFF/VM/opaque predicates) | Deobfuscate OR work around via dynamic analysis |
| 4th | Business logic / Algorithm | NOW analyze the actual target |

**Rule**: Always clear detection layers before attempting analysis layers.

## 4. APPROACH SELECTION MATRIX

| Scenario | Primary Approach | Fallback |
|----------|-----------------|----------|
| Known algorithm, need reproduction | emulation-re | mobile-dynamic-re (capture I/O) |
| Unknown algorithm, need discovery | native-static-re | mobile-dynamic-re (trace execution) |
| Signature with server verification | mobile-dynamic-re (capture params) | web-reverse-engineering (if web API) |
| Anti-tamper prevents hooking | emulation-re (offline, no detection) | Patch detection, retry dynamic |
| Time-sensitive (algorithm rotates) | mobile-dynamic-re (fast capture) | — |
| Complex CFF, static unreadable | emulation-re (trace through CFF) | symbolic-execution-tools (recover CFG) |

## 5. ESCALATION TRIGGERS

If you've been working for >15 min without progress, STOP and check:

1. Am I in the right skill? Re-run this decision tree
2. Am I at the right layer? (fighting detection when should be analyzing logic, or vice versa)
3. Should I switch approach? Load [re-escalation](../re-escalation/SKILL.md) for systematic strategy upgrade

## 6. COMPLEXITY ESTIMATION

Before starting, estimate effort:

| Protection Level | Expected Time | Success Rate | Notes |
|-----------------|---------------|--------------|-------|
| None (clean binary) | 1-2h | 95% | Direct analysis |
| Light obfuscation | 4-8h | 80% | Standard deobfuscation |
| Anti-debug + obfuscation | 1-2d | 65% | Multi-step approach needed |
| CFF + anti-hook + packing | 2-5d | 50% | Consider emulation path |
| Multi-layer VM + environment detection | 1-2w | 35% | Requires combined approach + patience |

If estimated time exceeds available budget, consider: (a) narrowing scope, (b) accepting partial results, (c) trying a completely different angle.
