# Contributing

Thanks for helping. This project is intentionally small — one proxy file, no dependencies —
so the bar for new code is "it earns its place".

## Before you start

```bash
git clone https://github.com/KapilXSam/omnirush-hermes.git
cd omnirush-hermes
npm test          # unit + integration, no network, no credentials
npm run lint      # syntax checks for JS and shell
```

You do **not** need an OmniRush account to contribute: the test suite mocks nothing and
touches no upstream — it exercises the translation layer and the HTTP surface directly.

## What is genuinely useful

| Area | Examples |
|---|---|
| Translation correctness | a chat→responses field that is dropped or mangled, an SSE event not handled |
| Client compatibility | a client that fails against the proxy (include its exact request) |
| Failure diagnostics | clearer errors when the gateway changes, better log lines |
| Docs | a client setup that is missing from `examples/` |
| Portability | Linux/ARM/Windows behaviours that differ |

## Rules

1. **No credentials, ever.** Do not paste tokens, account emails, or `tokens.json` contents
   into an issue, PR, commit or test fixture. `npm run scan` must stay green.
2. **No new dependencies.** The zero-dependency property is a feature; a PR that adds one
   needs a strong argument.
3. **Tests first.** If you change the translation layer, add an assertion to
   `tests/smoke.mjs`. If you change the HTTP surface, add one to `tests/server.mjs`.
4. **Match the existing style.** Comments explain *why*, not *what*. Keep functions small.
5. **One concern per PR.** Small diffs get reviewed the same day.

## Adding support for a new client

Add a section to `examples/other-clients.md` with the exact config snippet, then mention it
in the PR. If the client needs a wire quirk the proxy doesn't handle yet, add the handling
plus a unit test.

## Commit messages

```
area: short imperative summary

Why it was needed and what it changes. Reference an issue with #123.
```

## Release checklist (maintainers)

```bash
npm run lint && npm test
npm run scan
# bump version in package.json + CHANGELOG.md
git commit -am "release: vX.Y.Z" && git tag -a vX.Y.Z -m "vX.Y.Z" && git push --follow-tags
gh release create vX.Y.Z --notes-from-tag
```

## Reporting a vulnerability

Do **not** open a public issue — see [SECURITY.md](SECURITY.md).
