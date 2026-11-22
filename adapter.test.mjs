import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createAdapter, RequestError } from './adapter.mjs';

const key = 'local-test-key';
const assistant = { role: 'assistant', content: 'test completed' };
const call = '```json\n{"opencode_tool_call":{"name":"read","arguments":{"path":"README.md"}}}\n```';
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
    assert.match(prompt, /one tool call per reply/i);
    assert.match(prompt, /after a tool result, continue/i);
  }
  if (prompt.includes('Unlisted tool test')) return call.replace('"read"', '"write"');
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
