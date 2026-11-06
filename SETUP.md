# Step-by-step setup

Works on macOS and Linux. On Windows use WSL2 and follow the Linux steps.
Written so that a human **or** an AI agent can follow it verbatim — every step has a
verification command; do not continue past a step whose check fails.

Total time: ~10 minutes, most of it waiting for `npm install`.

---

## Step 0 — Prerequisites

```bash
node --version    # need >= 20
npm --version
git --version
```

If Node is missing: install from <https://nodejs.org> or your package manager.

**Verify:** `node --version` prints `v20.x` or newer.

---

## Step 1 — Get OmniRush credentials

OmniRush has no public API keys — access is OAuth through its own client. The device-flow
helper below performs exactly that login and writes a refresh/access token pair to disk.

```bash
npm install -g omnirush2api
omnirush2api login
```

It prints an account line and two tokens. It also saves them to
`~/.omnirush2api/tokens.json`. **Do not copy those tokens into a chat, a file in this repo,
or an issue.** The proxy reads the file directly.

**Verify:**

```bash
omnirush2api check        # should report the signed-in account
ls -l ~/.omnirush2api/tokens.json
```

If `check` says no credentials, the desktop app's own store cannot help: it holds
`clientToken`/`hostToken`/`ownerToken` and **no** `refreshToken`, which is what this proxy
needs. Re-run `omnirush2api login`.

---

## Step 2 — Install the proxy

```bash
git clone https://github.com/<you>/omnirush-hermes.git ~/omnirush-proxy
cd ~/omnirush-proxy
```

Prefer a non-git copy? Any directory works — the scripts resolve their own location.

**Verify:** `ls src/proxy.mjs` exists.

---

## Step 3 — Seed the token store

The proxy keeps its own copy so the two never fight over refresh-token rotation:

```bash
mkdir -p ~/.omnirush-proxy
cp ~/.omnirush2api/tokens.json ~/.omnirush-proxy/tokens.json
chmod 600 ~/.omnirush-proxy/tokens.json
```

**Verify:** `stat -f '%Lp' ~/.omnirush-proxy/tokens.json` prints `600` (macOS) or
`stat -c '%a' …` on Linux.

---

## Step 4 — First run in the foreground

Run it in a terminal first so you can see it work before it becomes a service:

```bash
cd ~/omnirush-proxy
node src/proxy.mjs
```

Expect a startup banner with the upstream URL, the client version it will present, the
account, and `listening on http://127.0.0.1:20129/v1`.

In a second terminal:

```bash
curl -s http://127.0.0.1:20129/v1/health
curl -s http://127.0.0.1:20129/v1/chat/completions \
  -H 'authorization: Bearer sk-omnirush' -H 'content-type: application/json' \
  -d '{"model":"sol","messages":[{"role":"user","content":"Reply with exactly: PROXY_OK"}]}'
```

**Verify:** health says `"status":"healthy"` with `"account_count":1`, and the completion
returns `PROXY_OK`. Stop the foreground process (Ctrl-C) before installing the service.

---

## Step 5 — Install the background service

```bash
./install.sh --service-only
```

- **macOS:** writes `~/Library/LaunchAgents/com.omnirush.proxy.plist` and loads it
  (starts at login, restarts on crash).
- **Linux:** writes `~/.config/systemd/user/omnirush-proxy.service` and enables it
  (`systemctl --user enable --now omnirush-proxy`). On a headless box run
  `sudo loginctl enable-linger $USER` so it survives logout.

**Verify:** `scripts/ctl.sh status` shows a pid and a healthy endpoint.

---

## Step 6 — Wire Hermes

```bash
# 1. the local key the proxy expects (a dummy value — not an OmniRush secret)
grep -q OMNIRUSH_API_KEY ~/.hermes/.env 2>/dev/null || \
  echo 'OMNIRUSH_API_KEY=sk-omnirush' >> ~/.hermes/.env

# 2. register the provider
hermes config set providers.omnirush '{"name":"OmniRush","base_url":"http://127.0.0.1:20129/v1","key_env":"OMNIRUSH_API_KEY","api_mode":"chat_completions","model":"gpt-6-astra","discover_models":false,"models":{"gpt-6-astra":{"context_length":200000,"tools":true,"reasoning":true},"gpt-6.1-sol":{"context_length":200000,"tools":true,"reasoning":true},"gpt-6-sol":{"context_length":128000,"tools":true,"reasoning":true}}}'

# 3. aliases — one dotted path per alias (see the note below)
hermes config set model_aliases.astra  '{"model":"gpt-6-astra","provider":"omnirush"}'
hermes config set model_aliases.sol    '{"model":"gpt-6-sol","provider":"omnirush"}'
hermes config set model_aliases.solpro '{"model":"gpt-6.1-sol","provider":"omnirush"}'
```

> **Why dotted paths?** `hermes config set model_aliases '<json>'` is rejected when the
> section already exists, and `--force` replaces the whole section — which would delete
> aliases you already had (OpenRouter, xkiro, …). Dotted paths add without clobbering.

**Verify:**

```bash
hermes config get providers.omnirush
hermes config get model_aliases
```

---

## Step 7 — End-to-end verification

```bash
hermes chat -q "Reply with exactly this and nothing else: HERMES_OMNIRUSH_OK" -m astra
hermes chat -q "Use your terminal tool to run: echo TOOLCALL_WORKS && uname -s" -m sol
```

**Verify:** the first prints `HERMES_OMNIRUSH_OK`. The second must show a real tool call
(`preparing terminal…`, `$ echo TOOLCALL_WORKS`) and a correct answer — that proves the
tool-call translation, not just chat.

Then run the bundled suite:

```bash
scripts/ctl.sh test
```

---

## Step 8 — Use it

- Hermes CLI: `hermes chat -m astra`
- Hermes desktop/TUI/gateway: `/model astra`
- Anything else OpenAI-compatible: base URL `http://127.0.0.1:20129/v1`, key `sk-omnirush`
  (see [examples/](examples/))

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403 official_client_required` | gateway wants a newer official client version | `npm view omnirush version`, then set `OMNIRUSH_CLIENT_VERSION` in the service file and restart |
| `404 unsupported_model_endpoint` | something is posting to `chat/completions` upstream | only the proxy should talk upstream; check `OMNIRUSH_GATEWAY_URL` |
| `401` from upstream, restart doesn't help | refresh token revoked or rotated away | `scripts/ctl.sh reauth` |
| Request hangs with zero bytes | body shape — `input` must be an **array of items**, `stream:true`, `store:false` | already handled by the proxy; if you hand-crafted the call, match that shape |
| Tools never fire in the client | tool calls must be `{id, type:"function", function:{name, arguments}}` | that is what the proxy emits; check the client isn't on a stale cache |
| `EADDRINUSE :20129` | another proxy (e.g. a stale `omnirush2api`) holds the port | `lsof -nP -iTCP:20129 -sTCP:LISTEN`, kill it, restart |
| Health `unhealthy`, `account_count: 0` | no credentials in the store | redo Step 1 and Step 3 |
| Two processes, intermittent 401s | both refreshing the same rotating token | run exactly one proxy per token store |

Logs: `logs/server.log`, `logs/server.err.log` (service), or `scripts/ctl.sh logs`.

---

## Uninstall

```bash
./uninstall.sh              # stop + remove the service and the Hermes provider entry
./uninstall.sh --purge      # also delete the token store
```

---

## Windows notes

Use WSL2. Everything works except the launchd path — `install.sh` picks systemd instead.
Point the token store somewhere inside your WSL home, not `/mnt/c`.
