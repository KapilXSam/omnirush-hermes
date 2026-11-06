# Other OpenAI-compatible clients

Everything below points at the same thing:

```
base URL: http://127.0.0.1:20129/v1
API key:  sk-omnirush
models:   gpt-6-astra | gpt-6.1-sol | gpt-6-sol
```

---

## curl

```bash
curl -s http://127.0.0.1:20129/v1/chat/completions \
  -H 'authorization: Bearer sk-omnirush' -H 'content-type: application/json' \
  -d '{"model":"astra","messages":[{"role":"user","content":"hello"}]}'
```

Streaming: add `"stream": true` and `-N`.

## OpenAI Python SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:20129/v1", api_key="sk-omnirush")

for chunk in client.chat.completions.create(
    model="astra",
    messages=[{"role": "user", "content": "Explain prefix caching briefly."}],
    stream=True,
):
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

Reasoning deltas arrive on `delta.reasoning_content` when the upstream emits them.

## Cursor

Settings → Models → OpenAI API key → *Override OpenAI Base URL*:

```
http://127.0.0.1:20129/v1
```

API key `sk-omnirush`, then add `gpt-6-astra` (and the others) under custom models.

## Continue (`~/.continue/config.json`)

```json
{
  "models": [
    {
      "title": "OmniRush Astra",
      "provider": "openai",
      "model": "gpt-6-astra",
      "apiBase": "http://127.0.0.1:20129/v1",
      "apiKey": "sk-omnirush"
    }
  ]
}
```

## Aider

```bash
export OPENAI_API_BASE=http://127.0.0.1:20129/v1
export OPENAI_API_KEY=sk-omnirush
aider --model openai/gpt-6-astra
```

## Codex CLI (`~/.codex/config.toml`)

```toml
model = "gpt-6-astra"
model_provider = "omnirush"

[model_providers.omnirush]
name = "OmniRush"
base_url = "http://127.0.0.1:20129/v1"
env_key = "OMNIRUSH_API_KEY"
wire_api = "chat"
```

## Open WebUI / LibreChat / NextChat

Set the OpenAI base URL to `http://127.0.0.1:20129/v1` and the key to `sk-omnirush`, then add
the three model ids manually (there is no discovery surprise — `/v1/models` returns exactly
those three).

---

## Binding beyond localhost

The proxy listens on `127.0.0.1` only. To share it on your LAN:

```bash
OMNIRUSH_PROXY_HOST=0.0.0.0 OMNIRUSH_PROXY_KEY='<long-random-string>' node src/proxy.mjs
```

Change the key first — `sk-omnirush` is a well-known placeholder, and the proxy has no other
authentication. There is no TLS either; put it behind a reverse proxy if it leaves your
machine, and never expose it to the internet.
