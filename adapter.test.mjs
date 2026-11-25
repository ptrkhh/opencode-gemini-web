import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createAdapter, RequestError } from './adapter.mjs';

const key = 'local-test-key';
const assistant = { role: 'assistant', content: 'test completed' };
const call = '```json\n{"opencode_tool_call":{"name":"read","arguments":{"path":"README.md"}}}\n```';
const fenced = json => '```json\n' + json + '\n```';
const code = { opencode_tool_call: { name: 'read', arguments: { path: 'a "b" \\ c\n```\n<<<end>>>' } } };
const replies = {
  executed: '```python\nprint(1)\n```\n\n```text\nTraceback: <xbox-string>\n```\n\n' + call,
  roundtrip: fenced(JSON.stringify(code)),
  badfence: fenced('{"opencode_tool_call":{"name":"read","arguments":{"path":"a "b" c"}}}'),
  trailing: call + '\nDone.',
  quoted: 'Example: ' + call + ' is how you call it, as requested.',
  two: fenced('{"opencode_tool_call":{"name":"read","arguments":{"path":"first"}}}') + '\n' + call,
  other: fenced('{"hello":"world"}'),
  untagged: '```\n{"opencode_tool_call":{"name":"read","arguments":{"path":"README.md"}}}\n```',
};
const messages = [{ role: 'system', content: 'System text' }, { role: 'user', content: 'User text' }];
const model = 'hydrogen-thinking';
const pro = '3.1-pro';
let models = [{ id: model, name: '4 Hydrogen Thinking' }, { id: pro, name: '3.1 Pro' }];
const tool = { type: 'function', function: { name: 'read', parameters: { type: 'object' } } };
const server = createAdapter(key, async (prompt, _signal, requestedModel) => {
  assert.match(prompt, /System text/);
  assert.match(prompt, /User text/);
  if (prompt.includes('Expired Gemini session')) {
    throw new RequestError(401, 'Sign in to Gemini again with npm run login.', 'gemini_login_required');
  }
  if (prompt.includes('First tool result')) {
    assert.match(prompt, /no limit on tool calls/i);
    assert.match(prompt, /after a tool result you may call another tool/i);
  }
  if (prompt.includes('Unlisted tool test')) return call.replace('"read"', '"write"');
  if (prompt.includes('Malformed call test')) return '{"opencode_tool_call":{"name":"read","arguments":{"path":"a "b" c"}}}';
  const reply = replies[(prompt.match(/Reply case: (\w+)/) ?? [])[1]];
  if (reply) return reply;
  if (prompt.includes('Tool refusal test')) return 'I cannot act; tool calls are currently unavailable (0 remaining in this turn).';
  if (!models.some(({ id }) => id === requestedModel)) {
    throw new RequestError(404, 'No such model.', 'gemini_model_unavailable');
  }
  return prompt.includes('"name":"read"') ? call : assistant.content;
}, () => models);

let root;
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  root = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

const list = (headers = {}) => fetch(root + '/models', { headers });
const complete = (body) => fetch(root + '/chat/completions', {
  method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages, ...body }),
});

test('requires the local bearer key and lists the live catalog', async () => {
  const unauthorized = await list();
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, 'invalid_adapter_key');
  const response = await list({ Authorization: 'Bearer ' + key });
  assert.deepEqual((await response.json()).data.map(({ id, name }) => ({ id, name })), models);
  models = [{ id: model, name: '4 Hydrogen Thinking' }];
  try {
    const refreshed = await list({ Authorization: 'Bearer ' + key });
    assert.deepEqual((await refreshed.json()).data.map(item => item.id), [model]);
  } finally {
    models.push({ id: pro, name: '3.1 Pro' });
  }
});

test('routes a non-Hydrogen model and echoes its ID in the response', async () => {
  const response = await complete({ model: pro });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, pro);
  const unavailable = await complete({ model: 'unavailable-model' });
  assert.equal(unavailable.status, 404);
  assert.equal((await unavailable.json()).error.code, 'gemini_model_unavailable');
});

test('reports an expired Gemini session independently of the adapter key', async () => {
  const response = await complete({
    stream: true,
    messages: [...messages, { role: 'user', content: 'Expired Gemini session' }],
  });
  assert.equal(response.status, 401);
  const { error } = await response.json();
  assert.equal(error.code, 'gemini_login_required');
  assert.match(error.message, /npm run login/);
});

test('turns a confabulated tool-budget refusal into a retryable 502', async () => {
  const response = await complete({
    tools: [tool],
    messages: [...messages, { role: 'user', content: 'Tool refusal test' }],
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'gemini_tool_refusal');
});

test('turns a tool call with unescaped quotes into a retryable 502', async () => {
  const response = await complete({
    tools: [tool],
    messages: [...messages, { role: 'user', content: 'Malformed call test' }],
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'gemini_bad_tool_json');
});

const ask = async (name, extra = {}) => complete({
  tools: [tool], messages: [...messages, { role: 'user', content: 'Reply case: ' + name }], ...extra,
});
const callOf = async response => (await response.json()).choices[0];

test('takes the final fenced block after code-execution noise', async () => {
  const choice = await callOf(await ask('executed'));
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { path: 'README.md' });
});

test('round-trips quotes, backslashes, fences and delimiters inside a fenced call', async () => {
  const choice = await callOf(await ask('roundtrip'));
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), code.opencode_tool_call.arguments);
});

test('runs the last of two calls and accepts an untagged fence', async () => {
  assert.deepEqual(JSON.parse((await callOf(await ask('two'))).message.tool_calls[0].function.arguments), { path: 'README.md' });
  assert.equal((await callOf(await ask('untagged'))).finish_reason, 'tool_calls');
});

test('rejects a malformed fenced call with a retryable 502', async () => {
  const response = await ask('badfence');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'gemini_bad_tool_json');
});

test('keeps prose, quoted calls and non-call JSON as text; required still demands a call', async () => {
  for (const name of ['trailing', 'quoted', 'other']) {
    const choice = await callOf(await ask(name));
    assert.equal(choice.finish_reason, 'stop', name);
    assert.ok(choice.message.content);
  }
  assert.equal((await ask('trailing', { tool_choice: 'required' })).status, 502);
  assert.equal((await callOf(await ask('roundtrip', { tool_choice: 'none' }))).finish_reason, 'stop');
});

test('asks for one fenced JSON call and forbids code execution', () => {
  let seen = '';
  const probe = createAdapter(key, async prompt => { seen = prompt; return 'ok'; }, () => models);
  return new Promise(resolve => probe.listen(0, '127.0.0.1', async () => {
    await fetch(`http://127.0.0.1:${probe.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: [tool] }),
    });
    assert.match(seen, /one ```json code block/);
    assert.match(seen, /own code execution/);
    probe.close(resolve);
  }));
});

test('offers another tool call after receiving a tool result', async () => {
  const response = await complete({
    tools: [tool],
    messages: [...messages, { role: 'tool', tool_call_id: 'first', content: 'First tool result' }],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].finish_reason, 'tool_calls');
});

test('streams the final text in Chat Completions SSE format', async () => {
  const response = await complete({ stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const events = (await response.text()).match(/^data: (.+)$/gm).map(event => event.slice(6));
  assert.equal(events.pop(), '[DONE]');
  const choices = events.map(event => JSON.parse(event).choices[0]);
  assert.ok(choices.some(choice => choice.delta.content === assistant.content));
  assert.equal(choices.at(-1).finish_reason, 'stop');
});

test('translates a call to a declared tool and rejects an undeclared name', async () => {
  const response = await complete({ tools: [tool] });
  const choice = (await response.json()).choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.tool_calls[0].function.name, 'read');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { path: 'README.md' });
  const rejected = await complete({ tools: [tool], messages: [...messages, {role: 'user', content: 'Unlisted tool test'}] });
  assert.equal(rejected.status, 502);
});

test('rejects requests that cannot be sent as text without silent loss', async () => {
  const response = await complete({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] });
  assert.equal(response.status, 400);
});
