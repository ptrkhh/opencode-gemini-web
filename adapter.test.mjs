import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createAdapter, repairToolReply, RequestError } from './adapter.mjs';

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
  handoff: 'Reply to continue and I will read the file.',
  handoffAfterSentence: 'I found the implementation. Please reply to continue and I’ll read the file.',
  fencedHandoff: 'Here is the message to copy:\n\n```text\nReply to continue and I will read the file.\n```',
  quotedHandoff: 'If the UI displays "Reply to continue and I will read the file", report it.',
  legitimateBudget: 'The runner says tool calls are permitted. The work is complete.',
  windowsFence: call.replaceAll('\n', '\r\n'),
  sourceExample: call.replace('```json', '```javascript'),
  listExample: '- For documentation, the example request is:\n\n' + call.split('\n').map(line => '  ' + line).join('\n'),
  upstreamError: 'Sorry, something went wrong. Please try again.',
  multiple: fenced(JSON.stringify({ opencode_tool_calls: [code.opencode_tool_call,
    { name: 'read', arguments: { path: 'second' } }] })),
  invalidBatch: fenced(JSON.stringify({ opencode_tool_calls: [code.opencode_tool_call,
    { name: 'write', arguments: { path: 'second' } }] })),
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

test('keeps the tool loop going for the recorded handoff and detects browser errors separately', async () => {
  for (const name of ['handoff', 'handoffAfterSentence']) {
    const handoff = await ask(name);
    assert.equal(handoff.status, 502);
    assert.equal((await handoff.json()).error.code, 'gemini_tool_handoff');
  }
  assert.equal((await callOf(await ask('handoff', { tool_choice: 'none' }))).finish_reason, 'stop');
  assert.equal((await callOf(await ask('quotedHandoff'))).finish_reason, 'stop');
  assert.equal((await callOf(await ask('fencedHandoff'))).finish_reason, 'stop');
  assert.equal((await callOf(await ask('legitimateBudget'))).finish_reason, 'stop');
  const upstream = await ask('upstreamError');
  assert.equal(upstream.status, 502);
  assert.equal((await upstream.json()).error.code, 'gemini_upstream_error');
});

test('makes a single short correction in the same chat and stops if that fails', async () => {
  const prompts = [];
  const handoff = new RequestError(502, 'unfinished', 'gemini_tool_handoff');
  const validate = text => {
    if (text !== call) throw handoff;
    return { finish: 'tool_calls' };
  };
  const submit = async prompt => { prompts.push(prompt); return prompts.length === 1 ? replies.handoff : call; };
  assert.deepEqual(await repairToolReply(submit, 'full initial conversation', validate), { finish: 'tool_calls' });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /call.*tool/i);
  assert.ok(!prompts[1].includes(prompts[0]));
  await assert.rejects(repairToolReply(async () => replies.handoff, 'initial', validate),
    { status: 422, code: 'gemini_tool_handoff' });
  const malformed = new RequestError(502, 'bad JSON', 'gemini_bad_tool_json');
  let attempts = 0;
  await assert.rejects(repairToolReply(async () => 'some text', 'initial', () => {
    if (++attempts === 1) throw malformed;
    return { finish: 'stop' };
  }), { status: 422, code: 'gemini_bad_tool_json' });
  await assert.rejects(repairToolReply(async () => {
    throw new RequestError(429, 'limited');
  }, 'initial', validate), { status: 429 });
});

test('validates a whole batch of independent tool calls and streams their indexes', async () => {
  const response = await ask('multiple', { parallel_tool_calls: true, stream: true });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: {'));
  const delta = JSON.parse(events[1].slice(6)).choices[0].delta.tool_calls;
  assert.deepEqual(delta.map(({ index, function: fn }) => [index, fn.name, JSON.parse(fn.arguments).path]),
    [[0, 'read', code.opencode_tool_call.arguments.path], [1, 'read', 'second']]);
  assert.notEqual(delta[0].id, delta[1].id);
  assert.equal((await ask('multiple', { parallel_tool_calls: false })).status, 502);
  assert.equal((await ask('invalidBatch', { parallel_tool_calls: true })).status, 502);
});

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
  assert.equal((await callOf(await ask('windowsFence'))).finish_reason, 'tool_calls');
  assert.equal((await callOf(await ask('sourceExample'))).finish_reason, 'stop');
  assert.equal((await callOf(await ask('listExample'))).finish_reason, 'stop');
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

test('passes normalized tool turns and an OpenCode session to transports that support reuse', async t => {
  const seen = [];
  const probe = createAdapter(key, async (_prompt, _signal, _model, format, _onText, continuation) => {
    seen.push(continuation);
    return format('ok');
  }, () => models);
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  t.after(() => { probe.closeAllConnections(); probe.close(); });
  const session = 'ses_123456789abcabcdefghijklmn';
  const post = async (tools, id) => {
    const response = await fetch(`http://127.0.0.1:${probe.address().port}/v1/chat/completions`, {
      method: 'POST', headers: {
        Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
        'x-opencode-session': 'ses_aaaaaaaaaaaaparentsessionx',
        ...(id === undefined ? {} : { 'x-opencode-session-id': id }),
      },
      body: JSON.stringify({ model, messages, tools }),
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  await post([tool], session);
  await post([], session);
  await post([tool], 'unscoped');
  await post([tool], undefined);
  await post([tool], 'ses_123456789abcabcdefghijklmo');
  assert.equal(seen[0]?.session, session);
  assert.deepEqual(seen[0].messages.map(({ role, content }) => ({ role, content })), messages);
  assert.match(seen[0].instructions, /Available tools:/);
  assert.equal(seen[1], undefined);
  assert.equal(seen[2], undefined);
  assert.equal(seen[3], undefined);
  assert.equal(seen[4].session, 'ses_123456789abcabcdefghijklmo');
});

test('delivers text before generation completes and sends SSE errors after partial output', async t => {
  const { promise: hold, resolve: release } = Promise.withResolvers();
  const probe = createAdapter(key, async (prompt, _signal, _model, _format, onText) => {
    if (prompt.includes('"name":"read"')) {
      assert.equal(onText, undefined);
      return call;
    }
    if (!onText) return 'First second';
    await onText('First');
    await hold;
    if (prompt.includes('interrupt')) throw new RequestError(502, 'Gemini lost its stream.', 'gemini_direct_failed');
    if (prompt.includes('rewrite')) return 'Revised text';
    await onText(' second');
    return 'First second';
  }, () => models);
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  t.after(() => { release(); probe.closeAllConnections(); probe.close(); });
  const post = body => fetch(`http://127.0.0.1:${probe.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, ...body }), signal: AbortSignal.timeout(3000),
  });
  const response = await post({});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let events = '';
  while (!events.includes('"content":"First"')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    events += decoder.decode(value, { stream: true });
  }
  assert.doesNotMatch(events, /second|\[DONE\]/);
  release();
  for (let item = await reader.read(); !item.done; item = await reader.read()) events += decoder.decode(item.value, { stream: true });
  const parts = events.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.equal(parts.map(part => part.choices[0].delta.content ?? '').join(''), 'First second');
  assert.equal(parts.at(-1).choices[0].finish_reason, 'stop');
  assert.match(events, /data: \[DONE\]/);

  const interrupted = await post({ messages: [{ role: 'user', content: 'interrupt' }] });
  const partial = await interrupted.text();
  assert.equal(interrupted.status, 200);
  assert.match(partial, /"code":"gemini_direct_failed"/);
  assert.doesNotMatch(partial, /"finish_reason":"stop"|\[DONE\]/);
  const rewritten = await post({ messages: [{ role: 'user', content: 'rewrite' }] });
  assert.match(await rewritten.text(), /"code":"gemini_stream_revised"/);
  assert.equal((await post({stream: false}).then(res => res.json())).choices[0].message.content, 'First second');
  assert.match(await post({ tools: [tool] }).then(res => res.text()), /"finish_reason":"tool_calls"/);
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

test('checks local liveness without opening Gemini and frees canceled queue entries', async t => {
  const { promise: hold, resolve: release } = Promise.withResolvers();
  const { promise: started, resolve: begin } = Promise.withResolvers();
  let generates = 0;
  let listings = 0;
  const probe = createAdapter(key, async () => {
    generates++;
    begin();
    await hold;
    return 'ok';
  }, () => { listings++; return models; });
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  t.after(() => { release(); probe.closeAllConnections(); probe.close(); });
  const origin = `http://127.0.0.1:${probe.address().port}`;
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const post = signal => fetch(origin + '/v1/chat/completions', {
    headers, method: 'POST', body: JSON.stringify({ model, messages }), signal,
  });
  const health = await fetch(origin + '/health', { headers, signal: AbortSignal.timeout(1000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'running');
  const running = post();
  await started;
  const canceled = Array.from({ length: 3 }, () => new AbortController());
  const queued = canceled.map(controller => post(controller.signal).catch(error => error));
  const startedAt = Date.now();
  while ((await probeQueueDepth()) !== 4) {
    assert.ok(Date.now() - startedAt < 1000, 'queue filled');
  }
  const full = await fetch(origin + '/v1/models', { headers });
  assert.equal(full.status, 429);
  assert.equal(full.headers.get('Retry-After'), '10');
  assert.equal(listings, 0);
  canceled.forEach(controller => controller.abort());
  await Promise.all(queued);
  while ((await probeQueueDepth()) !== 1) {
    assert.ok(Date.now() - startedAt < 1000, 'canceled jobs were removed');
  }
  const catalog = fetch(origin + '/v1/models', { headers });
  assert.equal(listings, 0);
  release();
  assert.equal((await running).status, 200);
  assert.equal((await catalog).status, 200);
  assert.equal(generates, 1);
  assert.equal(listings, 1);

  async function probeQueueDepth() {
    const reply = await fetch(origin + '/health', { headers });
    return (await reply.json()).pending;
  }
});
