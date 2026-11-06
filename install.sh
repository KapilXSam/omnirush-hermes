#!/usr/bin/env bash
# install.sh — set up omnirush-proxy on this machine and wire it into Hermes.
#
#   ./install.sh                  full setup (credentials, service, Hermes)
#   ./install.sh --service-only   skip credential fetch and Hermes wiring
#   ./install.sh --no-hermes      everything except the Hermes config
#   ./install.sh --port 20129     listen port (default 20129)
#
# Safe to re-run: every step is idempotent. Never prints credential values.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${OMNIRUSH_PROXY_PORT:-20129}"
KEY="${OMNIRUSH_PROXY_KEY:-sk-omnirush}"
SERVICE_ONLY=0
WIRE_HERMES=1
LABEL="com.omnirush.proxy"
UNIT="omnirush-proxy"
STORE="$HOME/.omnirush-proxy/tokens.json"
SEED="$HOME/.omnirush2api/tokens.json"
LOGDIR="$REPO/logs"

while [ $# -gt 0 ]; do
  case "$1" in
    --service-only) SERVICE_ONLY=1 ;;
    --no-hermes)    WIRE_HERMES=0 ;;
    --port)         PORT="$2"; shift ;;
    -h|--help)      sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  · %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 1. preflight
step "1/5  Preflight"
command -v node >/dev/null || die "node not found — install Node >= 20 (https://nodejs.org)"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "need Node >= 20, found $(node --version)"
[ -f "$REPO/src/proxy.mjs" ] || die "src/proxy.mjs missing — run this from the repo root"
mkdir -p "$LOGDIR"
ok "node $(node --version) at $NODE_BIN"
ok "repo $REPO"

# ---------------------------------------------------------------- 2. credentials
if [ "$SERVICE_ONLY" -eq 0 ]; then
  step "2/5  OmniRush credentials"
  if [ ! -f "$SEED" ]; then
    command -v omnirush2api >/dev/null || {
      info "installing the login helper (omnirush2api)…"
      npm install -g omnirush2api >/dev/null 2>&1 || die "npm install -g omnirush2api failed"
    }
    info "starting the OmniRush device login — approve it in your browser if asked"
    omnirush2api login || die "login failed"
  else
    ok "existing credentials found at $SEED"
  fi
  mkdir -p "$(dirname "$STORE")"
  cp "$SEED" "$STORE"
  chmod 600 "$STORE"
  ok "token store seeded (mode 600) — values never printed"
else
  step "2/5  Credentials (skipped: --service-only)"
  [ -f "$STORE" ] || warn "no token store at $STORE — the proxy will report unhealthy"
fi

# ---------------------------------------------------------------- 3. service
step "3/5  Background service"
if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO/src/proxy.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>OMNIRUSH_PROXY_PORT</key><string>$PORT</string>
    <key>OMNIRUSH_PROXY_KEY</key><string>$KEY</string>
  </dict>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" || die "launchctl load failed"
  ok "launchd agent installed: $PLIST"
else
  UNITDIR="$HOME/.config/systemd/user"
  mkdir -p "$UNITDIR"
  cat > "$UNITDIR/$UNIT.service" <<UNIT_EOF
[Unit]
Description=OmniRush local OpenAI-compatible proxy
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=OMNIRUSH_PROXY_PORT=$PORT
Environment=OMNIRUSH_PROXY_KEY=$KEY
ExecStart=$NODE_BIN $REPO/src/proxy.mjs
Restart=always
RestartSec=10
StandardOutput=append:$LOGDIR/server.log
StandardError=append:$LOGDIR/server.err.log

[Install]
WantedBy=default.target
UNIT_EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT" || die "systemctl enable failed"
  loginctl enable-linger "$USER" 2>/dev/null || warn "could not enable-linger; the service may stop at logout"
  ok "systemd user unit installed: $UNITDIR/$UNIT.service"
fi

# ---------------------------------------------------------------- 4. Hermes
if [ "$WIRE_HERMES" -eq 1 ] && command -v hermes >/dev/null; then
  step "4/5  Hermes wiring"
  ENV_FILE="$(hermes config env-path 2>/dev/null || echo "$HOME/.hermes/.env")"
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  if grep -q '^OMNIRUSH_API_KEY=' "$ENV_FILE" 2>/dev/null; then
    ok "OMNIRUSH_API_KEY already present in $(basename "$ENV_FILE")"
  else
    printf 'OMNIRUSH_API_KEY=%s\n' "$KEY" >> "$ENV_FILE"
    ok "added OMNIRUSH_API_KEY to $(basename "$ENV_FILE")"
  fi

  hermes config set providers.omnirush "{\"name\":\"OmniRush\",\"base_url\":\"http://127.0.0.1:$PORT/v1\",\"key_env\":\"OMNIRUSH_API_KEY\",\"api_mode\":\"chat_completions\",\"model\":\"gpt-6-astra\",\"discover_models\":false,\"models\":{\"gpt-6-astra\":{\"context_length\":200000,\"tools\":true,\"reasoning\":true},\"gpt-6.1-sol\":{\"context_length\":200000,\"tools\":true,\"reasoning\":true},\"gpt-6-sol\":{\"context_length\":128000,\"tools\":true,\"reasoning\":true}}}" >/dev/null
  ok "provider 'omnirush' registered"

  # dotted paths: setting the whole section is refused, --force would delete other aliases
  hermes config set model_aliases.astra  '{"model":"gpt-6-astra","provider":"omnirush"}' >/dev/null
  hermes config set model_aliases.sol    '{"model":"gpt-6-sol","provider":"omnirush"}' >/dev/null
  hermes config set model_aliases.solpro '{"model":"gpt-6.1-sol","provider":"omnirush"}' >/dev/null
  ok "aliases added: astra, sol, solpro (existing aliases untouched)"
else
  step "4/5  Hermes wiring (skipped)"
fi

# ---------------------------------------------------------------- 5. verify
step "5/5  Verification"
sleep 4
HEALTH="$(curl -s --max-time 10 "http://127.0.0.1:$PORT/v1/health" || true)"
case "$HEALTH" in
  *'"status":"healthy"'*) ok "endpoint healthy on http://127.0.0.1:$PORT/v1" ;;
  *) warn "endpoint not healthy yet — check: $REPO/scripts/ctl.sh logs"
     echo "     health response: ${HEALTH:-<none>}" ;;
esac
case "$HEALTH" in
  *'"account_count":0'*) warn "no account loaded — run: omnirush2api login && $REPO/scripts/ctl.sh reauth" ;;
esac

REPLY="$(curl -s --max-time 120 "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"sol","messages":[{"role":"user","content":"Reply with exactly: PROXY_OK"}],"max_tokens":30}' || true)"
case "$REPLY" in
  *PROXY_OK*) ok "upstream round-trip works" ;;
  *) warn "completion failed: ${REPLY:0:300}" ;;
esac

printf '\n\033[1mDone.\033[0m\n\n'
cat <<NEXT
  Use it:        hermes chat -m astra     (or /model astra in a session)
  Status:        $REPO/scripts/ctl.sh status
  Logs:          $REPO/scripts/ctl.sh logs
  Full test:     $REPO/scripts/ctl.sh test
  Re-auth:       $REPO/scripts/ctl.sh reauth
  Uninstall:     $REPO/uninstall.sh [--purge]

  Other clients: http://127.0.0.1:$PORT/v1  ·  key $KEY   (see examples/)
NEXT
