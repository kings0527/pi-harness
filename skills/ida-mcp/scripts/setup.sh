#!/usr/bin/env bash
# setup.sh — one-time environment setup for the IDA Pro MCP automation stack.
#
# For AGENTS: you normally DON'T need this. `ida.py` auto-starts a headless IDA
# daemon on demand. Use this only for one-time install / diagnostics.
#
# Subcommands:
#   setup.sh health            Full environment + live-server check (start here)
#   setup.sh install-idalib    One-time: pip-install & activate the idapro python module
#                              (required for headless auto-start)
#   setup.sh env               Print the IDADIR export (auto-detection usually makes this unneeded)
#   setup.sh install-plugin    Optional: install the GUI plugin (~/.idapro/plugins) for
#                              interactive use inside the IDA app (serves :13337)
#   setup.sh serve <binary>    Manual headless server on :8745 (ida.py does this for you)
#   setup.sh uninstall-plugin  Remove the GUI plugin
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Locate IDA install ------------------------------------------------------
find_idadir() {
  if [[ -n "${IDADIR:-}" && -f "$IDADIR/libidalib.dylib" ]]; then
    echo "$IDADIR"; return 0
  fi
  for c in \
    "/Applications/iaa.app/Contents/MacOS" \
    "/Applications/IDA Professional.app/Contents/MacOS" \
    "/Applications/IDA Pro.app/Contents/MacOS" \
    "$HOME/Applications/iaa.app/Contents/MacOS"; do
    if [[ -f "$c/libidalib.dylib" || -f "$c/libida.dylib" ]]; then
      echo "$c"; return 0
    fi
  done
  return 1
}

find_mcp_cli() {
  command -v ida-pro-mcp 2>/dev/null && return 0
  python3 -c "import ida_pro_mcp" 2>/dev/null && { echo "python3 -m ida_pro_mcp"; return 0; }
  return 1
}

cmd="${1:-health}"; shift || true

case "$cmd" in
  install-plugin)
    cli="$(find_mcp_cli)" || { echo "ERROR: ida-pro-mcp not installed. Run: pip install ida-pro-mcp"; exit 1; }
    echo ">> Installing IDA GUI plugin via: $cli"
    $cli --install ida-plugin
    echo ">> Done. Restart IDA, then Edit > Plugins > MCP (Ctrl-Alt-M) to serve on :13337 (interactive use)."
    echo ">> NOTE: agents don't need this — ida.py auto-starts a headless daemon."
    ;;

  install-idalib)
    idadir="$(find_idadir)" || { echo "ERROR: IDA install not found. Set IDADIR."; exit 1; }
    echo ">> IDADIR=$idadir"
    if [[ -d "$idadir/idalib/python" ]]; then
      echo ">> pip install $idadir/idalib/python"
      pip install "$idadir/idalib/python"
      echo ">> activating idalib"
      python3 "$idadir/py-activate-idalib.py" -d "$idadir" || \
        python3 "$idadir/idalib/python/py-activate-idalib.py" -d "$idadir" || true
    else
      echo "NOTE: idalib/python not found under $idadir; headless mode may be unavailable."
    fi
    ;;

  env)
    idadir="$(find_idadir)" || { echo "ERROR: IDA install not found. Set IDADIR."; exit 1; }
    echo "export IDADIR=\"$idadir\""
    echo "# add the above to ~/.zshrc or ~/.bashrc for headless idalib mode"
    ;;

  health)
    idadir="$(find_idadir || true)"
    echo "IDA install : ${idadir:-NOT FOUND (set IDADIR)}"
    cli="$(find_mcp_cli || true)"
    echo "MCP CLI     : ${cli:-NOT installed (pip install ida-pro-mcp)}"
    if python3 -c "import idapro" 2>/dev/null || IDADIR="${idadir:-}" python3 -c "import idapro" 2>/dev/null; then
      echo "idapro mod  : importable (headless auto-start ready)"
    else
      echo "idapro mod  : NOT importable (run: setup.sh install-idalib)"
    fi
    loader="$HOME/.idapro/plugins/ida_mcp.py"
    if [[ -e "$loader" ]]; then echo "GUI plugin  : installed ($loader)"; else echo "GUI plugin  : not installed (optional; agents don't need it)"; fi
    python3 "$SCRIPT_DIR/ida.py" --health || true
    ;;

  serve)
    bin="${1:-}"
    idadir="$(find_idadir)" || { echo "ERROR: IDA install not found. Set IDADIR."; exit 1; }
    export IDADIR="$idadir"
    if ! python3 -c "import idapro" 2>/dev/null; then
      echo "ERROR: 'idapro' python module not importable. Run: setup.sh install-idalib"; exit 1
    fi
    echo ">> Manual headless idalib MCP on 127.0.0.1:8745 (IDADIR=$idadir)"
    echo ">> (agents normally let ida.py manage this automatically)"
    if [[ -n "$bin" ]]; then
      echo ">> Loading binary: $bin"
      exec idalib-mcp --host 127.0.0.1 --port 8745 "$bin"
    else
      exec idalib-mcp --host 127.0.0.1 --port 8745
    fi
    ;;

  uninstall-plugin)
    cli="$(find_mcp_cli)" || { echo "ERROR: ida-pro-mcp not installed."; exit 1; }
    $cli --uninstall ida-plugin
    ;;

  *)
    echo "usage: setup.sh {health|install-idalib|env|install-plugin|serve <binary>|uninstall-plugin}"; exit 2
    ;;
esac
