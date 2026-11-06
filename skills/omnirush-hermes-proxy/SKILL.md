---
name: omnirush-hermes-proxy
description: "Use when bridging OmniRush into Hermes as a model provider."
version: 1.1.0
author: omnirush-hermes contributors
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [omnirush, proxy, provider, openai-compatible, oauth, responses-api, launchd]
    homepage: https://github.com/KapilXSam/omnirush-hermes
---

# OmniRush → Hermes proxy

Load this skill when the user wants OmniRush's free GPT-6 models (`gpt-6-astra`,
`gpt-6.1-sol`, `gpt-6-sol`) inside Hermes, or when a local proxy on `127.0.0.1:20129` /
the aliases `astra`, `sol`, `solpro` are misbehaving.

Project: <https://github.com/KapilXSam/omnirush-hermes> (MIT, zero dependencies).

## Fast path

```bash
git clone https://github.com/KapilXSam/omnirush-hermes.git ~/omnirush-proxy
cd ~/omnirush-proxy && ./install.sh        # credentials → service → Hermes wiring → verify
~/omnirush-proxy/scripts/ctl.sh status
hermes chat -q "Reply with exactly: OK" -m astra
```

## Installed layout

| Thing | Value |
|---|---|
| Proxy | `~/omnirush-proxy/src/proxy.mjs` (one file, no deps, Node ≥ 20) |
| Control | `scripts/ctl.sh {status,start,stop,restart,logs,test,reauth}` |
| Endpoint | `http://127.0.0.1:20129/v1`, bearer key `sk-omnirush` |
| macOS service | `~/Library/LaunchAgents/com.omnirush.proxy.plist` |
| Linux service | `~/.config/systemd/user/omnirush-proxy.service` |
| Token store | `~/.omnirush-proxy/tokens.json` (0600) |
| Hermes | provider `omnirush`; aliases `astra`, `sol`, `solpro` |

## Gateway rules (do not "fix" these away)

1. Only `POST <gateway>/responses` is served. `chat/completions` → `404 unsupported_model_endpoint`.
2. Every request must send `stream: true` and `store: false`.
3. `x-omnirush-session-id` triggers `403 official_client_required` unless it is the genuine
   official client — the proxy sends **no** session id.
4. Headers that pass: `user-agent: omnirush`, `X-OmniRush-Client: cli/<current version>`.
   The version is policed; resolve it from npm (`registry.npmjs.org/omnirush/latest`) instead
   of hardcoding.
5. `input` must be an array of items. A bare string **hangs with zero bytes** — it does not error.
6. Auth is OAuth: `POST {base}/device/refresh` returns a new `access_token` and **rotates the
   refresh token** — persist the new one or the next refresh 401s.

## Wiring Hermes by hand

```bash
grep -q OMNIRUSH_API_KEY ~/.hermes/.env || echo 'OMNIRUSH_API_KEY=sk-omnirush' >> ~/.hermes/.env

hermes config set providers.omnirush '{"name":"OmniRush","base_url":"http://127.0.0.1:20129/v1","key_env":"OMNIRUSH_API_KEY","api_mode":"chat_completions","model":"gpt-6-astra","discover_models":false,"models":{"gpt-6-astra":{"context_length":200000,"tools":true,"reasoning":true},"gpt-6.1-sol":{"context_length":200000,"tools":true,"reasoning":true},"gpt-6-sol":{"context_length":128000,"tools":true,"reasoning":true}}}'

# aliases: one dotted path each. Setting the whole section is refused, and --force would
# delete aliases the user already has (OpenRouter, xkiro, …).
hermes config set model_aliases.astra  '{"model":"gpt-6-astra","provider":"omnirush"}'
hermes config set model_aliases.sol    '{"model":"gpt-6-sol","provider":"omnirush"}'
hermes config set model_aliases.solpro '{"model":"gpt-6.1-sol","provider":"omnirush"}'
```

## Verification (real output, not intentions)

```bash
scripts/ctl.sh status                       # pid + /v1/health
scripts/test-proxy.sh                       # 15 live assertions
npm test                                    # 30 unit + 19 integration assertions, offline
hermes chat -q "Reply with exactly this and nothing else: HERMES_OMNIRUSH_OK" -m astra
hermes chat -q "Use your terminal tool to run: echo TOOLCALL_WORKS && uname -s" -m sol
```

The **second** command is the important one: it proves tool-call translation, not just text.

## Repair table

| Symptom | Cause | Fix |
|---|---|---|
| `403 official_client_required` | vendor bumped the accepted client version | `npm view omnirush version`, set `OMNIRUSH_CLIENT_VERSION`, `scripts/ctl.sh restart` |
| `401` from upstream | refresh token rotated away / revoked | `scripts/ctl.sh reauth` |
| hang, zero bytes | body shape (`input` not an array, missing `stream`/`store`) | only hand-written calls hit this |
| `404 unsupported_model_endpoint` | something posting to `chat/completions` upstream | check `OMNIRUSH_GATEWAY_URL` |
| health `unhealthy`, `account_count: 0` | no credentials in the store | `omnirush2api login && scripts/ctl.sh reauth` |
| `EADDRINUSE :20129` | stale proxy (often the old `omnirush2api` daemon) | `lsof -nP -iTCP:20129 -sTCP:LISTEN`, kill it |
| intermittent 401s | two processes sharing one rotating store | run exactly one proxy |

## Lessons worth keeping

- **Do not patch `omnirush2api`** — v1.0.1 posts to `chat/completions` and announces
  `cli/2.4.3`; both are dead ends. The wire facts above are the whole requirement.
- Tool calls in a non-streaming response must be `{id, type:"function", function:{name, arguments}}`;
  a flattened `{id,name,arguments}` silently breaks agent clients.
- `stream` defaults to **false** in OpenAI's API; treating an absent field as streaming returns
  SSE to a client expecting JSON.
- `nohup`/`setsid` are rejected by the Hermes terminal tool (and `setsid` does not exist on
  macOS) — use `terminal(background=true)` and a launchd/systemd unit for durability.
- `launchctl list | grep -q` fails under `set -o pipefail` (SIGPIPE) and reports a loaded agent
  as "not loaded" — capture into a variable first.
- `timeout` is not on macOS by default; use the tool's own timeout parameter.

## Generalizing

Same shape for any vendor whose gateway only serves its own client: find the endpoint it really
serves, the headers and version it wants, the body quirks (forced streaming, `store:false`,
forbidden headers), then write a small translator exposing `chat/completions`. Prefer that over
adopting a stale third-party bridge — and make the translator importable so its pure functions
can be unit-tested without a network.
