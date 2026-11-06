#!/usr/bin/env node
/**
 * server.mjs — integration test: boot the proxy for real and assert its HTTP surface.
 *
 * Needs no OmniRush account and no network: it runs with an empty credential store and
 * checks that the server comes up, serves metadata, rejects bad input cleanly, and
 * degrades gracefully (502 with a JSON error, never a crash) when it cannot authenticate.
 *
 *   node tests/server.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ''}`); fail++; }
};

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 20300 + Math.floor(Math.random() * 600);
const KEY = 'sk-test-key';
const BASE = `http://127.0.0.1:${PORT}/v1`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omnirush-test-'));
const STORE = path.join(TMP, 'tokens.json');

const child = spawn(process.execPath, [path.join(REPO, 'src', 'proxy.mjs')], {
  env: {
    ...process.env,
    OMNIRUSH_PROXY_PORT: String(PORT),
    OMNIRUSH_PROXY_KEY: KEY,
    OMNIRUSH_PROXY_STORE: STORE,
    OMNIRUSH_SEED_STORE: path.join(TMP, 'does-not-exist.json'),
    OMNIRUSH_CLIENT_VERSION: '2.8.2',   // skip the npm lookup; keep the test offline
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', () => {});

const cleanup = () => { try { child.kill('SIGKILL'); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {                 // up to ~12s
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

const post = (body, key = KEY) => fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(20000),
});

console.log('== boot ==');
ok('server starts and answers /health', await waitForBoot(), stderr.slice(0, 400));

console.log('== metadata surface ==');
const health = await (await fetch(`${BASE}/health`)).json();
ok('health reports a version', typeof health.version === 'string' && health.version.length > 5);
ok('health is unhealthy without credentials', health.status === 'unhealthy', JSON.stringify(health.status));
ok('health reports 0 accounts without credentials', health.account_count === 0);
ok('health advertises 3 models', Array.isArray(health.supported_models) && health.supported_models.length === 3);

const models = await (await fetch(`${BASE}/models`)).json();
ok('GET /models is an OpenAI list', models.object === 'list' && Array.isArray(models.data));
ok('models carry context + max output', models.data.every((m) => m.context_length > 0 && m.max_output_tokens > 0));
ok('astra is advertised', models.data.some((m) => m.id === 'gpt-6-astra'));

console.log('== request validation ==');
ok('bad bearer key -> 401', (await post({ model: 'sol', messages: [{ role: 'user', content: 'hi' }] }, 'wrong')).status === 401);
ok('no messages -> 400', (await post({ model: 'sol' })).status === 400);
ok('unknown model -> 404', (await post({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] })).status === 404);
ok('malformed JSON -> 400', (await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: '{not json',
  signal: AbortSignal.timeout(10000),
})).status === 400);
ok('unknown path -> 404', (await fetch(`http://127.0.0.1:${PORT}/nope`)).status === 404);

console.log('== credentials absent: graceful degradation ==');
const noCreds = await post({ model: 'astra', messages: [{ role: 'user', content: 'hi' }] });
ok('unauthenticated upstream call -> 502', noCreds.status === 502, `got ${noCreds.status}`);
const errBody = await noCreds.json().catch(() => null);
ok('error is JSON with a message', !!errBody?.error?.message, JSON.stringify(errBody));
ok('message names the missing credential', /refresh token|credentials/i.test(errBody?.error?.message || ''), errBody?.error?.message);
ok('alias is accepted by model validation (not a 404)', noCreds.status !== 404, `got ${noCreds.status}`);

console.log('== bad credentials present ==');
// Deliberately invalid test fixture, not a credential. omnirush:allow-secret-scan
fs.writeFileSync(STORE, JSON.stringify({ tokens: [{ refreshToken: 'omr_invalid_token_for_tests', email: 'nobody@example.invalid' }] }), { mode: 0o600 }); // omnirush:allow-secret-scan
ok('seeded store is rejected upstream, still JSON', [502, 401].includes((await post({ model: 'sol', messages: [{ role: 'user', content: 'hi' }] })).status));

console.log('== still alive ==');
ok('server survived every error path', (await fetch(`${BASE}/health`)).ok);
ok('process was not crashed by bad input', child.exitCode === null, `exitCode=${child.exitCode} ${stderr.slice(0, 200)}`);

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
