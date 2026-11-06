# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [1.1.0] — 2026-11-06

First public release of the packaged project (the proxy itself was built and verified against
a live account before publication).

### Added

- `src/proxy.mjs` — zero-dependency translator: OpenAI **Chat Completions** in, OmniRush's
  **Responses** API out, with SSE translation back (text, `reasoning_content`, tool calls, usage).
- OAuth device-flow credential handling with refresh-token rotation persisted atomically.
- Upstream client-version masquerade resolved at startup from the npm registry, so the proxy
  survives vendor version bumps without a code change.
- `install.sh` — one-shot install: preflight, credentials, launchd (macOS) or systemd (Linux)
  service, Hermes provider + aliases, live verification.
- `scripts/ctl.sh` — status / start / stop / restart / logs / test / reauth.
- `scripts/test-proxy.sh` — 15 live assertions: non-stream, stream, tool calls in both modes,
  multi-turn tool results, 401/404 paths.
- `tests/smoke.mjs` — 30 translation-layer assertions, no network or credentials required.
- `scripts/scan-secrets.sh` — dependency-free secret scan over the tree **and** full git history.
- `scripts/publish.sh` — gated public publishing (scan → commit → create → push → verify remote).
- `AGENT_PROMPT.md` — a copy-paste prompt any capable agent can execute end to end.
- `SETUP.md`, `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/FAQ.md`.
- Client recipes: Hermes Agent, Cursor, Continue, Aider, Codex CLI, Open WebUI/LibreChat, curl, Python SDK.
- GitHub Actions CI: gitleaks + pattern scan, syntax checks, unit and integration tests, a live
  boot smoke test.
- Hermes skill shipped in `skills/` so agents can install and repair this bridge themselves.

### Fixed

- Non-streaming responses emitted tool calls in a flattened `{id, name, arguments}` shape, which
  silently breaks agent clients. Now the OpenAI shape: `{id, type, function:{name, arguments}}`.
- `stream` was treated as defaulting to `true`; OpenAI clients omit it, so JSON callers received
  SSE. Default is now `false`, per spec.
- `publish.sh` queried the remote file list without the repository owner and mis-reported a 404.

### Known limitations

- Inherently brittle by nature: it presents itself as the official client because the gateway
  refuses anything else. A vendor change surfaces as `403 official_client_required`.
- One proxy per token store (the refresh token rotates on every refresh).
- No TLS and no auth beyond a static bearer key — loopback only.
