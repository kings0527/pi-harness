---
name: ida-mcp
description: >-
  Drive IDA Pro headlessly to analyze native binaries (Mach-O/ELF/PE) — decompile, disassemble, xrefs, callgraph, find functions by name/string/constant, rename/comment, patch, py_eval, debugger. Headless-by-default: the bundled ida.py auto-starts a background IDA daemon on demand, so an agent just points at a binary and calls a tool. Use whenever you need to reverse/inspect a compiled binary and IDA is installed locally. Covers when/how the server starts, the ida.py wrapper, and the full v2 tool reference.
---

# SKILL: IDA Pro via MCP — Headless-by-Default for Agents

> **AI LOAD INSTRUCTION**: This machine has IDA Pro + `ida-pro-mcp` installed.
> You do **NOT** manage servers, ports, or IDADIR. Just call `scripts/ida.py`
> with `--binary <path>` and a tool name; it **auto-starts a headless IDA
> daemon in the background**, loads the binary, waits for analysis, runs your
> tool, and **reuses** that daemon for every later call. Prefer the MCP tools
> (`xrefs_to`, `callees`, `callgraph`, `find*`, `decompile`) over reading
> disassembly linearly.

## 0. THE ONLY THING AN AGENT NEEDS

```bash
S=<this-skill-dir>/scripts     # e.g. /home/me/git/pi-harness/skills/ida-mcp/scripts

# Analyze ANY binary — the daemon auto-starts on this first call (~1s for .i64):
python3 $S/ida.py lookup_funcs --queries sign      --binary /path/to/app
python3 $S/ida.py find    '{"type":"string","targets":["X-Argus"]}' --binary /path/to/app
python3 $S/ida.py decompile --addr 0x100004000     --binary /path/to/app
```

Everything else (starting/stopping, ports, IDADIR, install) is automatic or
optional. If a call fails, run `python3 $S/ida.py --status` to see what's live.

## 1. WHEN & HOW THE SERVER STARTS (read this once)

**Model: headless-by-default, lazy, reused, isolated.**

- **WHEN it starts** — lazily, on your **first tool call that has `--binary`**.
  There is no separate "start the server" step. Later calls reuse it (fast).
- **HOW it starts** — `ida.py` runs, detached, in the background:
  `IDADIR=<auto> python3 -m ida_pro_mcp.idalib_server --host 127.0.0.1 --port <free>`
  then polls until analysis is ready (port opens only when ready). IDADIR and the
  right Python are auto-detected.
- **WHICH server it uses** (decision order):
  1. `IDA_MCP_URL` set → use exactly that.
  2. A **live server already has that exact binary loaded** → reuse it read-only
     (this includes any headless server you or a human started earlier, and picks
     up GUI :13337 too).
  3. Otherwise → the **managed headless daemon** (own port from 8765↑, skipping
     busy/foreign ports). If already running, it just `idalib_open`s the new
     binary into it (one daemon serves many binaries).
- **Without `--binary`** → it reuses any live server (prefers the GUI plugin on
  :13337, since a human likely has a DB open). If none, it tells you to pass
  `--binary`. (A fresh headless daemon needs a binary to analyze.)
- **It never disturbs servers you didn't start.** Reuse is read-only; the managed
  daemon uses its own port and is the only thing `--stop` kills.

```bash
python3 $S/ida.py --status    # managed daemon + all live servers + their binaries
python3 $S/ida.py --stop      # stop ONLY the managed headless daemon
```

**First call is slow-ish** (analysis: ~1s for a prepared `.i64`, longer for a raw
stripped Mach-O/ELF). **Subsequent calls are instant.** Prefer passing an existing
IDA database (`.i64`) as `--binary` when you have one — it skips re-analysis.

## 2. THREE WAYS TO CALL (all headless-capable)

**(a) The wrapper — the default for agents:**
```bash
python3 $S/ida.py <tool> '{"json":"args"}'  --binary B   # explicit JSON args
python3 $S/ida.py <tool> --key value --k2 v --binary B   # key/value (JSON-coerced)
python3 $S/ida.py decompile 0x100004000     --binary B   # bare positional → {"addr":...}
```

**(b) Raw curl** — once a server is live (see `--status` for the port), the
protocol is JSON-RPC 2.0 at `POST /mcp`. Useful inside other scripts:
```bash
curl -s -X POST http://127.0.0.1:8765/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"decompile","arguments":{"addr":"0x100004000"}}}'
```
Payload is in `result.structuredContent` (preferred) or `result.content[0].text`
(often JSON-as-string). `ida.py` unwraps this for you.

**(c) A configured MCP client** — if your agent runtime speaks MCP, point it at the
live port and call tools directly:
```json
{ "mcpServers": { "ida": { "type": "http", "url": "http://127.0.0.1:8765/mcp" } } }
```

## 3. ONE-TIME SETUP (only if `--status`/`--health` complains)

`ida.py` self-configures, but headless auto-start needs the `idapro` python module
installed once:
```bash
bash $S/setup.sh health            # shows what's missing
bash $S/setup.sh install-idalib    # pip-install + activate idapro module (one time)
```
Optional extras:
```bash
bash $S/setup.sh install-plugin    # GUI plugin for interactive use inside IDA (:13337)
bash $S/setup.sh env               # prints IDADIR export if you want it persisted
```
Env overrides (rarely needed): `IDA_MCP_URL`, `IDA_MCP_DAEMON_PORT` (default 8765),
`IDA_MCP_PYTHON`, `IDADIR`, `IDA_MCP_READY_TIMEOUT` (default 300s), `IDA_OUT`.

> **This machine (verified):** IDA at `/Applications/iaa.app/Contents/MacOS`;
> `idapro` importable; headless auto-start ready. `ida.py --binary <x>` spins up a
> daemon in ~1s and answers real tool calls.

## 4. TOOL REFERENCE (ida-pro-mcp v2)

Addresses accept hex strings (`"0x100004000"`) or names (`"start"`). Most tools take
a single value **or a list** for batching. Run `python3 $S/ida.py --tools --binary B`
for the exact live set (varies by IDA version / debugger availability).

### Discovery & navigation
| Tool | Args (key ones) | Purpose |
|------|-----------------|---------|
| `list_funcs` | `queries:{filter?,count?}` | List/paginate functions (`filter:"*sign*"`) |
| `lookup_funcs` | `queries:list\|str` | Resolve name↔addr (auto-detects) |
| `list_globals` | `queries` | List global variables |
| `imports` | `offset,count` | List imported functions |
| `find` | `type:'string'\|'immediate'\|'data_ref'\|'code_ref', targets` | Unified search |
| `find_regex` | `pattern,limit,offset` | Case-insensitive regex over strings |
| `find_bytes` | `patterns:"48 8B ?? ??"` | Byte-pattern search (wildcards) |
| `xrefs_to` | `addrs,limit` | Cross-refs TO addr(s) — find callers/users |
| `xrefs_to_field` | `queries` | Xrefs to struct field |
| `callees` | `addrs,limit` | Functions called BY target(s) |
| `callgraph` | `roots,max_depth,max_nodes` | Build call graph |
| `basic_blocks` | `addrs,max_blocks` | CFG basic blocks |

### Read code & data
| Tool | Args | Purpose |
|------|------|---------|
| `decompile` | `addr` | Hex-Rays pseudocode → `.code` |
| `disasm` | `addr,max_instructions,offset` | Disassembly |
| `export_funcs` | `addrs,format:'json'\|'c_header'\|'prototypes'` | Bulk export |
| `get_bytes` | `regions:[{addr,size}]` | Raw bytes |
| `get_string` | `addrs` | Read string literal(s) |
| `get_int` / `get_global_value` | `addrs` / `addr\|name` | Read scalar / global |
| `stack_frame` / `read_struct` / `search_structs` | … | Stack vars / structs |

### Annotate & modify (persists in the loaded database)
| Tool | Args | Purpose |
|------|------|---------|
| `rename` | `batch:{func:[{addr,name}],...}` | Rename funcs/globals/locals/stack |
| `set_comments` | `items:[{addr,comment}]` | Comment (disasm + pseudocode) |
| `set_type` / `declare_type` / `infer_types` | … | Types / prototypes |
| `define_func` / `define_code` / `undefine` | `addr[..end]` | (Re)define code/functions |
| `patch` / `patch_asm` / `put_int` | `patches` / … | Patch bytes / assemble / write int |

### Scripting escape hatch
| Tool | Args | Purpose |
|------|------|---------|
| `py_eval` | `code` | Arbitrary Python in IDA context (idc/idaapi). Use for anything the typed tools don't cover — MBA math, vtable walking, bulk edits. |
| `int_convert` | number | Format conversion helper |

### Session control (headless idalib only — usually automatic)
`idalib_open(input_path)` load a binary · `idalib_list` sessions · `idalib_current`
active binary · `idalib_switch(session_id)` · `idalib_close(session_id)`. `ida.py`
calls these for you; use directly only for advanced multi-binary flows.

### Debugger (`dbg_*`, only when a debug session is active)
`dbg_start / dbg_exit / dbg_continue / dbg_run_to / dbg_step_into / dbg_step_over`,
breakpoints `dbg_bps / dbg_add_bp / dbg_delete_bp / dbg_toggle_bp`,
registers `dbg_regs* / dbg_gpregs*`, `dbg_stacktrace`, memory `dbg_read / dbg_write`.
(Headless idalib is for static analysis; debugger needs the GUI/remote path.)

## 5. STANDARD ANALYSIS CHAINS

**Find & understand a target (bottom-up from a string/name):**
```bash
B=/path/to/app
python3 $S/ida.py find '{"type":"string","targets":["getFeatureHash","X-Argus"]}' --binary $B
python3 $S/ida.py xrefs_to '{"addrs":["0x<string_addr>"]}' --binary $B     # who uses it
python3 $S/ida.py decompile 0x<caller> --binary $B                         # read it
python3 $S/ida.py callees '{"addrs":["0x<caller>"],"limit":200}' --binary $B  # sub-calls
python3 $S/ida.py rename '{"batch":{"func":[{"addr":"0x...","name":"sign_impl"}]}}' --binary $B
python3 $S/ida.py set_comments '{"items":[{"addr":"0x...","comment":"HMAC-SHA256 core"}]}' --binary $B
```

**Identify crypto by constants:**
```bash
python3 $S/ida.py find '{"type":"immediate","targets":["0x6a09e667"]}' --binary $B  # SHA-256 init
```

**Batch-decompile a set of functions to files** (replaces ad-hoc de2.py/desnaps.py):
```bash
IDA_OUT=./out python3 $S/ida.py --decompile q448=0x100e74034 q449=0x100e77c1c --binary $B
IDA_OUT=./out python3 $S/ida.py --decompile-file funcs.txt --binary $B   # name=addr per line
```

## 6. PITFALLS & TIPS

- **First call analyzes the binary** — expect a few seconds (raw stripped binaries
  take longer). Pass a prepared `.i64` as `--binary` to skip re-analysis. Bump
  `IDA_MCP_READY_TIMEOUT` for huge targets.
- **Reuse is automatic**; don't spawn per call. The same daemon serves many binaries
  via `idalib_open`. `--stop` when you're truly done to free memory.
- **`--status` is your debugger** — it lists the managed daemon, every live server,
  and which binary each has loaded. `--health` checks the environment.
- **Large outputs**: prefer `--decompile*` batch-to-file and read files, rather than
  dumping big pseudocode into the conversation.
- **`py_eval` is the universal fallback** for anything not covered by a typed tool
  (`idc.get_qword`, vtable/MBA resolution, mass renames). Disabled under headless
  `--unsafe`; enable deliberately if needed.
- **Modifications persist** in the loaded database — rename/comment freely to leave
  a trail for the next agent/session.
- **GUI is optional**, for humans doing interactive work (`setup.sh install-plugin`,
  then Edit > Plugins > MCP → :13337). Agents don't need it.

## 7. ROUTING

- [native-static-re](../native-static-re/SKILL.md) — static-analysis *methodology*
  (obfuscation, symbol recovery, call-graph strategy). This skill = the concrete
  headless IDA interface; that one = the playbook.
- [emulation-re](../emulation-re/SKILL.md) — when too obfuscated to read statically
- [mobile-dynamic-re](../mobile-dynamic-re/SKILL.md) — validate on a real device
- [re-escalation](../re-escalation/SKILL.md) — when static analysis is blocked

## 8. FILES IN THIS SKILL

- `scripts/ida.py`   — headless-by-default MCP client. Auto-starts/reuses a managed
  daemon, `--status` / `--health` / `--stop`, generic tool calls, `--decompile[-file]`
  batch mode. Accepts `--binary <path>` anywhere on the command line.
- `scripts/setup.sh` — one-time/diagnostic: `health | install-idalib | env |
  install-plugin | serve <bin> | uninstall-plugin`.
