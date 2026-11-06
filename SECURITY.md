# Security

## No credentials in this repository

This repo contains **no API keys, tokens, or account identifiers** — by design and enforced
by CI.

The OAuth material this proxy uses lives outside the project, at
`~/.omnirush-proxy/tokens.json` (mode `600`). It is never read from the repo, never written
into the repo, and the paths that could hold it are listed in `.gitignore`:

```
tokens.json
*.tokens.json
.env
.env.*
logs/
*.plist
*.service
```

A GitHub Actions workflow (`.github/workflows/secret-scan.yml`) runs
[gitleaks](https://github.com/gitleaks/gitleaks) on every push and pull request, so an
accidental secret is caught before it becomes permanent. Maintainers: also enable
**Settings → Code security → Secret scanning + Push protection** on the repository — that
blocks the push outright instead of only reporting it.

## What the keys actually are

| Value | Where it lives | What it is |
|---|---|---|
| OAuth refresh/access token | `~/.omnirush-proxy/tokens.json` (0600, outside repo) | your real OmniRush account credential |
| `OMNIRUSH_API_KEY=sk-omnirush` | `~/.hermes/.env` | a **local dummy** — it authenticates your client to the proxy, not to OmniRush |
| `OMNIRUSH_PROXY_KEY` | env of the service process | the same dummy; change it if you ever bind off-loopback |

The real token never leaves the proxy process: clients talk to `127.0.0.1` and the proxy
attaches the OAuth bearer upstream.

## Hardening checklist

- [ ] Proxy bound to `127.0.0.1` (default). If you must expose it, set a strong
      `OMNIRUSH_PROXY_KEY` and put it behind TLS — it has no other auth.
- [ ] `chmod 600 ~/.omnirush-proxy/tokens.json` (the installer does this).
- [ ] Never paste token output into an issue, PR, chat, or screenshot. If you did,
      treat the account as compromised: run `omnirush2api login` again to mint a new
      refresh token, then `scripts/ctl.sh reauth`.
- [ ] One proxy per token store. The upstream rotates the refresh token on every refresh;
      two processes sharing a store will invalidate each other.

## The secret-scan allowlist

`scripts/scan-secrets.sh` runs over the working tree **and** every commit. Two documented
exceptions exist, and nothing else:

| Exception | Why | Where |
|---|---|---|
| a line carrying the marker `omnirush:allow-secret-scan` | deliberate fake in a test fixture | `tests/server.mjs` |
| the exact literal `omr_invalid_token_for_tests` | the same placeholder, so history from before the marker existed stays clean | `tests/server.mjs` |
| `sk-omnirush` | the local dummy client key, not a credential to anything upstream | docs, examples, config |

A pull request that widens either list needs a justification in the description. Adding a real
value to the allowlist defeats the purpose of the gate — if a scan ever reports a hit you do
not recognise, treat it as a live leak: rotate the credential first
(`omnirush2api login`), then clean the file and the history.

## Reporting a vulnerability

Open a private security advisory (Security → Advisories → New draft) rather than a public
issue. Please include: affected file, reproduction, and impact. Do not include live tokens
in the report.

## Scope and legal

This is an independent interoperability tool. It is not affiliated with OmniRush.ai, and it
deliberately presents itself to the upstream gateway as the official client because that
gateway refuses anything else. Using it may conflict with OmniRush's terms of service and
your account is the one at risk — run it only against your own account, and at your own
risk. The MIT licence disclaims all warranty.
