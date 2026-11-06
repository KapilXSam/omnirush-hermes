## What this changes

<!-- One paragraph. The "why" matters more than the "what". -->

## Type

- [ ] Bug fix (translation, streaming, tool calls, protocol handling)
- [ ] Client compatibility (which client?)
- [ ] Diagnostics / logs / errors
- [ ] Docs or examples
- [ ] Install / service / portability
- [ ] Other:

## How it was verified

<!-- Real commands and their real output. "Tests pass" is not enough on its own. -->

```
npm run lint
npm test
```

## Checklist

- [ ] No credential, token store, `.env` value, or account email is included anywhere
- [ ] `npm run scan` passes (tree **and** history)
- [ ] No new runtime dependency
- [ ] Translation-logic changes come with assertions in `tests/smoke.mjs`
- [ ] HTTP-surface changes come with assertions in `tests/server.mjs`
- [ ] Docs updated when behaviour or config changed (README / SETUP / examples / AGENTS.md)

## Notes for the reviewer

<!-- Anything you are unsure about, or a deliberate trade-off. -->
