#!/usr/bin/env python3
"""ida.py — thin, dependency-free client for the IDA Pro MCP server.

The IDA Pro MCP server (mrexodia/ida-pro-mcp v2) speaks JSON-RPC 2.0 over
HTTP at POST /mcp. It is started either by:
  - the GUI plugin (Edit > Plugins > MCP)  -> default 127.0.0.1:13337
  - the headless idalib server (idalib-mcp) -> default 127.0.0.1:8745

This client auto-discovers a live server, unwraps the response envelope
(result.structuredContent preferred, else result.content[0].text), and
prints clean output for agents/humans.

USAGE
  ida.py --health                       # detect IDA env + live server
  ida.py --tools                        # list available MCP tools
  ida.py <tool> '<json-args>'           # call a tool with JSON arguments
  ida.py <tool> --k v --k2 v2           # call a tool with --key value pairs
  ida.py --decompile a.c=0x1000 b.c=0x2000   # batch decompile to files
  ida.py --decompile-file funcs.txt          # batch decompile (name=addr per line)

ENV
  IDA_MCP_URL   full URL, e.g. http://127.0.0.1:13337/mcp (overrides discovery)
  IDA_MCP_PORT  single port to try first
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

# Ports to probe, in order. Plugin increments from 13337 on conflict; headless
# idalib defaults to 8745. User's legacy wrappers also used 8746.
DEFAULT_PORTS = [13337, 13338, 13339, 8745, 8746, 8747, 8744]
TIMEOUT = 300


def _url_for_port(port: int) -> str:
    return f"http://127.0.0.1:{port}/mcp"


def _post(url: str, payload: dict, timeout: int = TIMEOUT) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _candidate_urls() -> list[str]:
    if os.environ.get("IDA_MCP_URL"):
        return [os.environ["IDA_MCP_URL"]]
    ports = []
    if os.environ.get("IDA_MCP_PORT"):
        try:
            ports.append(int(os.environ["IDA_MCP_PORT"]))
        except ValueError:
            pass
    ports += [p for p in DEFAULT_PORTS if p not in ports]
    return [_url_for_port(p) for p in ports]


def discover(quiet: bool = True) -> str | None:
    """Return the URL of the first live MCP server, or None."""
    for url in _candidate_urls():
        try:
            r = _post(url, {"jsonrpc": "2.0", "method": "tools/list", "id": 1}, timeout=3)
            if isinstance(r, dict) and ("result" in r or "error" in r):
                if not quiet:
                    print(f"[ida] live server: {url}", file=sys.stderr)
                return url
        except Exception:
            continue
    return None


def _unwrap(resp: dict) -> object:
    """Pull the useful payload out of an MCP tools/call response."""
    if "error" in resp:
        raise RuntimeError(json.dumps(resp["error"], ensure_ascii=False))
    result = resp.get("result", {})
    if not isinstance(result, dict):
        return result
    sc = result.get("structuredContent")
    if sc is not None:
        return sc
    content = result.get("content")
    if isinstance(content, list) and content:
        text = content[0].get("text")
        if text is not None:
            # Many tools return JSON-as-text; try to parse for clean output.
            try:
                return json.loads(text)
            except (ValueError, TypeError):
                return text
    return result


def call(tool: str, arguments: dict, url: str | None = None) -> object:
    if url is None:
        url = discover()
        if url is None:
            raise SystemExit(
                "[ida] no live MCP server found.\n"
                "  Start one via the skill setup:\n"
                "    - GUI:      open IDA, Edit > Plugins > MCP (127.0.0.1:13337)\n"
                "    - headless: scripts/setup.sh serve <binary>  (127.0.0.1:8745)\n"
                "  Or set IDA_MCP_URL / IDA_MCP_PORT."
            )
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    return _unwrap(_post(url, payload))


def list_tools(url: str | None = None) -> list[dict]:
    if url is None:
        url = discover()
        if url is None:
            raise SystemExit("[ida] no live MCP server found.")
    resp = _post(url, {"jsonrpc": "2.0", "method": "tools/list", "id": 1})
    if "error" in resp:
        raise RuntimeError(json.dumps(resp["error"]))
    return resp.get("result", {}).get("tools", [])


def _emit(obj: object) -> None:
    if isinstance(obj, str):
        print(obj)
    else:
        print(json.dumps(obj, ensure_ascii=False, indent=2))


def _health() -> int:
    print("== IDA MCP health ==")
    # IDA install
    idadir = os.environ.get("IDADIR", "")
    guesses = [
        idadir,
        "/Applications/iaa.app/Contents/MacOS",
        "/Applications/IDA Professional.app/Contents/MacOS",
        "/Applications/IDA Pro.app/Contents/MacOS",
    ]
    ida_home = next(
        (g for g in guesses if g and os.path.exists(os.path.join(g, "libidalib.dylib"))),
        None,
    )
    print(f"IDA install : {ida_home or 'NOT FOUND (set IDADIR)'}")
    print(f"IDADIR env  : {idadir or '(unset)'}")
    # Plugin installed?
    loader = os.path.expanduser("~/.idapro/plugins/ida_mcp.py")
    print(f"GUI plugin  : {'installed' if os.path.lexists(loader) else 'NOT installed'} ({loader})")
    # Live server?
    url = discover(quiet=True)
    if url:
        try:
            tools = list_tools(url)
            print(f"Live server : {url}  ({len(tools)} tools)")
        except Exception as e:
            print(f"Live server : {url}  (tools/list failed: {e})")
    else:
        print("Live server : none (start GUI plugin or headless idalib-mcp)")
    return 0 if url else 1


def _batch_decompile(pairs: list[tuple[str, str]], outdir: str) -> int:
    url = discover()
    if url is None:
        raise SystemExit("[ida] no live MCP server found.")
    os.makedirs(outdir, exist_ok=True)
    ok = 0
    for name, addr in pairs:
        try:
            out = call("decompile", {"addr": addr}, url=url)
            code = out.get("code") if isinstance(out, dict) else None
            if not code and isinstance(out, dict):
                code = out.get("pseudocode") or out.get("text")
            if code:
                fname = name if name.endswith((".c", ".txt")) else name + ".c"
                path = os.path.join(outdir, fname)
                with open(path, "w") as f:
                    f.write(code)
                print(f"{name:24s} {len(code):>8d}  OK  -> {path}")
                ok += 1
            else:
                print(f"{name:24s} {'':>8s}  EMPTY")
        except Exception as e:
            print(f"{name:24s} {'':>8s}  FAIL  {e}")
    print(f"\n{ok}/{len(pairs)} decompiled into {outdir}")
    return 0 if ok else 1


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    if argv[0] == "--health":
        return _health()

    if argv[0] == "--tools":
        for t in list_tools():
            name = t.get("name", "?")
            desc = (t.get("description") or "").strip().splitlines()
            print(f"{name:22s} {desc[0] if desc else ''}")
        return 0

    if argv[0] in ("--decompile", "--decompile-file"):
        outdir = os.environ.get("IDA_OUT", ".")
        pairs: list[tuple[str, str]] = []
        if argv[0] == "--decompile-file":
            if len(argv) < 2:
                raise SystemExit("usage: ida.py --decompile-file funcs.txt")
            with open(argv[1]) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    n, a = line.split("=", 1)
                    pairs.append((n.strip(), a.strip()))
        else:
            for tok in argv[1:]:
                if "=" not in tok:
                    raise SystemExit(f"expected name=addr, got: {tok}")
                n, a = tok.split("=", 1)
                pairs.append((n.strip(), a.strip()))
        return _batch_decompile(pairs, outdir)

    # Generic tool call: ida.py <tool> '<json>'  OR  ida.py <tool> --k v ...
    tool = argv[0]
    rest = argv[1:]
    arguments: dict = {}
    if len(rest) == 1 and rest[0].lstrip().startswith(("{", "[")):
        arguments = json.loads(rest[0])
    elif len(rest) == 1 and rest[0] and not rest[0].startswith("--"):
        # single bare positional -> best-effort common arg name
        arguments = {"addr": rest[0]}
    else:
        i = 0
        while i < len(rest):
            key = rest[i]
            if not key.startswith("--"):
                raise SystemExit(f"expected --key value, got: {key}")
            key = key[2:]
            val = rest[i + 1] if i + 1 < len(rest) else "true"
            # coerce json-ish values
            try:
                val_parsed = json.loads(val)
            except (ValueError, TypeError):
                val_parsed = val
            arguments[key] = val_parsed
            i += 2

    _emit(call(tool, arguments))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
