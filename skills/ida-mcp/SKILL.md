---
name: ida-mcp
description: >-
  Drive IDA Pro programmatically via the ida-pro-mcp server on this machine (decompile, disassemble, xrefs, callgraph, rename, patch, py_eval, debugger). Use whenever you need to analyze a native Mach-O/ELF/PE binary, recover an algorithm, find a function by name/string/constant, or script batch decompilation — and IDA is available locally. Covers environment setup/install, GUI vs headless serving, the ida.py wrapper CLI, and the full tool reference.
---

# SKILL: IDA Pro via MCP — Automated Static/Dynamic Analysis

> **AI LOAD INSTRUCTION**: This machine has IDA Pro + the `ida-pro-mcp` server installed. It exposes ~43–60 analysis tools over JSON-RPC 2.0 at `POST http://127.0.0.1:<port>/mcp`. Prefer these tools over reading disassembly linearly: navigate with `xrefs_to`, `callees`, `callgraph`, and `find*`. Use the bundled `scripts/ida.py` wrapper for one-shot calls and batch work, or call the MCP tools directly if your runtime has the `ida` MCP server configured.

## 0. TL;DR — the 3 commands you need

```bash
S=<this-skill-dir>/scripts          # e.g. skills/ida-mcp/scripts

# 1) Is IDA reachable right now?
python3 $S/ida.py --health          # shows install, plugin, and any live server

# 2) What can I call?
python3 $S/ida.py --tools           # list live tools

# 3) Call a tool (auto-discovers port 13337 GUI / 8745 headless)
python3 $S/ida.py decompile '{"addr":"0x100004000"}'
python3 $S/ida.py lookup_funcs --queries "sign"
```

If `--health` shows **"Live server: none"**, start one — see §2.

## 1. ROUTING

- [native-static-re](../native-static-re/SKILL.md) — static-analysis methodology (obfuscation, symbol recovery, call-graph strategy). **That skill = the playbook; this skill = the concrete IDA interface on this box.**
- [emulation-re](../emulation-re/SKILL.md) — when code is too obfuscated to read statically
- [mobile-dynamic-re](../mobile-dynamic-re/SKILL.md) — validate findings on a real device
- [re-escalation](../re-escalation/SKILL.md) — when static analysis is blocked

## 2. ENVIRONMENT — install & serve

The stack: **IDA Pro app** → **ida-pro-mcp** (pip pkg, provides the `ida_mcp` plugin + `idalib-mcp` headless server + CLI installer). Two ways to get a live server:

### 2A. GUI plugin (preferred for interactive analysis)
```bash
bash $S/setup.sh install          # installs plugin to ~/.idapro/plugins (symlink)
# then: open the binary in IDA, Edit > Plugins > MCP  (hotkey Ctrl-Alt-M / Cmd-Opt-M)
# → server listens on 127.0.0.1:13337  (auto-increments if busy)
```
The plugin analyzes whatever database (.i64) is currently open in IDA. This is the
right mode when a human already has the target loaded.

### 2B. Headless idalib (preferred for full automation / CI)
```bash
bash $S/setup.sh install-idalib   # pip-installs the idapro python module + activates it
eval "$(bash $S/setup.sh env)"    # exports IDADIR (needed by idalib)
bash $S/setup.sh serve /path/to/binary   # serves on 127.0.0.1:8745, loads the binary
```
No GUI needed; `idalib-mcp` opens the binary directly. Requires IDA Pro ≥ 9.0.

### Health / discovery
```bash
bash $S/setup.sh health           # IDA install + MCP CLI + plugin + live server
```
`ida.py` auto-discovers the server across ports `[13337.. , 8745..]`. Override with
`IDA_MCP_URL=http://127.0.0.1:PORT/mcp` or `IDA_MCP_PORT=PORT`.

> **This machine (verified):** IDA at `/Applications/iaa.app/Contents/MacOS`, plugin
> installed at `~/.idapro/plugins/ida_mcp.py`, `ida-pro-mcp` on PATH. `idapro` module
> imports once `IDADIR` is set to the app's MacOS dir.

## 3. CALLING TOOLS — three equivalent ways

**(a) Via the wrapper** (works from any shell, no MCP client needed):
```bash
python3 $S/ida.py <tool> '{"json":"args"}'      # explicit JSON
python3 $S/ida.py <tool> --key value --k2 v2    # key/value (values JSON-coerced)
python3 $S/ida.py decompile 0x100004000         # bare positional → {"addr": ...}
```

**(b) Via raw curl** (the underlying protocol — useful in scripts/other agents):
```bash
curl -s -X POST http://127.0.0.1:13337/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"decompile","arguments":{"addr":"0x100004000"}}}'
```
Response envelope: useful payload is in `result.structuredContent` (preferred) or
`result.content[0].text` (often JSON-as-string). The wrapper unwraps this for you.

**(c) Via a configured MCP client** (if your agent runtime supports it) — add:
```json
{ "mcpServers": { "ida": { "type": "http", "url": "http://127.0.0.1:13337/mcp" } } }
```
Then call tools like `decompile`, `xrefs_to`, … directly as MCP tools.

## 4. TOOL REFERENCE (ida-pro-mcp v2)

Addresses accept hex strings (`"0x100004000"`) or names (`"start"`). Most tools take
a single value **or a list** for batching. Run `python3 $S/ida.py --tools` for the
exact live set (differs slightly by IDA version / debugger availability).

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
| `get_int` / `get_global_value` | `addrs`/`addr\|name` | Read scalar / global |
| `stack_frame` / `read_struct` / `search_structs` | … | Stack vars / structs |

### Annotate & modify (persists in the .i64)
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
| `py_eval` | `code` | Run arbitrary Python in IDA context (idc/idaapi). Use for anything the typed tools don't cover — MBA math, vtable walking, bulk edits. |
| `int_convert` | number | Format conversion helper |

### Debugger (`dbg_*`, only when a debug session is active)
`dbg_start / dbg_exit / dbg_continue / dbg_run_to / dbg_step_into / dbg_step_over`,
breakpoints `dbg_bps / dbg_add_bp / dbg_delete_bp / dbg_toggle_bp`,
registers `dbg_regs* / dbg_gpregs*`, `dbg_stacktrace`, memory `dbg_read / dbg_write`.

## 5. STANDARD ANALYSIS CHAINS

**Find & understand a target (bottom-up from a string/name):**
```bash
python3 $S/ida.py find '{"type":"string","targets":["getFeatureHash","X-Argus"]}'
python3 $S/ida.py xrefs_to '{"addrs":["0x<string_addr>"]}'      # who uses it
python3 $S/ida.py decompile 0x<caller>                          # read it
python3 $S/ida.py callees '{"addrs":["0x<caller>"],"limit":200}'  # its sub-calls
# document as you go:
python3 $S/ida.py rename '{"batch":{"func":[{"addr":"0x...","name":"sign_impl"}]}}'
python3 $S/ida.py set_comments '{"items":[{"addr":"0x...","comment":"HMAC-SHA256 core"}]}'
```

**Identify crypto by constants:**
```bash
python3 $S/ida.py find '{"type":"immediate","targets":["0x6a09e667"]}'  # SHA-256 init
```

**Batch-decompile a set of functions to files** (replaces ad-hoc de2.py/desnaps.py):
```bash
# inline name=addr pairs
IDA_OUT=./out python3 $S/ida.py --decompile q448=0x100e74034 q449=0x100e77c1c
# or from a file (one name=addr per line, # comments allowed)
IDA_OUT=./out python3 $S/ida.py --decompile-file funcs.txt
```

## 6. PITFALLS & TIPS

- **No live server** → `--health` says so. Start GUI plugin (§2A) or headless (§2B).
  The GUI plugin only serves once you trigger Edit > Plugins > MCP with a DB open.
- **Port drift**: plugin picks 13337→13338… if busy; headless is 8745. `ida.py`
  probes both ranges; set `IDA_MCP_PORT` to pin one.
- **Headless needs `IDADIR`** pointing at the app's `Contents/MacOS` (has `libidalib.dylib`).
  `eval "$(bash $S/setup.sh env)"` sets it; add to your shell rc to persist.
- **Large outputs**: `decompile`/`export_funcs` can be big; prefer batch-to-file mode
  and read files, rather than dumping into the conversation.
- **`py_eval` is the universal fallback** for anything not covered by a typed tool
  (e.g. `idc.get_qword`, vtable/MBA resolution, mass renames). With headless `--unsafe`
  it is disabled by default; enable deliberately.
- **Modifications persist** in the open database (.i64) — rename/comment freely to
  leave a trail for the next session or agent.

## 7. FILES IN THIS SKILL

- `scripts/ida.py`   — dependency-free MCP client: `--health`, `--tools`, generic tool
  calls, and `--decompile[-file]` batch mode. Auto-discovers the live server.
- `scripts/setup.sh` — `install | install-idalib | env | health | serve <bin> | uninstall`.
