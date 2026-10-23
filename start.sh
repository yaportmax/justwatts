#!/bin/sh
# Starts the openspin server (if not running) and opens the app in Chrome/Chromium/Edge.
# Web Bluetooth needs a secure origin; ride history lives in this origin's browser storage, so keep the port fixed.
cd "$(dirname "$0")" || exit 1
PORT="${OPENSPIN_PORT:-8765}"
export OPENSPIN_PORT="$PORT"
PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python
export PYTHONPATH="$PWD/server${PYTHONPATH:+:$PYTHONPATH}"
URL="http://127.0.0.1:$PORT/"

if ! curl -fs "${URL}api/health" >/dev/null 2>&1; then
  mkdir -p "${OPENSPIN_DATA:-$HOME/.openspin}"
  nohup "$PY" -m openspin serve >"${OPENSPIN_DATA:-$HOME/.openspin}/server.log" 2>&1 &
  sleep 1
fi

case "$(uname -s)" in
  Darwin)
    open -a "Google Chrome" "$URL" 2>/dev/null || open -a "Microsoft Edge" "$URL" 2>/dev/null || open "$URL" ;;
  *)
    for b in google-chrome chromium chromium-browser microsoft-edge; do
      command -v "$b" >/dev/null 2>&1 && { "$b" "$URL" >/dev/null 2>&1 & exit 0; }
    done
    xdg-open "$URL" >/dev/null 2>&1 || echo "Open $URL in Chrome or Edge" ;;
esac
