# Architecture

## The shape of the problem

```
┌──────────────┐   OpenAI Chat Completions    ┌────────────────┐   OpenAI Responses    ┌──────────────┐
│ Hermes Agent │ ───────────────────────────▶ │ omnirush-proxy │ ────────────────────▶ │  omnirush.ai │
│ Cursor       │   /v1/chat/completions       │  127.0.0.1     │   /v1/responses       │   gateway    │
│ Aider, …     │ ◀─────────────────────────── │  :20129        │ ◀──────────────────── │              │
└──────────────┘   chat.completion(.chunk)    └────────────────┘   SSE events          └──────────────┘
                        (this is what every                 (this is the only thing
                         client already speaks)              the gateway will answer)
```

Two different dialects, one translation layer. The proxy exists because the gateway refuses
to speak the dialect that clients speak.

## Why the translation is necessary

Every rule below was established by probing the live gateway; each has a distinct failure
signature, which is why they cannot be fixed by simply retrying.

| # | Gateway rule | What a naive proxy sees |
|---|---|---|
| 1 | Only `POST <gateway>/responses` is served | `404 {"detail":"unsupported_model_endpoint"}` on `/chat/completions` |
| 2 | Requests must carry `stream: true` and `store: false` | request rejected / empty body |
| 3 | `x-omnirush-session-id` is refused unless it is the genuine official client | `403 official_client_required` |
| 4 | The announced client version is policed (`X-OmniRush-Client: cli/<version>`) | `403 official_client_required` — indistinguishable from #3 |
| 5 | `input` must be an array of items, never a bare string | the request **hangs** with zero bytes; it does not error |

Rule 5 is the trap that costs the most time: a string `input` produces no error and no
response, so it looks like a network problem rather than a schema problem.

### What the proxy sends upstream

```
POST https://omnirush.ai/omnirush/v1/responses
authorization: Bearer <access_token>
content-type: application/json
accept: text/event-stream
user-agent: omnirush
X-OmniRush-Client: cli/2.8.2          ← resolved from npm at startup, never hardcoded
                                      ← and deliberately NO x-omnirush-session-id

{"model":"gpt-6-astra","input":[…],"instructions":"…","tools":[…],
 "stream":true,"store":false}
```

## Request translation: Chat Completions → Responses

| Chat Completions | Responses | Notes |
|---|---|---|
| `model: "astra"` (alias) | `model: "gpt-6-astra"` | aliases resolved locally before validation |
| `messages[role=system\|developer]` | `instructions` (joined with `\n\n`) | Responses has a first-class field for this |
| `messages[role=user]` | `{type:"message", role:"user", content:[{type:"input_text",…}]}` | |
| `messages[role=assistant]` (text) | `{type:"message", role:"assistant", content:[{type:"output_text",…}]}` | note `output_text`, not `input_text` |
| `messages[role=assistant].tool_calls[]` | `{type:"function_call", call_id, name, arguments}` | one item per call |
| `messages[role=tool]` | `{type:"function_call_output", call_id, output}` | `tool_call_id` → `call_id` |
| `content[].image_url` | `{type:"input_image", image_url}` | multimodal passthrough |
| `tools[].function{name,description,parameters}` | `tools[]{type:"function", name, description, parameters}` | flattened — no nested `function` key |
| `tool_choice:{type:"function",function:{name}}` | `tool_choice:{type:"function", name}` | flattened |
| `max_tokens` / `max_completion_tokens` | `max_output_tokens` | |
| `temperature`, `top_p`, `reasoning_effort`, `parallel_tool_calls` | passed through | |
| anything else (`thinking`, `enable_thinking`, `search`, …) | **dropped** | the gateway rejects unknown fields |

`stream` and `store` are forced to `true` and `false` regardless of what the client asked for.

## Response translation: Responses SSE → Chat Completions

| Upstream event | Emitted downstream |
|---|---|
| `response.created` | (records the model name for the frame headers) |
| `response.output_text.delta` | `choices[0].delta.content` |
| `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` | `choices[0].delta.reasoning_content` |
| `response.output_item.added` (item `function_call`) | `delta.tool_calls[{index, id, type:"function", function:{name, arguments:""}}]` |
| `response.function_call_arguments.delta` | `delta.tool_calls[{index, function:{arguments}}]` |
| `response.completed` | `finish_reason` (`tool_calls` when any function call was seen) + `usage` |
| — | `data: [DONE]` |

Terminal frames:

```
data: {"choices":[{"delta":{},"finish_reason":"stop"}], "usage":{…}}   ← only if stream_options.include_usage
data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

For non-streaming clients (`stream` omitted or `false`) the same events are assembled into one
`chat.completion` object. Tool calls are rebuilt in the precise shape OpenAI uses —
`{id, type:"function", function:{name, arguments}}`. A flattened `{id, name, arguments}` looks
plausible and still destroys agent clients, which is why `tests/smoke.mjs` asserts the nested
shape explicitly.

## Credential lifecycle

```
omnirush2api login                  POST /omnirush/device/refresh
   │                                       ▲
   │ device flow (browser)                 │ {refresh_token}
   ▼                                       │
~/.omnirush2api/tokens.json ──seed──▶ ~/.omnirush-proxy/tokens.json (0600)
   {refreshToken, accessToken}              │
                                            ▼
                                     access_token (≈1h) ──▶ upstream bearer
                                            │
                       every refresh returns a NEW refresh token → persisted atomically
```

- Access tokens are refreshed ~5 minutes before expiry, and on any upstream `401`.
- The refresh token **rotates**: the store is the single source of truth, written via a
  temp-file rename so a crash cannot leave a half-written store.
- Therefore: **one proxy process per store.** Two processes sharing it will invalidate each
  other's refresh token and produce intermittent 401s.

## Process model

- One `node src/proxy.mjs` process, bound to `127.0.0.1` by default, no workers, no cluster.
- Long-lived under launchd (macOS, `KeepAlive`) or systemd `--user` (Linux, `Restart=always`).
- Stateless apart from the token store: restarting it is always safe.
- Streaming is pump-through — the proxy never buffers a whole response, so agent turns with
  large contexts do not accumulate memory.

## Failure modes and their signature

| Symptom | Meaning | Action |
|---|---|---|
| `403 official_client_required` | the gateway wants a newer official client version | `npm view omnirush version`, set `OMNIRUSH_CLIENT_VERSION`, restart |
| `404 unsupported_model_endpoint` | something is calling `chat/completions` upstream | check `OMNIRUSH_GATEWAY_URL` — the proxy posts to `/responses` |
| Hang, zero bytes, no error | malformed body — `input` not an array, or a missing `stream`/`store` | the proxy always sets these; suspect a hand-written upstream call |
| `401` after a restart | refresh token rotated away by another process | `scripts/ctl.sh reauth`, ensure one process |
| Health `unhealthy`, `account_count: 0` | no credentials in the store | `omnirush2api login` then `scripts/ctl.sh reauth` |
| Tools never fire in the client | a flattened tool-call shape reached the client | check the client isn't caching an old build; run `npm test` |

## Extension points

- **New model** — add to `MODELS` in `src/proxy.mjs` (id, aliases, context, max output); it
  appears in `/v1/models`, the health payload and alias resolution at once.
- **Another gateway with the same shape** — `OMNIRUSH_GATEWAY_URL` plus, if needed, a different
  `OMNIRUSH_CLIENT_VERSION`. The translation layer is vendor-agnostic.
- **Another client** — nothing to change: anything that speaks Chat Completions works. Add a
  recipe to `examples/other-clients.md` if it needs a specific quirk.
