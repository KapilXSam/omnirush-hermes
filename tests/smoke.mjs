#!/usr/bin/env node
/**
 * smoke.mjs — dependency-free tests for the translation layer.
 *
 * These cover the parts that break silently: request shape sent upstream, the
 * OpenAI tool-call shape returned downstream, usage mapping, and the SSE frame.
 * They need no network and no OmniRush credentials:
 *
 *   node tests/smoke.mjs
 */
import { chatToResponses, buildChatCompletion, usageFrom, chunkFrame, MODELS } from '../src/proxy.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ''}`); fail++; }
};

console.log('== request translation (chat -> responses) ==');
const p = chatToResponses({
  model: 'sol',
  messages: [
    { role: 'system', content: 'Be terse.' },
    { role: 'developer', content: 'Second instruction.' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
  ],
  tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
  tool_choice: { type: 'function', function: { name: 'f' } },
  temperature: 0.5,
  max_tokens: 100,
});
ok('model alias resolved', p.model === 'gpt-6-sol', `got ${p.model}`);
ok('system + developer become instructions', p.instructions === 'Be terse.\n\nSecond instruction.', JSON.stringify(p.instructions));
ok('stream forced true', p.stream === true);
ok('store forced false', p.store === false);
ok('input is an array of items', Array.isArray(p.input) && p.input.length === 1);
ok('user text as input_text', p.input[0].content[0].type === 'input_text' && p.input[0].content[0].text === 'hi');
ok('image mapped to input_image', p.input[0].content[1].type === 'input_image' && p.input[0].content[1].image_url === 'https://x/y.png');
ok('tools in Responses shape', p.tools?.[0].type === 'function' && p.tools[0].name === 'f' && !p.tools[0].function);
ok('tool_choice flattened', p.tool_choice?.type === 'function' && p.tool_choice?.name === 'f');
ok('max_tokens -> max_output_tokens', p.max_output_tokens === 100);
ok('temperature passed through', p.temperature === 0.5);
ok('no chat-only fields leak', !('messages' in p) && !('max_tokens' in p) && !('tool_choice' in p && typeof p.tool_choice === 'string' && p.tool_choice === undefined));

const multi = chatToResponses({
  model: 'astra',
  messages: [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":18}' },
    { role: 'user', content: 'so?' },
  ],
});
ok('multi-turn keeps item order', multi.input.length === 4, JSON.stringify(multi.input.map(i => i.type)));
ok('assistant tool call -> function_call item', multi.input[1].type === 'function_call' && multi.input[1].call_id === 'call_1' && multi.input[1].name === 'get_weather');
ok('tool role -> function_call_output', multi.input[2].type === 'function_call_output' && multi.input[2].call_id === 'call_1');
ok('function_call_output carries output', multi.input[2].output === '{"temp_c":18}');
ok('assistant text uses output_text', (() => {
  const withText = chatToResponses({ model: 'sol', messages: [{ role: 'assistant', content: 'previous' }] });
  return withText.input[0].content[0].type === 'output_text';
})());

console.log('== response translation (responses -> chat) ==');
const built = buildChatCompletion('chatcmpl-1', 'gpt-6-sol', {
  text: 'hello', reasoning: 'thinking', finish: 'tool_calls',
  toolCalls: [{ id: 'call_9', name: 'get_weather', arguments: '{"city":"Rome"}' }],
  usage: usageFrom({ input_tokens: 10, output_tokens: 4, total_tokens: 14 }),
});
ok('object is chat.completion', built.object === 'chat.completion');
ok('finish_reason preserved', built.choices[0].finish_reason === 'tool_calls');
ok('reasoning_content surfaced', built.choices[0].message.reasoning_content === 'thinking');
const tc = built.choices[0].message.tool_calls?.[0];
ok('tool_calls is an array', Array.isArray(built.choices[0].message.tool_calls));
ok('tool call has OpenAI shape {id,type,function{name,arguments}}',
  tc?.type === 'function' && tc?.function?.name === 'get_weather' && tc?.function?.arguments === '{"city":"Rome"}' && tc?.id === 'call_9',
  JSON.stringify(tc));
ok('no flattened name/arguments on the tool call', !('name' in (tc || {})) && !('arguments' in (tc || {})));

const u = usageFrom({ input_tokens: 5, output_tokens: 3, total_tokens: 8, output_tokens_details: { reasoning_tokens: 2 } });
ok('usage mapped to prompt/completion/total', u.prompt_tokens === 5 && u.completion_tokens === 3 && u.total_tokens === 8);
ok('reasoning tokens mapped', u.completion_tokens_details?.reasoning_tokens === 2);

console.log('== SSE frame ==');
const frame = chunkFrame('chatcmpl-2', 'gpt-6-sol', { content: 'x' });
ok('frame is data:-prefixed SSE', frame.startsWith('data: ') && frame.endsWith('\n\n'));
const parsed = JSON.parse(frame.slice(6));
ok('frame parses as a chat.completion.chunk', parsed.object === 'chat.completion.chunk' && parsed.choices[0].delta.content === 'x');
ok('frame carries the given id', parsed.id === 'chatcmpl-2');

console.log('== model catalogue ==');
ok('three models advertised', MODELS.length === 3);
ok('astra is the default alias target', MODELS[0].id === 'gpt-6-astra');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
