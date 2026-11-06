# Agent prompt — paste this into any capable agent

Works with Hermes Agent, Claude Code, Codex, Cursor, Aider, or any agent that can run shell
commands. Copy the block below verbatim. The agent is expected to **run** the steps and report
real output, not describe them.

---

```text
TASK: Give this machine access to OmniRush's free GPT-6 models from Hermes Agent (and any
other OpenAI-compatible client) by installing and wiring the local `omnirush-proxy`.

DELIVERABLE (all must be true at the end):
  1. A local OpenAI-compatible endpoint on http://127.0.0.1:20129/v1 answering /v1/health,
     /v1/models and /v1/chat/completions, authenticated with the bearer key `sk-omnirush`.
  2. It runs as a background service that restarts on crash and starts at login.
  3. Hermes has a provider named `omnirush` plus working aliases `astra`, `sol`, `solpro`.
  4. Verified by actually running: a plain completion AND a turn that uses one tool.

HARD RULES — violating these fails the task:
  - NEVER print, echo, copy, commit, or summarise an OAuth token, refresh token, or PAT.
    If a command's output would contain one, redirect or filter it before showing it.
  - Never put credentials in a file inside the project directory, in git, or in your report.
    Credentials live ONLY in ~/.omnirush-proxy/tokens.json with mode 600.
  - Never invent output. If a command fails, report the real error and stop at that step.
  - Use `terminal(background=true)` (or the platform equivalent) for long-lived processes —
    do NOT use nohup/setsid/disown.
  - Do not hand-edit ~/.hermes/config.yaml. Use `hermes config set`.

WHAT YOU ARE BRIDGING (already established — use these facts, don't rediscover them the hard way):
  - OmniRush's gateway serves ONLY `POST <base>/responses`. `POST <base>/chat/completions`
    returns `404 unsupported_model_endpoint`.
  - Every upstream request must carry `stream: true` and `store: false`.
  - A request carrying `x-omnirush-session-id` is refused with `403 official_client_required`
    unless it is the genuine official client. Send NO session id.
  - Accepted headers are `user-agent: omnirush` and `X-OmniRush-Client: cli/<current version>`.
    The version is policed, so resolve it at runtime from https://registry.npmjs.org/omnirush/latest.
  - `input` must be an ARRAY of items, e.g.
    {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}.
    A bare string input makes the request hang with zero bytes.
  - Auth is OAuth: POST <base-minus-/v1>/device/refresh with {"refresh_token":"omr_..."} returns
    a fresh access_token AND ROTATES the refresh token — persist the new one or the next call 401s.
  - Models: gpt-6-astra, gpt-6.1-sol, gpt-6-sol.

STEPS (verify after each; stop and report if a check fails):

1. Preflight: confirm `node --version` >= 20 and `git --version`. Report both.

2. Credentials: run `npm install -g omnirush2api` then `omnirush2api login`.
   Then run `omnirush2api check` and report ONLY whether an account is detected and whether
   ~/.omnirush2api/tokens.json exists — never the values inside it.
   Note: the OmniRush desktop app's own token file (clientToken/hostToken/ownerToken) is NOT
   usable; a `refreshToken` is required.

3. Install the proxy: clone/copy this repo to ~/omnirush-proxy (or run ./install.sh, which
   performs steps 3-6 for you). Confirm src/proxy.mjs exists.

4. Seed the store: `mkdir -p ~/.omnirush-proxy && cp ~/.omnirush2api/tokens.json
   ~/.omnirush-proxy/tokens.json && chmod 600 ~/.omnirush-proxy/tokens.json`.
   Verify the file mode is 600.

5. Start it and prove it works BEFORE installing the service:
   - start in the background
   - `curl -s http://127.0.0.1:20129/v1/health` → expect "status":"healthy", "account_count":1
   - `curl -s http://127.0.0.1:20129/v1/chat/completions -H 'authorization: Bearer sk-omnirush'
      -H 'content-type: application/json' -d '{"model":"sol","messages":[{"role":"user",
      "content":"Reply with exactly: PROXY_OK"}]}'` → expect PROXY_OK
   If you get 403 official_client_required: bump the presented version (see WHAT YOU ARE
   BRIDGING) and retry once, then report.

6. Install the background service (`./install.sh --service-only`) and confirm with
   `scripts/ctl.sh status` that a pid is shown and the endpoint is healthy.

7. Wire Hermes:
   - append `OMNIRUSH_API_KEY=sk-omnirush` to ~/.hermes/.env if absent (this is a local dummy
     key, not an OmniRush secret)
   - `hermes config set providers.omnirush '<json from SETUP.md step 6>'`
   - add the three aliases with DOTTED paths (`hermes config set model_aliases.astra '{...}'`),
     because setting the whole section is refused and --force would delete existing aliases.
   - verify with `hermes config get providers.omnirush` and `hermes config get model_aliases`

8. End-to-end proof, by running these two commands:
   - `hermes chat -q "Reply with exactly this and nothing else: HERMES_OMNIRUSH_OK" -m astra`
   - `hermes chat -q "Use your terminal tool to run: echo TOOLCALL_WORKS && uname -s" -m sol`
   Both must return the expected text, and the second must show a real tool invocation.

9. Run `scripts/ctl.sh test` for the full suite (streaming, tool calls in both modes,
   multi-turn tool results, 401/404 paths).

REPORT AT THE END, in this order:
  - Status: done / blocked at step N
  - Files created, with absolute paths
  - Exact verification commands run and their REAL observed results (trimmed, no secrets)
  - Anything that failed, what you tried, and what the user must do manually
  - Any place where reality differed from the facts listed above (this is the most useful
    part of the report — the vendor changes its gateway periodically)

DO NOT STOP until the two commands in step 8 both return the expected output.
```

---

## Notes for the human handing this over

- Give the agent the repo (or just this file plus `SETUP.md`) and shell access. It needs
  network access for `npm install` and for the device login.
- The login in step 2 may open a browser or print a device code. If it blocks waiting for you,
  approve it — the agent cannot authorise your account for you.
- If the agent reports `403 official_client_required`, the vendor bumped its client version:
  that is a one-line fix, not a broken install (see `SETUP.md § Troubleshooting`).
