#!/usr/bin/env bash
# setup.sh — install / verify / run the IDA Pro MCP automation environment.
#
# Subcommands:
#   setup.sh install          Install the IDA GUI plugin (user-level ~/.idapro/plugins)
#   setup.sh install-idalib    Install the idapro python module for headless mode
#   setup.sh env               Print export lines for IDADIR (add to your shell rc)
#   setup.sh health            Full environment + live-server check
#   setup.sh serve <binary>    Run the headless idalib MCP server on 127.0.0.1:8745
#   setup.sh uninstall         Remove the GUI plugin
#
# The GUI plugin path is preferred for interactive analysis (open a binary in
# IDA, Edit > Plugins > MCP, server listens on 127.0.0.1:13337). The headless
# path is for fully automated / CI use.
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
  install)
    cli="$(find_mcp_cli)" || { echo "ERROR: ida-pro-mcp not installed. Run: pip install ida-pro-mcp"; exit 1; }
    echo ">> Installing IDA GUI plugin via: $cli"
    $cli --install ida-plugin
    echo ">> Done. Restart IDA, then Edit > Plugins > MCP (Ctrl-Alt-M) to start server on :13337"
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
    loader="$HOME/.idapro/plugins/ida_mcp.py"
    if [[ -e "$loader" ]]; then echo "GUI plugin  : installed ($loader)"; else echo "GUI plugin  : NOT installed (run: setup.sh install)"; fi
    python3 "$SCRIPT_DIR/ida.py" --health || true
    ;;

  serve)
    bin="${1:-}"
    idadir="$(find_idadir)" || { echo "ERROR: IDA install not found. Set IDADIR."; exit 1; }
    export IDADIR="$idadir"
    if ! python3 -c "import idapro" 2>/dev/null; then
      echo "ERROR: 'idapro' python module not importable. Run: setup.sh install-idalib"; exit 1
    fi
    echo ">> Serving headless idalib MCP on 127.0.0.1:8745 (IDADIR=$idadir)"
    if [[ -n "$bin" ]]; then
      echo ">> Loading binary: $bin"
      exec idalib-mcp --host 127.0.0.1 --port 8745 "$bin"
    else
      exec idalib-mcp --host 127.0.0.1 --port 8745
    fi
    ;;

  uninstall)
    cli="$(find_mcp_cli)" || { echo "ERROR: ida-pro-mcp not installed."; exit 1; }
    $cli --uninstall ida-plugin
    ;;

  *)
    echo "usage: setup.sh {install|install-idalib|env|health|serve <binary>|uninstall}"; exit 2
    ;;
esac
