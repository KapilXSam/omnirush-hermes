# AGENTS.md

Instructions for AI agents working **on this repository**. (If you are an agent trying to
*install* the bridge on a machine, use [`AGENT_PROMPT.md`](AGENT_PROMPT.md) instead.)

## What this project is

A single-file, zero-dependency local proxy that lets OpenAI-compatible clients use OmniRush's
GPT-6 models. The only source file that matters is `src/proxy.mjs`; everything else is
installation, testing and documentation around it.

## Ground rules

- **Never** add a credential, token store, `.env` value, or account email to the repository or
  to any test fixture. `npm run scan` must pass; CI fails the build otherwise.
- **Never** add a runtime dependency. The zero-dependency property is deliberate.
- **Never** weaken the security gates in `scripts/scan-secrets.sh` or `publish.sh` to make a
  change pass.
- Keep `src/proxy.mjs` importable without side effects: the server must only bind when the file
  is executed directly. Tests import the translation functions.
- Do not hand-edit generated service files (`*.plist`, `*.service`) — they are produced by
  `install.sh` and gitignored.

## Layout

| Path | Role |
|---|---|
| `src/proxy.mjs` | the proxy: config, tokens, translation, HTTP server |
| `tests/smoke.mjs` | pure translation assertions (no network, no credentials) |
| `tests/server.mjs` | boots the proxy on a temp port and asserts the HTTP surface |
| `scripts/ctl.sh` | service control (launchd on macOS, systemd on Linux) |
| `scripts/test-proxy.sh` | live end-to-end assertions against a running proxy |
| `scripts/scan-secrets.sh` | pre-push secret gate (tree + full git history) |
| `scripts/publish.sh` | gated public publish |
| `install.sh`, `uninstall.sh` | machine setup / teardown |
| `docs/ARCHITECTURE.md` | wire protocol, diagrams, failure modes |
| `skills/` | Hermes skill so agents can install and repair this bridge themselves |

## Workflow

```bash
npm run lint         # JS + shell syntax
npm test             # unit + integration (no credentials needed)
npm run scan         # secret gate — must be green before any commit
npm start            # run the proxy in the foreground
npm run status       # service state + live health (if installed)
```

When you change the translation layer, extend `tests/smoke.mjs` in the same commit. When you
change routes or headers, extend `tests/server.mjs`.

## Facts you should not have to rediscover

The upstream gateway:

- serves **only** `POST <gateway>/responses`; `/chat/completions` answers
  `404 unsupported_model_endpoint`
- requires `stream: true` and `store: false` on every request
- refuses `x-omnirush-session-id` with `403 official_client_required` unless it is the genuine
  official client — send no session id at all
- wants `user-agent: omnirush` and `X-OmniRush-Client: cli/<current version>`; a stale version
  fails exactly like a bogus session id
- needs `input` as an **array of items**, not a string (a string hangs, it does not error)
- rotates the refresh token on every refresh — persist the new one or the next call 401s

Full detail, with the event-by-event SSE mapping: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Reporting back

State what you ran and what it actually printed. If a gate failed, say which one and stop —
do not describe intended fixes as done work.
