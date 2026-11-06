#!/usr/bin/env node
/**
 * omnirush-proxy — local OpenAI-compatible gateway in front of OmniRush's Responses API.
 *
 * Why this exists: OmniRush's gateway only accepts POST /v1/responses with
 * `stream: true` + `store: false` when the caller looks like the official client
 * (`User-Agent: omnirush`, `X-OmniRush-Client: cli/<version>`) and carries no
 * `x-omnirush-session-id` header. Anything else gets `403 official_client_required`,
 * and the plain chat/completions path answers `404 unsupported_model_endpoint`.
 * This proxy translates Chat Completions <-> Responses so Hermes (and any other
 * OpenAI-compatible client) can use the free GPT-6 models.
 *
 * Zero dependencies. Node >= 20.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- config
const CFG = {
  port: Number(process.env.OMNIRUSH_PROXY_PORT || 20129),
  host: process.env.OMNIRUSH_PROXY_HOST || '127.0.0.1',
  clientKey: process.env.OMNIRUSH_PROXY_KEY || 'sk-omnirush',
  gateway: process.env.OMNIRUSH_GATEWAY_URL || 'https://omnirush.ai/omnirush/v1',
  clientVersion: process.env.OMNIRUSH_CLIENT_VERSION || '2.8.2',
  store: process.env.OMNIRUSH_PROXY_STORE ||
    path.join(os.homedir(), '.omnirush-proxy', 'tokens.json'),
  seedStore: process.env.OMNIRUSH_SEED_STORE ||
    path.join(os.homedir(), '.omnirush2api', 'tokens.json'),
  idleTimeoutMs: Number(process.env.OMNIRUSH_IDLE_TIMEOUT_MS || 180000),
};

export const MODELS = [
  { id: 'gpt-6-astra', alias: ['astra', 'gpt-6', 'omnirush'], context: 200000, maxOut: 16384, note: 'Flagship deep reasoning' },
  { id: 'gpt-6.1-sol', alias: ['sol-pro'], context: 200000, maxOut: 16384, note: 'Frontier reasoning & coding' },
  { id: 'gpt-6-sol', alias: ['sol'], context: 128000, maxOut: 8192, note: 'Low-latency high-speed' },
];
const MODEL_ID = new Map();
for (const m of MODELS) {
  MODEL_ID.set(m.id, m);
  for (const a of m.alias) MODEL_ID.set(a, m);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- tokens
class TokenStore {
  constructor() {
    this.refreshToken = null;
    this.accessToken = null;
    this.gateway = CFG.gateway;
    this.email = null;
    this.accessExpiresAt = 0;
    this.inflight = null;
    this.load();
  }

  load() {
    for (const p of [CFG.store, CFG.seedStore]) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const t = Array.isArray(raw?.tokens) ? raw.tokens[0] : raw;
        if (t?.refreshToken || t?.refresh_token) {
          this.refreshToken = t.refreshToken || t.refresh_token;
          this.accessToken = t.accessToken || t.access_token || null;
          this.gateway = t.gatewayUrl || t.gateway_url || CFG.gateway;
          this.email = t.email || null;
          log(`tokens loaded from ${p}${this.email ? ` (${this.email})` : ''}`);
          if (this.accessToken) this.accessExpiresAt = Date.now() + 60_000; // assume short-lived until refreshed
          return;
        }
      } catch { /* try next source */ }
    }
    log('WARNING: no OmniRush credentials found — run `omnirush2api login` (or `omnirush login`)');
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(CFG.store), { recursive: true });
      const tmp = CFG.store + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        tokens: [{
          refreshToken: this.refreshToken,
          accessToken: this.accessToken,
          gatewayUrl: this.gateway,
          email: this.email,
          updatedAt: Date.now(),
        }],
      }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, CFG.store);
    } catch (e) {
      log('WARN: could not persist tokens:', e.message);
    }
  }

  controlPlane() {
    const g = (this.gateway || CFG.gateway).replace(/\/+$/, '');
    return g.endsWith('/v1') ? g.slice(0, -3) : g;
  }

  /** Returns a valid access token, refreshing (and persisting) when near expiry. */
  async get() {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 300_000) return this.accessToken;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async refresh() {
    if (!this.refreshToken) throw new Error('no refresh token configured');
    const url = `${this.controlPlane()}/device/refresh`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `omnirush/${CFG.clientVersion} (${process.platform === 'darwin' ? 'darwin' : process.platform}; ${process.arch === 'arm64' ? 'arm64' : 'x64'})`,
        'X-OmniRush-Client': `cli/${CFG.clientVersion}`,
      },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    const d = JSON.parse(text);
    if (!d.access_token) throw new Error('token refresh returned no access_token');
    const rotated = d.refresh_token && d.refresh_token !== this.refreshToken;
    this.accessToken = d.access_token;
    if (d.refresh_token) this.refreshToken = d.refresh_token;
    if (d.gateway_url) this.gateway = d.gateway_url;
    this.accessExpiresAt = Date.now() + (Number(d.expires_in) > 0 ? Number(d.expires_in) * 1000 : 3600_000);
    this.save();
    log(`access token refreshed (valid ~${Math.round((this.accessExpiresAt - Date.now()) / 60000)}m)${rotated ? ' [refresh token rotated]' : ''}`);
    return this.accessToken;
  }
}
const tokens = new TokenStore();

// ---------------------------------------------------------------- translate: chat -> responses
export function flattenContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts = [], images = [];
  for (const part of content) {
    if (typeof part === 'string') { texts.push(part); continue; }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text') texts.push(part.text || '');
    else if (part.type === 'image_url' || part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) images.push({ type: 'input_image', image_url: url });
    }
  }
  return { text: texts.join('\n'), images };
}

export function chatToResponses(body) {
  const instructions = [];
  const input = [];
  for (const msg of body.messages || []) {
    const role = msg.role === 'developer' ? 'system' : msg.role;
    if (!role) continue;
    if (role === 'system') {
      const { text } = flattenContent(msg.content);
      if (text.trim()) instructions.push(text);
      continue;
    }
    // assistant turn that requested tools -> function_call items
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const { text } = flattenContent(msg.content);
      if (text.trim()) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id || tc.call_id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: tc.function?.name || tc.name || 'unknown',
          arguments: typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const { text } = flattenContent(msg.content);
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || msg.call_id || '',
        output: text || (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')),
      });
      continue;
    }
    const { text, images } = flattenContent(msg.content);
    const content = [];
    if (text.trim() || images.length === 0) {
      content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text });
    }
    content.push(...images);
    input.push({ type: 'message', role, content });
  }

  const payload = {
    model: MODEL_ID.get(body.model)?.id || body.model,
    input,
    stream: true,          // gateway requires streaming
    store: false,          // gateway requires store:false
  };
  if (instructions.length) payload.instructions = instructions.join('\n\n');

  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.map((t) => {
      const f = t.function || t;
      return {
        type: 'function',
        name: f.name,
        ...(f.description ? { description: f.description } : {}),
        ...(f.parameters ? { parameters: f.parameters } : {}),
      };
    }).filter((t) => t.name);
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') payload.tool_choice = tc;
    else if (tc.type === 'function' && tc.function?.name) payload.tool_choice = { type: 'function', name: tc.function.name };
  }
  // parameters the upstream accepts; everything else is deliberately dropped
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (typeof body.top_p === 'number') payload.top_p = body.top_p;
  if (body.reasoning_effort) payload.reasoning_effort = body.reasoning_effort;
  const maxOut = body.max_completion_tokens ?? body.max_tokens;
  if (Number.isFinite(maxOut) && maxOut > 0) payload.max_output_tokens = Math.floor(maxOut);
  if (body.parallel_tool_calls !== undefined) payload.parallel_tool_calls = !!body.parallel_tool_calls;
  if (body.metadata && typeof body.metadata === 'object') payload.metadata = body.metadata;
  return payload;
}

// ---------------------------------------------------------------- upstream call
async function upstreamResponses(payload) {
  const access = await tokens.get();
  const url = `${(tokens.gateway || CFG.gateway).replace(/\/+$/, '')}/responses`;
  const ctl = new AbortController();
  let idle = setTimeout(() => ctl.abort(new Error('upstream idle timeout')), CFG.idleTimeoutMs);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(new Error('upstream idle timeout')), CFG.idleTimeoutMs); };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${access}`,
      'user-agent': 'omnirush',
      'X-OmniRush-Client': `cli/${CFG.clientVersion}`,
      // NOTE: deliberately no x-omnirush-session-id — the gateway 403s it as unofficial
    },
    body: JSON.stringify(payload),
    signal: ctl.signal,
  });
  return { res, bump, done: () => clearTimeout(idle) };
}

function upstreamError(status, text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  const err = parsed?.error || parsed;
  const message = err?.message || text.slice(0, 400) || `HTTP ${status}`;
  const code = err?.code || (status === 429 ? 'rate_limit_exceeded' : 'upstream_error');
  const type = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error';
  return { status: status === 401 ? 401 : status, body: { error: { message, type, code } } };
}

// ---------------------------------------------------------------- SSE parsing
async function* sseEvents(res, bump) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    bump();
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* ignore keep-alives */ }
    }
  }
}

// ---------------------------------------------------------------- translate: responses -> chat
export function chunkFrame(id, model, delta, finish = null, usage = undefined) {
  const frame = {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) frame.usage = usage;
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export function buildChatCompletion(id, model, { text, reasoning, toolCalls, finish, usage }) {
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments || '{}' },
          })),
        } : {}),
      },
      finish_reason: finish,
    }],
    ...(usage ? { usage } : {}),
  };
}

export function usageFrom(u) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    ...(u.output_tokens_details?.reasoning_tokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: u.output_tokens_details.reasoning_tokens } } : {}),
  };
}

/** Runs one upstream stream, driving callbacks; returns assembled output. */
async function runStream(payload, onDelta) {
  const { res, bump, done } = await upstreamResponses(payload);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    done();
    return { error: upstreamError(res.status, text) };
  }
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const state = {
    id, text: '', reasoning: '', toolCalls: [], toolIndex: new Map(),
    finish: 'stop', usage: undefined, model: payload.model, error: null,
  };
  for await (const ev of sseEvents(res, bump)) {
    const t = ev.type;
    if (t === 'response.created') {
      state.model = ev.response?.model || state.model;
      onDelta({ kind: 'meta', model: state.model });
    } else if (t === 'response.output_text.delta' && typeof ev.delta === 'string') {
      state.text += ev.delta;
      onDelta({ kind: 'content', value: ev.delta });
    } else if ((t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta'
      || t === 'response.reasoning.delta') && typeof ev.delta === 'string') {
      state.reasoning += ev.delta;
      onDelta({ kind: 'reasoning', value: ev.delta });
    } else if (t === 'response.output_item.added' && ev.item?.type === 'function_call') {
      const idx = state.toolCalls.length;
      const callId = ev.item.call_id || ev.item.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      state.toolIndex.set(ev.item.id || callId, idx);
      state.toolCalls.push({ id: callId, name: ev.item.name || 'unknown', arguments: '' });
      onDelta({ kind: 'tool_start', index: idx, id: callId, name: ev.item.name || 'unknown' });
    } else if (t === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
      const idx = state.toolIndex.get(ev.item_id) ?? Math.max(state.toolCalls.length - 1, 0);
      if (state.toolCalls[idx]) state.toolCalls[idx].arguments += ev.delta;
      onDelta({ kind: 'tool_args', index: idx, value: ev.delta });
    } else if (t === 'response.completed') {
      const r = ev.response || {};
      state.usage = usageFrom(r.usage);
      const hasCalls = (r.output || []).some((o) => o.type === 'function_call') || state.toolCalls.length > 0;
      state.finish = r.status === 'incomplete'
        ? (String(r.incomplete_details?.reason || '').includes('max') ? 'length' : 'stop')
        : hasCalls ? 'tool_calls' : 'stop';
    } else if (t === 'response.failed' || t === 'error') {
      const err = ev.response?.error || ev.error || ev;
      state.error = { status: 502, body: { error: { message: err?.message || 'upstream stream failed', type: 'api_error', code: err?.code || 'stream_failed' } } };
    }
  }
  done();
  return state;
}

// ---------------------------------------------------------------- HTTP server
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function authorized(req) {
  if (!CFG.clientKey) return true;
  const h = req.headers.authorization || req.headers['x-api-key'] || '';
  const token = String(h).replace(/^Bearer\s+/i, '').trim();
  return token === CFG.clientKey;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (p === '/health' || p === '/v1/health') {
    const healthy = !!tokens.refreshToken;
    return sendJson(res, 200, {
      status: healthy ? 'healthy' : 'unhealthy',
      version: 'omnirush-proxy/1.1.0',
      mode: 'local-daemon',
      account: tokens.email || null,
      account_count: healthy ? 1 : 0,
      active_accounts: healthy ? 1 : 0,
      access_token_cached: !!tokens.accessToken,
      client_version: `cli/${CFG.clientVersion}`,
      supported_models: MODELS.map((m) => m.id),
    });
  }

  if (p === '/v1/models' && req.method === 'GET') {
    return sendJson(res, 200, {
      object: 'list',
      data: MODELS.map((m) => ({
        id: m.id, object: 'model', created: Math.floor(Date.now() / 1000),
        owned_by: 'omnirush.ai', root: m.id,
        context_length: m.context, max_output_tokens: m.maxOut,
      })),
    });
  }

  if (p === '/v1/chat/completions' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: { message: 'invalid api key', type: 'authentication_error', code: 'invalid_api_key' } });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } }); }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return sendJson(res, 400, { error: { message: "missing required 'messages' field", type: 'invalid_request_error' } });
    }
    const model = MODEL_ID.get(body.model)?.id || body.model;
    if (!MODEL_ID.has(body.model)) {
      return sendJson(res, 404, { error: { message: `model '${body.model}' not found`, type: 'invalid_request_error', code: 'model_not_found' } });
    }
    let payload;
    try { payload = chatToResponses({ ...body, model }); } catch (e) {
      return sendJson(res, 400, { error: { message: `could not translate request: ${e.message}`, type: 'invalid_request_error' } });
    }

    const wantStream = body.stream === true;
    try {
      if (!wantStream) {
        const state = await runStream(payload, () => {});
        if (state.error) return sendJson(res, state.error.status, state.error.body);
        return sendJson(res, 200, buildChatCompletion(state.id, state.model, {
          text: state.text, reasoning: state.reasoning, toolCalls: state.toolCalls,
          finish: state.finish, usage: state.usage,
        }));
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      });
      let sentRole = false;
      let currentId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      let currentModel = model;
      const emit = (delta, finish = null, usage) => {
        if (res.writableEnded) return;
        res.write(chunkFrame(currentId, currentModel, delta, finish, usage));
      };
      const state = await runStream(payload, ({ kind, value, index, id, name, model: m }) => {
        if (kind === 'meta') { if (m) currentModel = m; return; }
        if (!sentRole) { sentRole = true; emit({ role: 'assistant', content: '' }); }
        if (kind === 'content') emit({ content: value });
        else if (kind === 'reasoning') emit({ reasoning_content: value });
        else if (kind === 'tool_start') emit({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] });
        else if (kind === 'tool_args') emit({ tool_calls: [{ index, function: { arguments: value } }] });
      });
      if (state.error) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(state.error.body)}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        return;
      }
      if (body.stream_options?.include_usage && state.usage) emit({}, null, state.usage);
      emit({}, state.finish);
      res.write('data: [DONE]\n\n');
      res.end();
      log(`stream ok model=${state.model} chars=${state.text.length} reasoning=${state.reasoning.length} tools=${state.toolCalls.length} finish=${state.finish} in=${state.usage?.prompt_tokens ?? '?'} out=${state.usage?.completion_tokens ?? '?'}`);
    } catch (e) {
      log('ERROR chat/completions:', e.message);
      if (!res.headersSent) return sendJson(res, 502, { error: { message: `proxy error: ${e.message}`, type: 'api_error' } });
      if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'api_error' } })}\n\n`); res.end(); }
    }
    return;
  }

  // raw passthrough for Responses-aware clients
  if (p === '/v1/responses' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } }); }
    const payload = { ...body, stream: true, store: false };
    if (body.model && MODEL_ID.has(body.model)) payload.model = MODEL_ID.get(body.model).id;
    try {
      const { res: up, bump, done } = await upstreamResponses(payload);
      if (!up.ok) {
        const text = await up.text().catch(() => '');
        done();
        const e = upstreamError(up.status, text);
        return sendJson(res, e.status, e.body);
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      const decoder = new TextDecoder();
      for await (const chunk of up.body) { bump(); res.write(decoder.decode(chunk, { stream: true })); }
      done();
      res.end();
    } catch (e) {
      if (!res.headersSent) return sendJson(res, 502, { error: { message: `proxy error: ${e.message}`, type: 'api_error' } });
      res.end();
    }
    return;
  }

  sendJson(res, 404, { error: { message: `unknown path ${p}`, type: 'invalid_request_error' } });
});

// Resolve the official client version to masquerade as. The gateway refuses stale
// versions, so unless pinned explicitly we ask npm for whatever `omnirush@latest`
// is and fall back to the built-in default when offline.
async function resolveClientVersion() {
  if (process.env.OMNIRUSH_CLIENT_VERSION) return;
  try {
    const r = await fetch('https://registry.npmjs.org/omnirush/latest', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (typeof j?.version === 'string' && /^\d+\.\d+\.\d+/.test(j.version)) {
      CFG.clientVersion = j.version;
    }
  } catch { /* offline — keep the pinned default */ }
}

// Only serve when run directly; importing the module (e.g. from tests) exposes the
// pure translator functions without binding a port.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await resolveClientVersion();
  server.listen(CFG.port, CFG.host, () => {
    log(`omnirush-proxy listening on http://${CFG.host}:${CFG.port}/v1`);
    log(`  upstream : ${tokens.gateway || CFG.gateway}/responses`);
    log(`  client   : cli/${CFG.clientVersion} (User-Agent: omnirush)`);
    log(`  account  : ${tokens.email || 'NONE — run: omnirush2api login'}`);
    log(`  api key  : ${CFG.clientKey ? 'required (Bearer ' + CFG.clientKey + ')' : 'open'}`);
  });
}
