# Hermes Agent

## Register the provider

```bash
grep -q OMNIRUSH_API_KEY ~/.hermes/.env 2>/dev/null || echo 'OMNIRUSH_API_KEY=sk-omnirush' >> ~/.hermes/.env

hermes config set providers.omnirush '{"name":"OmniRush","base_url":"http://127.0.0.1:20129/v1","key_env":"OMNIRUSH_API_KEY","api_mode":"chat_completions","model":"gpt-6-astra","discover_models":false,"models":{"gpt-6-astra":{"context_length":200000,"tools":true,"reasoning":true},"gpt-6.1-sol":{"context_length":200000,"tools":true,"reasoning":true},"gpt-6-sol":{"context_length":128000,"tools":true,"reasoning":true}}}'
```

`discover_models: false` keeps the catalog to exactly the three models, and the explicit
`context_length` avoids the 256K default Hermes falls back to when it cannot probe `/models`.

## Aliases

```bash
hermes config set model_aliases.astra  '{"model":"gpt-6-astra","provider":"omnirush"}'
hermes config set model_aliases.sol    '{"model":"gpt-6-sol","provider":"omnirush"}'
hermes config set model_aliases.solpro '{"model":"gpt-6.1-sol","provider":"omnirush"}'
```

Add them one dotted path at a time. `hermes config set model_aliases '<json>'` is refused when
the section already exists, and `--force` replaces the entire section — which would delete
aliases you already had.

## Use

| Surface | How |
|---|---|
| CLI one-shot | `hermes chat -q "…" -m astra` |
| CLI session | `hermes chat -m astra` |
| Desktop / TUI | `/model astra` |
| Messaging gateway | `/model astra` (works per-platform) |

`--provider omnirush -m gpt-6-sol` also works if you would rather be explicit than use an alias.

## Make it the default

```bash
hermes config set model.provider omnirush
hermes config set model.name gpt-6-astra
```

## Fallback chain

Keep working if OmniRush is down or out of quota:

```bash
hermes fallback add --provider openrouter --model anthropic/claude-sonnet-4.6
hermes fallback list
```

## Verify from Hermes' side

```bash
hermes chat -q "Reply with exactly this and nothing else: HERMES_OMNIRUSH_OK" -m astra
hermes chat -q "Use your terminal tool to run: echo TOOLCALL_WORKS && uname -s" -m sol
```

The second command is the important one: it proves the tool-call translation, not just text.

## Notes

- Long context is real (200K on `astra`/`solpro`, 128K on `sol`), but agent turns send the
  whole history — watch the log line in `scripts/ctl.sh logs` for `in=` token counts.
- If a session reports "model not found", the alias was probably written into the wrong
  section: check `hermes config get model_aliases`.
- Removing it all: `uninstall.sh`.
