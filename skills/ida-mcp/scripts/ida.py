#!/usr/bin/env python3
"""ida.py — headless-by-default client for the IDA Pro MCP server.

For AGENTS: you do NOT manage the server. Just call a tool and point at a
binary; this script auto-starts a headless IDA (idalib) daemon on demand,
loads the binary, waits until analysis is ready, then runs your tool.

    python3 ida.py decompile --addr 0x100004000 --binary /path/to/app
    python3 ida.py lookup_funcs --queries sign --binary /path/to/app.i64

HOW IT PICKS / STARTS A SERVER  (see also --status)
  1. If IDA_MCP_URL is set, use exactly that (no management).
  2. If a live server already has THAT binary loaded, reuse it (read-only).
  3. Otherwise use a managed headless daemon on 127.0.0.1:8765:
       - not running  -> spawn it detached (IDADIR auto-detected), poll ready
       - running      -> idalib_open/switch the binary into it
  4. With no --binary: reuse any live server (GUI :13337 or headless), else
     error asking for --binary. (A headless daemon needs a binary to analyze.)

WHEN DOES IT START?  Lazily — on the first tool call that needs a server.
Repeated calls reuse the same daemon (fast). Stop it with `--stop`.

COMMANDS
  ida.py --status                     # daemons + live servers + loaded binaries
  ida.py --health                     # env check (IDA install, plugin, python)
  ida.py --tools [--binary B]         # list live tools
  ida.py --stop                       # stop the managed headless daemon
  ida.py <tool> '<json>' [--binary B] # call a tool (JSON args)
  ida.py <tool> --k v [--binary B]    # call a tool (key/value args)
  ida.py --decompile a=0x1 b=0x2 --binary B   # batch decompile to files (IDA_OUT)
  ida.py --decompile-file f.txt --binary B    # batch (name=addr per line)

ENV
  IDA_MCP_URL          full URL, e.g. http://127.0.0.1:13337/mcp (overrides all)
  IDA_MCP_PORT         extra port to probe first
  IDA_MCP_DAEMON_PORT  managed headless port (default 8765)
  IDADIR               IDA install dir (auto-detected if unset)
  IDA_MCP_PYTHON       python interpreter that has ida_pro_mcp+idapro installed
  IDA_MCP_READY_TIMEOUT  seconds to wait for analysis (default 300)
  IDA_OUT              output dir for --decompile* (default .)
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

# Ports we probe for an already-live server, in order.
MANAGED_PORT = int(os.environ.get("IDA_MCP_DAEMON_PORT", "8765"))
# Managed daemon scans this range for a FREE, IDA-verified port starting at MANAGED_PORT.
MANAGED_PORT_RANGE = 20
DISCOVERY_PORTS = [13337, 13338, 13339, 8745, 8746, 8747, 8748] + list(
    range(MANAGED_PORT, MANAGED_PORT + MANAGED_PORT_RANGE)
)
READY_TIMEOUT = int(os.environ.get("IDA_MCP_READY_TIMEOUT", "300"))
TIMEOUT = 300
STATE_FILE = os.path.expanduser("~/.idapro/ida-mcp-daemon.json")
DAEMON_LOG = os.path.expanduser("~/.idapro/ida-mcp-daemon.log")

IDA_APP_GUESSES = [
    "/Applications/iaa.app/Contents/MacOS",
    "/Applications/IDA Professional.app/Contents/MacOS",
    "/Applications/IDA Pro.app/Contents/MacOS",
    os.path.expanduser("~/Applications/iaa.app/Contents/MacOS"),
]


# ------------------------------------------------------------------ transport
def _post(url, payload, timeout=TIMEOUT):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _url(port):
    return f"http://127.0.0.1:{port}/mcp"


def is_live(url, timeout=3):
    """True only if this URL is a genuine IDA MCP server (exposes the `decompile` tool).

    Guards against unrelated JSON/HTTP services squatting a probe port.
    """
    try:
        r = _post(url, {"jsonrpc": "2.0", "method": "tools/list", "id": 1}, timeout=timeout)
    except Exception:
        return False
    if not isinstance(r, dict) or "result" not in r:
        return False
    tools = r.get("result", {}).get("tools", [])
    names = {t.get("name") for t in tools if isinstance(t, dict)}
    return "decompile" in names and "list_funcs" in names


def _candidate_urls():
    if os.environ.get("IDA_MCP_URL"):
        return [os.environ["IDA_MCP_URL"]]
    ports = []
    if os.environ.get("IDA_MCP_PORT"):
        try:
            ports.append(int(os.environ["IDA_MCP_PORT"]))
        except ValueError:
            pass
    ports += [p for p in DISCOVERY_PORTS if p not in ports]
    return [_url(p) for p in ports]


def discover_all():
    return [u for u in _candidate_urls() if is_live(u)]


def _unwrap(resp):
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
            try:
                return json.loads(text)
            except (ValueError, TypeError):
                return text
    return result


def _call_raw(url, tool, arguments, timeout=TIMEOUT):
    return _unwrap(_post(url, {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }, timeout=timeout))


# ------------------------------------------------------------------ IDA env
def find_idadir():
    d = os.environ.get("IDADIR")
    if d and os.path.exists(os.path.join(d, "libidalib.dylib")):
        return d
    for c in IDA_APP_GUESSES:
        if os.path.exists(os.path.join(c, "libidalib.dylib")) or os.path.exists(os.path.join(c, "libida.dylib")):
            return c
    return None


def _python_has_module(py, mod="ida_pro_mcp"):
    try:
        return subprocess.run([py, "-c", f"import {mod}"], capture_output=True, timeout=15).returncode == 0
    except Exception:
        return False


def find_python():
    override = os.environ.get("IDA_MCP_PYTHON")
    if override:
        return override
    for c in [sys.executable, "/opt/homebrew/bin/python3.14",
              shutil.which("python3.14"), shutil.which("python3")]:
        if c and _python_has_module(c):
            return c
    return sys.executable


def _rp(p):
    try:
        return os.path.realpath(p) if p else None
    except Exception:
        return p


# ------------------------------------------------------------------ daemon mgmt
def _read_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _write_state(d):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(d, f, indent=2)


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def server_current_binary(url):
    """realpath of the binary the server currently has active, or None (e.g. GUI)."""
    try:
        cur = _call_raw(url, "idalib_current", {}, timeout=5)
        if isinstance(cur, dict):
            return _rp(cur.get("input_path"))
    except Exception:
        pass
    return None


def _managed_url():
    st = _read_state()
    return _url(st.get("port", MANAGED_PORT))


def _port_free(port):
    """True if nothing is bound to 127.0.0.1:port (so we can safely start there)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) != 0
    finally:
        s.close()


def _pick_managed_port():
    """Reuse our live managed daemon if any in-range; else first free port in range."""
    for p in range(MANAGED_PORT, MANAGED_PORT + MANAGED_PORT_RANGE):
        if is_live(_url(p)):
            return p, True  # already an IDA server we can reuse
    for p in range(MANAGED_PORT, MANAGED_PORT + MANAGED_PORT_RANGE):
        if _port_free(p):
            return p, False
    raise SystemExit(
        f"[ida] no free port in {MANAGED_PORT}-{MANAGED_PORT+MANAGED_PORT_RANGE-1}; "
        "set IDA_MCP_DAEMON_PORT."
    )


def spawn_managed_daemon(binary=None):
    """Start the headless idalib server detached on a free managed port; return url when ready."""
    port, reuse = _pick_managed_port()
    url = _url(port)
    if reuse:
        if binary:
            ensure_binary_loaded(url, _rp(binary))
        return url
    idadir = find_idadir()
    if not idadir:
        raise SystemExit(
            "[ida] IDA install not found. Set IDADIR to the IDA app's Contents/MacOS "
            "(the dir containing libidalib.dylib)."
        )
    py = find_python()
    if not _python_has_module(py):
        raise SystemExit(
            f"[ida] '{py}' cannot import ida_pro_mcp. Install with: pip install ida-pro-mcp\n"
            "  or set IDA_MCP_PYTHON to the interpreter that has it."
        )
    env = dict(os.environ)
    env["IDADIR"] = idadir
    cmd = [py, "-m", "ida_pro_mcp.idalib_server", "--host", "127.0.0.1", "--port", str(port)]
    if binary:
        cmd.append(binary)
    os.makedirs(os.path.dirname(DAEMON_LOG), exist_ok=True)
    logf = open(DAEMON_LOG, "a")
    logf.write(f"\n==== spawn {time.strftime('%F %T')} port={port} binary={binary} py={py} ====\n")
    logf.flush()
    proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT,
                            start_new_session=True, env=env, cwd="/tmp")
    _write_state({"port": port, "pid": proc.pid, "binary": _rp(binary),
                  "log": DAEMON_LOG, "started": time.strftime("%F %T"), "idadir": idadir})
    # poll readiness
    t0 = time.time()
    last = 0
    print(f"[ida] starting headless daemon (pid {proc.pid}, port {port})"
          + (f", analyzing {os.path.basename(binary)}…" if binary else "…"), file=sys.stderr)
    while time.time() - t0 < READY_TIMEOUT:
        if is_live(url, timeout=2):
            print(f"[ida] daemon ready in {int(time.time()-t0)}s -> {url}", file=sys.stderr)
            return url
        if proc.poll() is not None:
            tail = ""
            try:
                tail = open(DAEMON_LOG).read()[-800:]
            except Exception:
                pass
            raise SystemExit(f"[ida] daemon exited early (rc={proc.returncode}). Log tail:\n{tail}")
        waited = int(time.time() - t0)
        if waited - last >= 5:
            print(f"[ida] …still analyzing ({waited}s)", file=sys.stderr)
            last = waited
        time.sleep(1)
    raise SystemExit(f"[ida] daemon not ready within {READY_TIMEOUT}s (see {DAEMON_LOG}).")


def ensure_binary_loaded(url, binary_rp):
    """Make binary_rp the active session on a HEADLESS server (open/switch as needed)."""
    if server_current_binary(url) == binary_rp:
        return
    try:
        listing = _call_raw(url, "idalib_list", {}, timeout=10)
        for s in (listing or {}).get("sessions", []):
            if _rp(s.get("input_path")) == binary_rp:
                _call_raw(url, "idalib_switch", {"session_id": s["session_id"]}, timeout=30)
                return
    except Exception:
        pass
    # not loaded: open it (auto-activates); analysis may take a while for raw binaries
    print(f"[ida] loading {os.path.basename(binary_rp)} into daemon…", file=sys.stderr)
    _call_raw(url, "idalib_open", {"input_path": binary_rp}, timeout=READY_TIMEOUT)


def ensure_server(binary=None):
    """Return a live MCP url with `binary` active. Headless-by-default, auto-start."""
    if os.environ.get("IDA_MCP_URL"):
        url = os.environ["IDA_MCP_URL"]
        if not is_live(url):
            raise SystemExit(f"[ida] IDA_MCP_URL not reachable: {url}")
        if binary:
            ensure_binary_loaded(url, _rp(binary))
        return url

    if binary:
        binary_rp = _rp(binary)
        if not os.path.exists(binary_rp):
            raise SystemExit(f"[ida] binary not found: {binary}")
        # (2) reuse a live server that already has this exact binary (no mutation)
        for u in discover_all():
            if server_current_binary(u) == binary_rp:
                return u
        # (3) managed headless daemon (spawn_managed_daemon reuses in-range live one,
        #     else starts a fresh detached daemon on a free port, then loads+waits)
        return spawn_managed_daemon(binary_rp)

    # (4) no binary: reuse any live server, prefer GUI (human likely has DB open)
    live = discover_all()
    for pref in (13337, 13338, 13339):
        u = _url(pref)
        if u in live:
            return u
    if live:
        return live[0]
    raise SystemExit(
        "[ida] no live server and no --binary given.\n"
        "  Pass --binary <path> to auto-start a headless IDA, or open a DB in IDA GUI\n"
        "  (Edit > Plugins > MCP). See: ida.py --status"
    )


def stop_managed():
    st = _read_state()
    pid = st.get("pid")
    port = st.get("port", MANAGED_PORT)
    killed = False
    if pid and _pid_alive(pid):
        try:
            os.kill(int(pid), 15)
            killed = True
        except Exception as e:
            print(f"[ida] kill {pid} failed: {e}", file=sys.stderr)
    # fallback: whatever OUR managed daemon left listening on its recorded port
    try:
        out = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        for p in out:
            if not pid or int(p) != int(pid):
                os.kill(int(p), 15)
                killed = True
    except Exception:
        pass
    _write_state({})
    print("[ida] managed daemon stopped." if killed else "[ida] no managed daemon running.")
    return 0


# ------------------------------------------------------------------ public API
def call(tool, arguments, binary=None):
    return _call_raw(ensure_server(binary), tool, arguments)


def list_tools(binary=None):
    url = ensure_server(binary)
    resp = _post(url, {"jsonrpc": "2.0", "method": "tools/list", "id": 1})
    if "error" in resp:
        raise RuntimeError(json.dumps(resp["error"]))
    return resp.get("result", {}).get("tools", [])


# ------------------------------------------------------------------ CLI helpers
def _emit(obj):
    print(obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=2))


def _status():
    print("== IDA MCP status ==")
    st = _read_state()
    if st.get("pid"):
        alive = _pid_alive(st["pid"]) and is_live(_url(st.get("port", MANAGED_PORT)))
        print(f"Managed daemon: {'RUNNING' if alive else 'stale/stopped'} "
              f"(pid {st['pid']}, port {st.get('port')}, binary {st.get('binary')})")
    else:
        print(f"Managed daemon: not started (would use port {MANAGED_PORT})")
    print("Live servers:")
    found = False
    for u in _candidate_urls():
        if is_live(u):
            found = True
            b = server_current_binary(u)
            try:
                n = len(list_tools_url(u))
            except Exception:
                n = "?"
            kind = "GUI plugin" if u.endswith("13337/mcp") or "1333" in u else "headless"
            print(f"  {u:32s} {kind:12s} {n} tools  binary={b or '(GUI/unknown)'}")
    if not found:
        print("  (none)")
    print(f"\nIDA install : {find_idadir() or 'NOT FOUND (set IDADIR)'}")
    print(f"python      : {find_python()}")
    return 0


def list_tools_url(url):
    resp = _post(url, {"jsonrpc": "2.0", "method": "tools/list", "id": 1})
    return resp.get("result", {}).get("tools", [])


def _health():
    print("== IDA MCP health ==")
    idadir = find_idadir()
    print(f"IDA install : {idadir or 'NOT FOUND (set IDADIR)'}")
    print(f"IDADIR env  : {os.environ.get('IDADIR') or '(unset, auto-detected above)'}")
    py = find_python()
    print(f"python      : {py} (ida_pro_mcp={'yes' if _python_has_module(py) else 'NO — pip install ida-pro-mcp'})")
    loader = os.path.expanduser("~/.idapro/plugins/ida_mcp.py")
    print(f"GUI plugin  : {'installed' if os.path.lexists(loader) else 'not installed (optional)'}")
    live = discover_all()
    print(f"Live servers: {', '.join(live) if live else 'none (a headless daemon will auto-start on first --binary call)'}")
    return 0


def _batch_decompile(pairs, outdir, binary=None):
    url = ensure_server(binary)
    os.makedirs(outdir, exist_ok=True)
    ok = 0
    for name, addr in pairs:
        try:
            out = _call_raw(url, "decompile", {"addr": addr})
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


def _extract_global_opts(argv):
    """Pull --binary/-b <path> out of argv (may appear anywhere). Returns (argv2, binary)."""
    out, binary, i = [], None, 0
    while i < len(argv):
        a = argv[i]
        if a in ("--binary", "-b") and i + 1 < len(argv):
            binary = argv[i + 1]
            i += 2
            continue
        if a.startswith("--binary="):
            binary = a.split("=", 1)[1]
            i += 1
            continue
        out.append(a)
        i += 1
    return out, binary


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    argv, binary = _extract_global_opts(argv)
    cmd = argv[0] if argv else ""

    if cmd == "--status":
        return _status()
    if cmd == "--health":
        return _health()
    if cmd == "--stop":
        return stop_managed()
    if cmd == "--tools":
        for t in list_tools(binary):
            desc = (t.get("description") or "").strip().splitlines()
            print(f"{t.get('name','?'):22s} {desc[0] if desc else ''}")
        return 0

    if cmd in ("--decompile", "--decompile-file"):
        outdir = os.environ.get("IDA_OUT", ".")
        pairs = []
        if cmd == "--decompile-file":
            if len(argv) < 2:
                raise SystemExit("usage: ida.py --decompile-file funcs.txt --binary B")
            with open(argv[1]) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        n, a = line.split("=", 1)
                        pairs.append((n.strip(), a.strip()))
        else:
            for tok in argv[1:]:
                if "=" not in tok:
                    raise SystemExit(f"expected name=addr, got: {tok}")
                n, a = tok.split("=", 1)
                pairs.append((n.strip(), a.strip()))
        return _batch_decompile(pairs, outdir, binary)

    # generic tool call
    tool = cmd
    rest = argv[1:]
    arguments = {}
    if len(rest) == 1 and rest[0].lstrip().startswith(("{", "[")):
        arguments = json.loads(rest[0])
    elif len(rest) == 1 and rest[0] and not rest[0].startswith("--"):
        arguments = {"addr": rest[0]}
    else:
        i = 0
        while i < len(rest):
            key = rest[i]
            if not key.startswith("--"):
                raise SystemExit(f"expected --key value, got: {key}")
            key = key[2:]
            val = rest[i + 1] if i + 1 < len(rest) else "true"
            try:
                val = json.loads(val)
            except (ValueError, TypeError):
                pass
            arguments[key] = val
            i += 2

    _emit(call(tool, arguments, binary))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
