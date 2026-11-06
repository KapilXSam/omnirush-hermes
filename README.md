# OmniRush → Hermes (and any OpenAI-compatible client)

A tiny, dependency-free local proxy that lets **Hermes Agent**, Cursor, Aider, Continue, or
any OpenAI-compatible client use **OmniRush's free GPT-6 models** (`gpt-6-astra`,
`gpt-6.1-sol`, `gpt-6-sol`).

```
Hermes / Cursor / Aider ──chat/completions──▶ omnirush-proxy ──responses (stream)──▶ omnirush.ai
        (OpenAI shape)                    127.0.0.1:20129        (official-client shape)
```

## Why this exists

OmniRush's gateway only talks to its own client, and it is strict about it:

| Upstream behaviour | What a normal OpenAI client gets |
|---|---|
| Only `POST /v1/responses` is served | `404 unsupported_model_endpoint` on `/v1/chat/completions` |
| `/v1/responses` requires `stream: true` and `store: false` | rejected / malformed |
| Any request carrying `x-omnirush-session-id` is refused unless it is the real client | `403 official_client_required` |
| The announced client version is policed | a stale `cli/<version>` fails like a bogus session id |

This proxy does the translation: it accepts **Chat Completions** (what every client speaks),
posts the **Responses** shape upstream with the headers the gateway wants, and translates the
SSE stream back — text, reasoning deltas, tool calls, and usage included.

It is one file (`src/proxy.mjs`), zero dependencies, Node ≥ 20.

## Quick start

```bash
git clone https://github.com/<you>/omnirush-hermes.git
cd omnirush-hermes
./install.sh            # checks Node, gets credentials, installs the service, wires Hermes
```

Or do it by hand — [SETUP.md](SETUP.md) is the step-by-step guide.
Letting an AI agent do it instead? Paste [AGENT_PROMPT.md](AGENT_PROMPT.md) into it.

## Managing it

```bash
scripts/ctl.sh status     # service state + live health (account, models, client version)
scripts/ctl.sh logs       # tail the service log
scripts/ctl.sh restart
scripts/ctl.sh reauth     # re-run the OmniRush device login (account changed / token revoked)
scripts/ctl.sh test       # full smoke test: streaming, tools, multi-turn, error paths
```

## Use it

```bash
hermes chat -m astra                      # gpt-6-astra (flagship)
hermes chat -m sol                        # gpt-6-sol   (low latency)
hermes chat -m solpro                     # gpt-6.1-sol (reasoning + coding)
```

In a running session: `/model astra`. Any other OpenAI client: base URL
`http://127.0.0.1:20129/v1`, API key `sk-omnirush` — see [examples/](examples/).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OMNIRUSH_PROXY_PORT` | `20129` | listen port |
| `OMNIRUSH_PROXY_KEY` | `sk-omnirush` | client bearer key the proxy requires |
| `OMNIRUSH_GATEWAY_URL` | `https://omnirush.ai/omnirush/v1` | upstream base URL |
| `OMNIRUSH_CLIENT_VERSION` | auto (npm `omnirush@latest`) | version to present upstream |
| `OMNIRUSH_PROXY_STORE` | `~/.omnirush-proxy/tokens.json` | token store (0600) |
| `OMNIRUSH_SEED_STORE` | `~/.omnirush2api/tokens.json` | where to seed credentials from |
| `OMNIRUSH_IDLE_TIMEOUT_MS` | `180000` | abort a stalled upstream stream |

## Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions (stream + non-stream) |
| `POST /v1/responses` | raw passthrough for Responses-native clients |
| `GET /v1/models` | the three OmniRush models with context/max-output metadata |
| `GET /v1/health` | account, client version, model list |

## Security

- **No credentials in this repo, ever.** Tokens live only in `~/.omnirush-proxy/tokens.json`
  (mode `0600`, outside the project) and are ignored by `.gitignore`; CI runs a secret scan
  on every push ([`SECURITY.md`](SECURITY.md)).
- The proxy binds `127.0.0.1` only. If you change that, change `OMNIRUSH_PROXY_KEY` too.
- The client key sent by Hermes (`sk-omnirush`) is a **local dummy** — it authenticates you to
  the proxy, not to OmniRush. The real OAuth token never leaves the proxy process.

## Development

```bash
node tests/smoke.mjs                # translation-layer tests: no network, no credentials
scripts/test-proxy.sh               # live smoke test against a running proxy
scripts/scan-secrets.sh --history   # the gate that keeps tokens out of this repo
scripts/publish.sh --check          # run every pre-publish gate, change nothing
scripts/publish.sh                  # scan, commit, create the public repo, push, verify
```

CI (`.github/workflows/secret-scan.yml`) runs gitleaks plus the dependency-free pattern scan,
`node --check`, shell syntax checks and the translation tests on every push.

## Maintenance

OmniRush hardens its gateway periodically. The proxy resolves the current official client
version from npm at startup, so version bumps normally need no action. If the vendor changes
the wire protocol, the log line to look for is `403 official_client_required` —
see [SETUP.md § Troubleshooting](SETUP.md#troubleshooting).

## Legal

Independent interoperability tool. Not affiliated with, endorsed by, or maintained by
OmniRush.ai. "OmniRush" and its model names are trademarks of their respective owners.
Access to OmniRush models is governed by your OmniRush account and its terms — use this only
with your own account and at your own risk. MIT licensed (see [LICENSE](LICENSE)).
