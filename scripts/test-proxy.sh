#!/usr/bin/env bash
# test-proxy.sh — smoke test against a running proxy.
# Covers: non-stream, stream, tool calls in both modes, multi-turn tool results, error paths.
set -uo pipefail
PORT="${OMNIRUSH_PROXY_PORT:-20129}"
B="http://127.0.0.1:$PORT/v1"
K="authorization: Bearer ${OMNIRUSH_PROXY_KEY:-sk-omnirush}"
CT='content-type: application/json'
pass=0; fail=0
check() { # check <name> <haystack> <needle>
  if printf '%s' "$2" | grep -q "$3"; then printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1))
  else printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); fi
}

echo "== health =="
H="$(curl -s --max-time 10 "$B/health")"
check "health reports healthy" "$H" '"status":"healthy"'
check "an account is loaded"   "$H" '"account_count":1'

echo "== models =="
M="$(curl -s --max-time 10 "$B/models" -H "$K")"
check "models list served" "$M" 'gpt-6-astra'

echo "== non-stream completion =="
R="$(curl -s --max-time 120 "$B/chat/completions" -H "$K" -H "$CT" \
  -d '{"model":"sol","messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"Reply with exactly: PROXY_OK"}],"max_tokens":40}')"
check "returns PROXY_OK" "$R" 'PROXY_OK'
check "usage present"    "$R" '"prompt_tokens"'

echo "== streaming completion =="
S="$(curl -s -N --max-time 120 "$B/chat/completions" -H "$K" -H "$CT" \
  -d '{"model":"astra","stream":true,"messages":[{"role":"user","content":"Count from 1 to 5, comma separated, nothing else."}]}')"
check "SSE content frames"  "$S" '"delta":{"content"'
check "stream terminates"   "$S" '\[DONE\]'
check "finish_reason=stop"  "$S" '"finish_reason":"stop"'

echo "== tool calls (non-stream) =="
T="$(curl -s --max-time 120 "$B/chat/completions" -H "$K" -H "$CT" -d '{
  "model":"sol","messages":[{"role":"user","content":"What is the weather in Paris? Call the tool."}],
  "tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
  "tool_choice":"auto"}')"
check "emits tool_calls"        "$T" '"tool_calls"'
check "OpenAI tool shape"       "$T" '"type":"function","function":{"name":"get_weather"'
check "finish_reason=tool_calls" "$T" '"finish_reason":"tool_calls"'

echo "== tool calls (stream) =="
TS="$(curl -s -N --max-time 120 "$B/chat/completions" -H "$K" -H "$CT" -d '{
  "model":"sol","stream":true,
  "messages":[{"role":"user","content":"What is the weather in Tokyo? Call the tool."}],
  "tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}')"
check "streamed tool_call deltas" "$TS" '"tool_calls"'

echo "== multi-turn with tool result =="
MT="$(curl -s --max-time 120 "$B/chat/completions" -H "$K" -H "$CT" -d '{
  "model":"sol",
  "messages":[
    {"role":"user","content":"What is the weather in Paris?"},
    {"role":"assistant","content":null,"tool_calls":[{"id":"call_abc123","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},
    {"role":"tool","tool_call_id":"call_abc123","content":"{\"temp_c\":18,\"sky\":\"clear\"}"},
    {"role":"user","content":"In one short sentence, what is it like there?"}
  ]}')"
check "answers from tool result" "$MT" '18'

echo "== error paths =="
E404="$(curl -s --max-time 30 -w ' [%{http_code}]' "$B/chat/completions" -H "$K" -H "$CT" -d '{"model":"nope","messages":[{"role":"user","content":"hi"}]}')"
check "unknown model -> 404" "$E404" '\[404\]'
E401="$(curl -s --max-time 30 -w ' [%{http_code}]' "$B/chat/completions" -H 'authorization: Bearer wrong' -H "$CT" -d '{"model":"sol","messages":[{"role":"user","content":"hi"}]}')"
check "bad key -> 401" "$E401" '\[401\]'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
