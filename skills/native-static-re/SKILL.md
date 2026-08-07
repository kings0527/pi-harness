---
name: native-static-re
description: >-
  Native binary static analysis with IDA/Ghidra. Use when decompiling ARM64/x86 binaries, recovering symbols, analyzing obfuscated code, or building call graphs for algorithm understanding.
---

# SKILL: Native Binary Static Analysis — IDA/Ghidra Expert Playbook

> **AI LOAD INSTRUCTION**: Expert static analysis skill for native binaries using IDA Pro (via MCP), Ghidra, and rizin. Covers ARM64 Mach-O analysis, OLLVM/Hikari deobfuscation, symbol recovery, CFF dispatcher analysis, and systematic call graph exploration. The IDA MCP server provides direct programmatic access to IDA's analysis capabilities — USE IT for all IDA operations rather than manual steps. Base models often waste time reading obfuscated code linearly instead of using xrefs and call graphs to navigate efficiently.

## 0. RELATED ROUTING

- [re-router](../re-router/SKILL.md) — re-assess if static analysis is the right approach
- [re-escalation](../re-escalation/SKILL.md) — when static analysis is blocked by heavy obfuscation
- [emulation-re](../emulation-re/SKILL.md) — when code is too obfuscated to read statically, trace dynamically
- [mobile-dynamic-re](../mobile-dynamic-re/SKILL.md) — complement static with runtime behavior
- [code-obfuscation-deobfuscation](../code-obfuscation-deobfuscation/SKILL.md) — detailed deobfuscation techniques
- [symbolic-execution-tools](../symbolic-execution-tools/SKILL.md) — automated constraint solving

## 1. IDA MCP WORKFLOW — Primary Analysis Path

The IDA MCP server provides these tools (use them via MCP calls):

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `decompile` | Hex-Rays decompilation of function | First step: understand function logic |
| `disasm` | Raw disassembly at address | When decompilation is misleading or CFF obfuscated |
| `xrefs_to` | Cross-references TO an address | Find who calls a function / uses a string |
| `xrefs_to_field` | Xrefs to struct field | Track field access patterns |
| `callees` | Functions called by target | Map what a function depends on |
| `callgraph` | Full call graph | Understand module structure |
| `list_funcs` | List all functions | Overview of binary |
| `lookup_funcs` | Search functions by name pattern | Find target by name/string |
| `find_regex` | Regex search in disassembly | Find string literals, constants, patterns |
| `find` | Search for byte patterns | Find crypto constants, magic numbers |
| `find_bytes` | Search specific byte sequence | Locate known signatures |
| `imports` | List imported functions | Understand external dependencies |
| `basic_blocks` | Get CFG basic blocks | Analyze control flow |
| `get_bytes` | Read raw bytes at address | Extract embedded data/keys |
| `get_string` | Read string at address | Extract string literals |
| `rename` | Rename function/variable | Mark analyzed functions |
| `set_type` | Set type annotation | Improve decompilation quality |
| `set_comments` | Add comments | Document findings |
| `stack_frame` | View stack frame layout | Understand local variables |

### Standard Analysis Chain:

```
1. lookup_funcs("sign") / find_regex("X-Argus|signature|encrypt")
   └── Find target function(s)

2. decompile(target_address)
   └── Read pseudocode, understand algorithm

3. xrefs_to(target_address)
   └── Find callers → understand calling context and parameters

4. callees(target_address)
   └── Map sub-functions → understand algorithm components

5. For each interesting callee:
   └── decompile → understand sub-algorithm
   
6. rename + set_comments to document findings
```

## 2. ARM64 MACH-O ANALYSIS PATTERNS

### 2.1 Identifying ObjC Methods

ObjC methods in Mach-O have distinctive patterns:
- Names stored in `__objc_methname` section
- Class structures in `__objc_data`
- Method lists point to implementation addresses

```
// Finding ObjC method implementations:
1. find_regex in __objc_methname for method name
2. xrefs_to that string → finds method_t structure
3. Read method_t → get IMP (implementation pointer)
4. decompile IMP address
```

### 2.2 Swift Binary Patterns

Swift functions have mangled names: `$s` prefix (Swift 5+)
```
// Swift demangling:
// $s7MyClass4signySSSS_SitF → MyClass.sign(_: String, _: Int) -> String
// Use: lookup_funcs("$s.*[Ss]ign") to find sign-related Swift functions
```

### 2.3 C++ Name Patterns

```
// C++ mangled: _ZN9ClassName10methodNameEPKcj
// Demangle: ClassName::methodName(char const*, unsigned int)
// Use: lookup_funcs("_ZN.*[Ss]ign") or lookup_funcs("_ZN.*[Ee]ncrypt")
```

## 3. OBFUSCATION RECOGNITION & RESPONSE

### 3.1 Control Flow Flattening (CFF)

**Identification** (via decompile output):
```c
// CFF signature: giant switch on state variable
int state = initial_state;
while (1) {
    switch (state) {
        case 0x1A3B: /* ... */ state = 0x4C2D; break;
        case 0x4C2D: /* ... */ state = 0x7E1F; break;
        // ... dozens/hundreds of cases
    }
}
```

**Analysis strategy**:
1. Identify the state variable (usually first local or specific register)
2. Use `basic_blocks` to get full CFG
3. Extract state transitions from each case
4. Reconstruct original flow: follow state sequence for specific input
5. OR: Use emulation to trace actual execution path (→ emulation-re)

### 3.2 OLLVM/Hikari Patterns

| Obfuscation | IDA Symptom | Response |
|-------------|-------------|----------|
| String Encryption | No readable strings; `__decrypt_string` calls | Hook decrypt function at runtime, OR find decrypt routine and apply |
| Indirect Branches | `blr x8` with computed addresses | Trace at runtime; or symbolic execution |
| Bogus Control Flow | Unreachable blocks, opaque predicates | Ignore dead blocks; focus on reachable paths |
| Function Splitting | Small functions calling each other in chain | Follow call chain; reconstruct full algorithm |
| Substitution | Simple operations replaced with complex equivalents | Simplify: look at inputs/outputs, not intermediate steps |

### 3.3 String Decryption

```
// Pattern: encrypted string table + decrypt function
// 1. Find decrypt function (often called from many places)
find_regex("decrypt_string|deobfuscate|xor_decode")

// 2. Understand decrypt algorithm (usually XOR/RC4/custom)
decompile(decrypt_func_addr)

// 3. Options:
//    A) Script the decryption in Python and batch-apply
//    B) Use emulation to call decrypt for each string
//    C) Hook at runtime (→ mobile-dynamic-re)
```

## 4. SYMBOL RECOVERY

### 4.1 ObjC Symbol Recovery

```
// ObjC binaries retain class/method names even when stripped
// Recovery path:
1. find_regex in __objc_methname → all method selectors
2. find_regex in __objc_classname → all class names
3. Reconstruct: class + selector → method implementation address
4. rename each function with meaningful name
```

### 4.2 From String References

```
// Functions that use distinctive strings can be identified:
1. find_regex("sign|encrypt|hmac|sha256|aes")  // in string literals
2. For each string hit:
   xrefs_to(string_address) → find function that uses it
3. That function likely implements or is related to the named operation
4. rename function based on string context
```

### 4.3 From Crypto Constants

```
// Known cryptographic constants identify algorithms:
// SHA-256 init: 6a09e667 bb67ae85 3c6ef372 a54ff53a
// AES S-box start: 637c777b f26b6fc5 3001672b fed7ab76
// MD5 init: 67452301 efcdab89 98badcfe 10325476

find("6a09e667bb67ae85")  → SHA-256 implementation
find("637c777bf26b6fc5")  → AES implementation
find("67452301efcdab89")  → MD5 implementation
```

## 5. CALL GRAPH EXPLORATION STRATEGY

### Top-Down (when you know the entry point):

```
entry_point
├── callees(entry) → list all sub-functions
│   ├── Crypto-related? → decompile + analyze
│   ├── String manipulation? → likely data prep
│   ├── Network/IO? → likely output formatting
│   └── Unknown? → check callees recursively (max 3 levels)
└── Identify algorithm structure:
    └── Usually: prepare_input → transform → hash/encrypt → format_output
```

### Bottom-Up (when you know the output/API):

```
known_api (e.g., CCCrypt, SHA256_Final)
├── xrefs_to(known_api) → who calls it?
│   └── That caller is the "encrypt" wrapper
├── xrefs_to(wrapper) → who calls the wrapper?
│   └── That's the "sign" function
└── Continue upward until you find the public interface
```

## 6. GHIDRA/RIZIN ALTERNATIVES (when IDA unavailable)

### Ghidra (GUI + scripting):
```bash
# Headless analysis
analyzeHeadless /tmp/project MyProject -import binary.elf -postScript analyze.py

# Python scripting (via Ghidrathon or Jython)
from ghidra.app.decompiler import DecompInterface
decomp = DecompInterface()
decomp.openProgram(currentProgram)
result = decomp.decompileFunction(func, 30, monitor)
print(result.getDecompiledFunction().getC())
```

### rizin/radare2 (CLI):
```bash
# Quick analysis
r2 -A binary
afl          # list functions
pdf @main    # disassemble main
pdd @0x1234  # decompile (with r2ghidra plugin)
axt @0x1234  # xrefs to address
agCd         # call graph (dot format)
```

## 7. WORKFLOW — Complete Static Analysis

```
1. INITIAL SURVEY
   ├── list_funcs → function count, name patterns
   ├── imports → external dependencies, crypto libraries
   ├── find_regex for target strings ("sign", "encrypt", URLs)
   └── Assessment: stripped? obfuscated? which languages?

2. TARGET IDENTIFICATION
   ├── String-based: find_regex → xrefs_to → find user of string
   ├── Import-based: xrefs_to(crypto_import) → find caller
   ├── Export-based: lookup_funcs("_public_api_name")
   └── Result: list of candidate functions

3. DEEP ANALYSIS (per candidate)
   ├── decompile → read pseudocode
   ├── If CFF: → emulation trace or basic_blocks + state extraction
   ├── If clear: → understand algorithm, map data flow
   ├── callees → map sub-functions
   └── rename + set_comments to document

4. ALGORITHM RECONSTRUCTION
   ├── Document: inputs, outputs, key material, algorithm steps
   ├── Identify standard algorithms (SHA/AES/HMAC by constants)
   ├── Map custom logic: what's non-standard?
   └── Produce: algorithm specification for reproduction

5. HANDOFF
   ├── → emulation-re: reproduce algorithm offline
   ├── → mobile-dynamic-re: validate with real device
   └── Document all findings for future sessions
```

## 8. STOP CONDITIONS (specific to static analysis)

| Signal | Action |
|--------|--------|
| Decompilation is unreadable (heavy CFF/VM) | Switch to trace-based analysis (→ emulation-re with Stalker) |
| Can't find target function after 20min searching | Try runtime discovery (→ mobile-dynamic-re §2) |
| Function too complex (>500 lines decompiled) | Break into sub-functions; analyze callees individually |
| Key material comes from server/runtime | Can't solve statically; need runtime capture |
| Binary is packed/encrypted | Unpack first (dump from memory at runtime) |

When stuck → Load [re-escalation](../re-escalation/SKILL.md)
