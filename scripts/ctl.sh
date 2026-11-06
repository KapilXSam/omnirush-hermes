#!/usr/bin/env bash
# ctl.sh — control and inspect the omnirush-proxy service.
#   ctl.sh status | start | stop | restart | logs [n] | test | reauth | version
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.omnirush.proxy"
UNIT="omnirush-proxy"
PORT="${OMNIRUSH_PROXY_PORT:-20129}"
URL="http://127.0.0.1:$PORT/v1"
KEY="${OMNIRUSH_PROXY_KEY:-sk-omnirush}"
STORE="$HOME/.omnirush-proxy/tokens.json"
SEED="$HOME/.omnirush2api/tokens.json"
LOGDIR="$REPO/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNITFILE="$HOME/.config/systemd/user/$UNIT.service"
IS_MAC=0; [ "$(uname -s)" = "Darwin" ] && IS_MAC=1

svc_pid() {
  # NOTE: capture before grep — `launchctl list | grep -q` trips pipefail via SIGPIPE.
  if [ "$IS_MAC" -eq 1 ]; then
    launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1}' || true
  else
    systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || true
  fi
}

case "${1:-status}" in
  start)
    if [ "$IS_MAC" -eq 1 ]; then launchctl load "$PLIST" && echo "loaded $LABEL"
    else systemctl --user start "$UNIT" && echo "started $UNIT"; fi
    sleep 3; exec "$0" status ;;
  stop)
    if [ "$IS_MAC" -eq 1 ]; then launchctl unload "$PLIST" && echo "unloaded $LABEL"
    else systemctl --user stop "$UNIT" && echo "stopped $UNIT"; fi ;;
  restart)
    if [ "$IS_MAC" -eq 1 ]; then
      launchctl unload "$PLIST" 2>/dev/null || true; sleep 1
      launchctl load "$PLIST" && echo "restarted $LABEL"
    else systemctl --user restart "$UNIT" && echo "restarted $UNIT"; fi
    sleep 3; exec "$0" status ;;
  status)
    echo "--- service ---"
    pid="$(svc_pid)"
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then echo "  running (pid $pid)"; else echo "  not running"; fi
    echo "--- health ($URL) ---"
    if curl -s --max-time 8 "$URL/health"; then echo; else echo "  unreachable"; fi ;;
  logs)
    n="${2:-30}"
    [ -f "$LOGDIR/server.log" ] && tail -n "$n" "$LOGDIR/server.log" || echo "no log at $LOGDIR/server.log"
    if [ -s "$LOGDIR/server.err.log" ]; then echo "--- stderr ---"; tail -n 10 "$LOGDIR/server.err.log"; fi ;;
  test)  exec "$REPO/scripts/test-proxy.sh" ;;
  version)
    curl -s --max-time 8 "$URL/v1/models" -H "authorization: Bearer $KEY" || echo "unreachable" ;;
  reauth)
    command -v omnirush2api >/dev/null || { echo "install it first: npm install -g omnirush2api"; exit 1; }
    echo "Starting OmniRush device login (approve it in your browser if asked)…"
    omnirush2api login || exit 1
    cp "$SEED" "$STORE" && chmod 600 "$STORE"
    echo "credentials refreshed in the proxy store"
    exec "$0" restart ;;
  *)
    echo "usage: ctl.sh {status|start|stop|restart|logs [n]|test|reauth|version}"; exit 1 ;;
esac
