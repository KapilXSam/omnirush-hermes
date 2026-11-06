#!/usr/bin/env bash
# uninstall.sh — remove the service and (optionally) the Hermes provider entry.
#   ./uninstall.sh           stop service, remove provider + aliases
#   ./uninstall.sh --purge   also delete the token store and logs
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.omnirush.proxy"
UNIT="omnirush-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNITFILE="$HOME/.config/systemd/user/$UNIT.service"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

echo "Stopping service…"
if [ "$(uname -s)" = "Darwin" ]; then
  launchctl unload "$PLIST" 2>/dev/null && echo "  unloaded $LABEL" || echo "  not loaded"
  rm -f "$PLIST" && echo "  removed $PLIST"
else
  systemctl --user disable --now "$UNIT" 2>/dev/null && echo "  disabled $UNIT" || echo "  not enabled"
  rm -f "$UNITFILE"; systemctl --user daemon-reload 2>/dev/null || true
  echo "  removed $UNITFILE"
fi

if command -v hermes >/dev/null; then
  echo "Removing Hermes config…"
  hermes config unset providers.omnirush >/dev/null 2>&1 && echo "  provider removed"
  for a in astra sol solpro; do hermes config unset "model_aliases.$a" >/dev/null 2>&1; done
  echo "  aliases removed (astra, sol, solpro)"
  echo "  note: OMNIRUSH_API_KEY left in $(hermes config env-path 2>/dev/null || echo ~/.hermes/.env) — it is a harmless local dummy"
fi

if [ "$PURGE" -eq 1 ]; then
  echo "Purging local state…"
  rm -rf "$HOME/.omnirush-proxy" "$REPO/logs"
  echo "  removed token store and logs"
fi

echo
echo "Uninstalled. The repo at $REPO and the global omnirush2api package were left in place."
echo "  remove the package:  npm uninstall -g omnirush2api"
