---
name: emulation-re
description: >-
  Binary emulation for offline reverse engineering. Use when reproducing algorithms via Unicorn/Chomper/unidbg without requiring a real device or risking detection.
---

# SKILL: Emulation-Based Reverse Engineering — Chomper/unidbg Playbook

> **AI LOAD INSTRUCTION**: Expert emulation skill for offline algorithm reproduction using Unicorn Engine, Chomper (Python/macOS), and unidbg (Java/Android). The core philosophy is "adapt the environment to the program, never patch the program" — build an environment close enough to the real device that the target code runs naturally. Base models often make the critical mistake of patching target code to bypass issues, which breaks algorithm correctness. This skill provides the correct "environment adaptation" methodology from 50+ real emulation sessions.

## 0. RELATED ROUTING

- [re-router](../re-router/SKILL.md) — re-assess if emulation is the right approach
- [re-escalation](../re-escalation/SKILL.md) — when emulation is stuck after multiple attempts
- [mobile-dynamic-re](../mobile-dynamic-re/SKILL.md) — when you need real device to capture I/O for validation
- [native-static-re](../native-static-re/SKILL.md) — when you need to understand code before emulating

## 1. CORE PRINCIPLE: Environment Adaptation, Not Code Patching

**THE RULE**: Never modify the target binary/code to make it work in emulation. Instead, build the execution environment (memory layout, system calls, ObjC runtime, external dependencies) to match what the program expects.

**WHY**: Patching code risks breaking the algorithm. A sign function patched to skip an init step may produce wrong signatures. The correct approach is to provide what the init step needs.

| ❌ WRONG Approach | ✅ CORRECT Approach |
|-------------------|---------------------|
| NOP out a crashing instruction | Provide the data/register state it expects |
| Skip init_array entry that hangs | Emulate what that init_array sets up |
| Patch conditional branch | Satisfy the condition naturally |
| Return fake value from sub-call | Implement the sub-call's actual logic |
| Comment out "unnecessary" code | Understand why it exists and provide its dependencies |

**Only exception**: FP16/NEON instructions that Unicorn doesn't support — these can be intercepted and results provided via callback, as they're compute operations not algorithm logic.

## 2. TOOL SELECTION — Chomper vs unidbg

| Dimension | Chomper | unidbg |
|-----------|---------|--------|
| Language | Python | Java |
| Engine | Unicorn (ARM64) | Unicorn (ARM/ARM64) + Dynarmic |
| Best for | iOS Mach-O, quick prototyping | Android .so, production use |
| ObjC support | Manual (need to build ObjC runtime shim) | N/A (Android) |
| JNI support | N/A | Built-in JNI environment |
| Hook mechanism | Unicorn hooks + Python interceptors | Built-in hooking API |
| Community | Smaller, Chinese-focused | Larger, more examples |
| Startup speed | Fast (Python) | Slower (JVM) |
| macOS dev | Native | Needs JDK setup |

**Decision rule**:
- iOS ARM64 binary → **Chomper** (native macOS, Python, direct Mach-O loading)
- Android .so → **unidbg** (built-in JNI, linker, Android syscall emulation)
- Need quick prototype → **Chomper** (less boilerplate)
- Need production stability → **unidbg** (more mature error handling)

## 3. CHOMPER WORKFLOW (iOS ARM64)

### 3.1 Basic Setup

```python
from chomper import Chomper
from chomper.types import ARCH_ARM64

# Initialize emulator
emu = Chomper(arch=ARCH_ARM64)

# Load target binary
emu.load_module("/path/to/AwemeCore")

# Hook unsupported instructions (FP16 etc.)
@emu.interceptor("_problematic_func")
def skip_fp16(emu):
    # Provide expected result instead of executing unsupported instruction
    emu.set_return_value(expected_value)
```

### 3.2 ObjC Runtime Simulation

```python
# ObjC method dispatch requires runtime simulation
# Key structures to provide:
# 1. Class registry (objc_classes)
# 2. Selector table (SEL names → IMP addresses)  
# 3. msgSend dispatch

@emu.interceptor("_objc_msgSend")
def handle_msgSend(emu):
    receiver = emu.read_reg("x0")
    selector = emu.read_string(emu.read_reg("x1"))
    
    if selector == "sharedInstance":
        # Return pre-allocated singleton
        emu.set_return_value(singleton_addr)
    elif selector == "objectForKey:":
        key = emu.read_objc_string(emu.read_reg("x2"))
        # Provide expected config values
        emu.set_return_value(config_map.get(key, 0))
```

### 3.3 Handling init_array

```python
# init_array contains constructors called before main()
# Strategy: run them sequentially, intercept problematic ones

# List all init_array entries
init_entries = emu.get_init_array("AwemeCore")

for i, entry in enumerate(init_entries):
    try:
        emu.call_address(entry)
    except Exception as e:
        print(f"init_array[{i}] at {hex(entry)} failed: {e}")
        # Don't skip blindly — understand what it initializes
        # Options:
        # 1. Provide missing dependency and retry
        # 2. Manually set up what this entry would have initialized
        # 3. Skip ONLY if confirmed unrelated to target algorithm
```

## 4. UNIDBG WORKFLOW (Android .so)

### 4.1 Basic Setup

```java
// Create Android ARM64 emulator
AndroidEmulator emulator = AndroidEmulatorBuilder
    .for64Bit()
    .setProcessName("com.example.app")
    .build();

Memory memory = emulator.getMemory();
memory.setLibraryResolver(new AndroidResolver(23)); // API level

VM vm = emulator.createDalvikVM();
vm.setVerbose(true);

// Load target library
DalvikModule dm = vm.loadLibrary(new File("libsecurity.so"), false);
dm.callJNI_OnLoad(emulator);
```

### 4.2 JNI Method Invocation

```java
// Find and call native method
DvmClass clazz = vm.resolveClass("com/example/Security");
DvmObject<?> result = clazz.callStaticJniMethodObject(
    emulator,
    "sign(Ljava/lang/String;J)Ljava/lang/String;",
    new StringObject(vm, inputData),
    timestamp
);
System.out.println("Sign result: " + result.getValue());
```

### 4.3 Syscall and Environment Hooks

```java
// Hook file access (app reads config files)
emulator.getSyscallHandler().addIOResolver(new IOResolver() {
    @Override
    public FileResult resolve(Emulator emulator, String path, int oflags) {
        if (path.equals("/proc/self/maps")) {
            // Return clean maps (hide emulator)
            return FileResult.success(new ByteArrayFileIO(oflags, path, cleanMaps));
        }
        return null; // default handling
    }
});
```

## 5. CRITICAL ISSUES & SOLUTIONS

### 5.1 FP16/NEON Unsupported Instructions

**Problem**: Unicorn doesn't support some ARM NEON/FP16 instructions → crash at unknown instruction.

**Solution**: Hook at the function level that contains the instruction:
```python
@emu.interceptor(address_of_fp16_function)
def handle_fp16(emu):
    # Option A: Compute the result in Python
    input_val = emu.read_reg("x0")
    result = fp16_to_float(input_val)  # implement in Python
    emu.set_return_value(float_to_arm(result))
    
    # Option B: If function is not algorithmic (e.g., logging/telemetry)
    # emu.set_return_value(0)  # Only if confirmed irrelevant
```

### 5.2 Control Flow Flattening (CFF) in Emulation

**Problem**: CFF uses a state variable + giant switch. Emulation works through it naturally (unlike static analysis), but may be slow.

**Strategy**:
1. Let emulation run through CFF — it resolves naturally
2. If too slow, identify the state variable and trace its values
3. Use traced values to build a simplified execution path

### 5.3 Missing External Dependencies

**Problem**: Target calls functions in other libraries not loaded.

**Strategy**:
```python
# Provide stubs for external functions
@emu.interceptor("_SecRandomCopyBytes")
def fake_random(emu):
    buf = emu.read_reg("x1")
    count = emu.read_reg("x2")
    # Provide deterministic "random" for reproducibility
    emu.write_memory(buf, b'\x41' * count)
    emu.set_return_value(0)  # success

@emu.interceptor("_CFAbsoluteTimeGetCurrent")
def fake_time(emu):
    emu.set_return_value(known_timestamp)
```

### 5.4 Empty/Wrong Results

**Diagnostic checklist when emulation returns nil/wrong output**:

1. **Missing initialization**: Did all required init_array entries run?
2. **Wrong field values**: Are configuration fields (from ObjC properties / Java fields) set correctly?
3. **Timing dependency**: Does the algorithm use current time? Provide matching timestamp
4. **Missing callbacks**: Does it expect an async callback to provide data?
5. **State machine**: Is there a prerequisite call that sets internal state?
6. **URL/path format**: Does it validate input format before processing?

### 5.5 Validation — Comparing with Real Device

```
Validation workflow:
1. Use Frida on real device to capture: exact inputs + outputs at target function
2. Feed same inputs to emulator
3. Compare byte-by-byte
4. If mismatch:
   - Diff at which point output diverges
   - Binary search: which intermediate call produces different results
   - That call's dependency is what you're missing
```

## 6. SIGNATURE ALGORITHM REPRODUCTION — Complete Workflow

This is the most common use case (抖音X-Argus, 去哪儿签名, etc.):

```
Phase 1: STATIC RECON
├── Load in IDA → find sign entry point (string xref: "X-Argus", "sign", etc.)
├── Trace call graph downward: entry → hash_init → update → finalize
└── Identify: input format, output format, key material source

Phase 2: ENVIRONMENT SETUP
├── Load binary in emulator
├── Run init_array (fix issues per §5)
├── Provide ObjC runtime / JNI environment
└── Set up required configuration values (app version, device ID, etc.)

Phase 3: FIRST CALL ATTEMPT
├── Set up input parameters (match what Frida captured)
├── Call target function
├── If crash → diagnose (§5), provide missing dependency
└── If empty result → check initialization state (§5.4)

Phase 4: ITERATE UNTIL MATCH
├── Compare output with Frida capture
├── If mismatch → binary search for divergence point
├── Fix environment at divergence point
└── Repeat until byte-exact match

Phase 5: PRODUCTION
├── Clean up: remove debug hooks, minimize environment
├── Document: required inputs, field meanings, version sensitivity
└── Test: multiple input variations produce correct outputs
```

## 7. STOP CONDITIONS (specific to emulation)

| Signal | Action |
|--------|--------|
| Emulator hangs (infinite loop in CFF/init) | Set instruction count limit; identify loop variable |
| >300s on single call with no output | Analyze: stuck in CFF? missing branch condition? |
| 5+ external dependencies unresolvable | Target may be too coupled — consider dynamic capture instead |
| Output matches for some inputs but not others | Input-dependent code path — need to trace the different path |
| Same wrong output after 3 environment fixes | Step back: are you calling the right function? |

When stuck → Load [re-escalation](../re-escalation/SKILL.md)
