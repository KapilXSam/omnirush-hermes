# FAQ & troubleshooting

Searchable answers to the things people actually run into. Commands assume this repo is
installed (`./install.sh`); see [SETUP.md](../SETUP.md) for the step-by-step version.

---

## The basics

### What is OmniRush, and does it have an API?

OmniRush (omnirush.ai) is a service that gives free daily access to frontier GPT‑6 models
(`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`). It has **no public API keys** — access is OAuth
through its own CLI or desktop app. This project bridges that OAuth session into an
OpenAI-compatible local endpoint.

### How do I get an OmniRush API key?

There isn't one. You get an OAuth token pair instead:

```bash
npm install -g omnirush2api
omnirush2api login          # device flow; writes ~/.omnirush2api/tokens.json
```

That refresh token is the closest thing to an API key. Treat it as a password: it is never
committed, never printed, and lives only in `~/.omnirush-proxy/tokens.json` (mode 600).

### Which models do I get?

| Model | Alias here | Context | Max output | Character |
|---|---|---|---|---|
| `gpt-6-astra` | `astra` | 200K | 16,384 | flagship deep reasoning |
| `gpt-6.1-sol` | `solpro` | 200K | 16,384 | frontier reasoning + coding |
| `gpt-6-sol` | `sol` | 128K | 8,192 | low-latency, high-throughput |

### How do I check my remaining quota?

The official CLI knows:

```bash
omnirush usage --json
```

The proxy's `/v1/health` reports the account and that it is authenticated, but not the balance.

---

## Using it in a client

### How do I use OmniRush in Hermes Agent?

```bash
hermes chat -m astra                                   # one-shot / session model
hermes config set providers.omnirush '…'               # see examples/hermes.md
```

Full provider JSON, aliases, defaults and fallback chains: [`examples/hermes.md`](../examples/hermes.md).

### How do I use it in Cursor / Continue / Aider / Codex / Open WebUI?

Every one of them is just "OpenAI-compatible base URL":

```
http://127.0.0.1:20129/v1        key: sk-omnirush
```

Copy-paste snippets for each: [`examples/other-clients.md`](../examples/other-clients.md).

### Can I use it with the Python/Node OpenAI SDK?

Yes — point `base_url` at the proxy, no other change. Streaming, tool calls and usage all
behave as the SDK expects.

### Does it support streaming, tool calls, and reasoning?

Yes to all three. Tool calls work in both streaming and non-streaming mode; reasoning
summaries arrive on `delta.reasoning_content` when the upstream emits them. Vision
(`image_url` content) is passed through as `input_image`.

### Can I share one proxy between several clients?

Yes — one proxy serves any number of local clients. Start it once and point everything at
`http://127.0.0.1:20129/v1`.

### Can I use it from another machine or a VPS?

The proxy binds `127.0.0.1` and has no auth beyond a static bearer key, and no TLS. If you must
expose it, change `OMNIRUSH_PROXY_KEY` to a long random value and put it behind a reverse proxy
with TLS. Never expose it to the internet.

---

## Troubleshooting

### `403 official_client_required`

The gateway bumped the official client version it accepts. That is a one-line fix, not a broken
install:

```bash
npm view omnirush version                    # e.g. 2.9.0
# set OMNIRUSH_CLIENT_VERSION in the service env (install.sh regenerates the unit/plist)
scripts/ctl.sh restart
```

The proxy resolves this automatically at startup from the npm registry; if you pinned
`OMNIRUSH_CLIENT_VERSION` manually, clear it to go back to auto.

### `404 unsupported_model_endpoint`

Something asked the upstream for `chat/completions`. The gateway serves **only** `/responses`.
Check `OMNIRUSH_GATEWAY_URL` points at `…/omnirush/v1` and that only the proxy talks upstream.

### A request hangs with zero bytes and no error

The upstream body shape was wrong. The specific trap: `input` must be an **array of items**,
not a string, and `stream: true` + `store: false` are mandatory. The proxy always sends the
correct shape — you'll only see this if you hand-crafted a call.

### Health says `unhealthy` / `account_count: 0`

No credentials in the store:

```bash
omnirush2api login
scripts/ctl.sh reauth        # copies the store and restarts
```

### Intermittent 401s after a restart

Two processes are sharing one token store. The refresh token **rotates on every refresh**, so
whichever process refreshes last wins and the other starts failing. Kill the duplicate:

```bash
lsof -nP -iTCP:20129 -sTCP:LISTEN
pgrep -fl proxy.mjs
```

### `EADDRINUSE :20129`

A stale proxy (often the older `omnirush2api` daemon) still holds the port. Kill it, or run on
another port: `OMNIRUSH_PROXY_PORT=20130`.

### The service isn't running after a reboot

```bash
scripts/ctl.sh status        # pid + health in one shot
scripts/ctl.sh logs          # last lines; look for a token-refresh failure
```

On Linux, without lingering, a `--user` service stops at logout:
`sudo loginctl enable-linger $USER`.

### Tools never fire in my client

Almost always a client-side shape issue: tool calls must be
`{id, type:"function", function:{name, arguments}}`. This proxy emits exactly that, and
`npm test` asserts it — if your client still ignores them, check for a cached/older build on the
client side.

### Nothing works after an OmniRush update

```bash
npm run scan && npm test          # local sanity
scripts/ctl.sh status             # account + client version in use
scripts/ctl.sh logs               # the real error text lives here
```

If it is a protocol change rather than a version bump, open an issue with the log line — that
is exactly the kind of breakage this project expects to chase.

---

## Design and safety

### Is my token exposed to the clients?

No. Clients talk to `127.0.0.1` with the dummy key `sk-omnirush`; the real OAuth bearer is
attached by the proxy process and never leaves it. See [SECURITY.md](../SECURITY.md).

### Could I get my account banned?

Possibly — this presents itself to the gateway as the official client because nothing else is
accepted, and that may conflict with OmniRush's terms. Use your own account, understand the
risk, and if the gateway starts refusing you, stop rather than retrying in a loop.

### Why not just use the existing `omnirush2api` project?

It was written against an earlier gateway. As of v1.0.1 it posts to `chat/completions`
(now `404`) and announces `cli/2.4.3` (now rejected), so it cannot work without the same
protocol work this proxy does — plus the tool-call shape fix and version auto-detection.
If it starts working again, use whichever you prefer; this repo is one file with no
dependencies, so it is easy to audit either way.

### What does it not do?

- No TLS, no multi-user auth, no rate limiting — loopback single-user tool by design.
- No model fine-tuning, no file uploads, no batch API.
- No automatic account rotation (one account per store; the `omnirush2api` pool feature is not
  reimplemented here).

### How do I uninstall?

```bash
./uninstall.sh            # stop the service, remove provider + aliases
./uninstall.sh --purge    # also delete the token store and logs
npm uninstall -g omnirush2api
```
