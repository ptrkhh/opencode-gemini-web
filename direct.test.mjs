import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDirectBackend } from './direct.mjs';

test('reuses direct sessions, corrects a tool reply in the same chat, and reloads Chrome after auth failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gemini-direct-test-'));
  const worker = join(directory, 'worker.mjs');
  writeFileSync(worker, `
    import { createInterface } from 'node:readline';
    let cookie;
    let priorChat;
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      let result;
      if (!cookie) {
        [cookie] = input.cookies;
        result = { models: [{ id: '4-neon', name: '4 Neon' }] };
      } else if (input.catalog) {
        result = { models: [{ id: '4-neon', name: '4 Neon' }, { id: '4-hydrogen', name: '4 Hydrogen' }] };
      } else if (input.prompt.includes('Conversation:')) {
        if (input.resume && input.prompt.includes('lost context')) {
          result = { error: 'gemini_context_lost', status: 409 };
        } else {
          result = { text: JSON.stringify(input), reusable: true };
        }
      } else if (input.prompt === 'expire') {
        result = { error: 'login' };
      } else if (input.prompt === 'hang') {
        await new Promise(() => setInterval(() => {}, 1000));
      } else if (input.prompt === 'limited') {
        result = { status: 429, retryAfter: '75' };
      } else if (input.prompt === 'model limited') {
        result = { status: 429, error: 'gemini_model_rate_limited', retryAfter: '75' };
      } else if (input.stream) {
        console.log(JSON.stringify({ delta: 'streamed ' }));
        console.log(JSON.stringify({ delta: 'text' }));
        result = { text: 'streamed text' };
      } else {
        result = { text: input.chat === priorChat ? 'corrected' : input.prompt + ':' + cookie.value };
        priorChat = input.chat;
      }
      console.log(JSON.stringify(result));
    }
  `);
  let connections = 0;
  const backend = createDirectBackend({
    command: process.execPath,
    args: [worker],
    readCookies: async () => [{ name: 'fake', value: String(++connections) }],
  });
  t.after(async () => {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await backend.listModels(signal), [{ id: '4-neon', name: '4 Neon' }]);
  assert.equal(await backend.generate('first', signal, '4-neon', text => text), 'first:1');
  const streamed = [];
  assert.equal(await backend.generate('stream', signal, '4-neon', text => text, delta => streamed.push(delta)), 'streamed text');
  assert.deepEqual(streamed, ['streamed ', 'text']);
  const initial = [{ role: 'system', content: 'AGENTS.md context' }, { role: 'user', content: 'read a file' }];
  const answer = { role: 'assistant', content: null, tool_calls: [{
    id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"file"}' },
  }] };
  const toolResult = { role: 'tool', tool_call_id: 'call_1', content: 'file contents' };
  const turn = async (messages, session = 'one', instructions = 'tool instructions', model = '4-neon') => {
    const prompt = instructions + '\nConversation: ' + JSON.stringify(messages);
    let outgoing;
    await backend.generate(prompt, signal, model, text => {
      outgoing = JSON.parse(text);
      return { message: answer, finish: 'tool_calls' };
    }, undefined, { session, instructions, messages });
    return outgoing;
  };
  const full = await turn(initial);
  assert.equal(full.resume, false);
  const continued = await turn([...initial, answer, toolResult]);
  assert.equal(continued.chat, full.chat);
  assert.equal(continued.resume, true);
  assert.match(continued.prompt, /file contents/);
  assert.match(continued.prompt, /call_1/);
  assert.doesNotMatch(continued.prompt, /AGENTS.md context|tool instructions|read a file/);

  const other = await turn([...initial, answer, toolResult], 'two');
  assert.notEqual(other.chat, full.chat);
  assert.match(other.prompt, /AGENTS.md context/);
  const repeated = await turn([...initial, answer, toolResult]);
  assert.equal(repeated.resume, false);
  assert.notEqual(repeated.chat, full.chat);
  const next = [...initial, answer, toolResult, answer, { ...toolResult, content: 'lost context' }];
  const recovered = await turn(next);
  assert.equal(recovered.resume, false);
  assert.notEqual(recovered.chat, repeated.chat);
  assert.match(recovered.prompt, /AGENTS.md context/);
  const edited = await turn([{ ...initial[0], content: 'rewritten context' }, ...next.slice(1), answer, toolResult]);
  assert.equal(edited.resume, false);
  assert.notEqual(edited.chat, recovered.chat);
  const compacted = await turn([{ role: 'user', content: 'short summary' }]);
  assert.equal(compacted.resume, false);
  const changedSchema = await turn([...initial, answer, toolResult, answer, toolResult], 'two', 'changed tools');
  assert.equal(changedSchema.resume, false);
  assert.notEqual(changedSchema.chat, other.chat);
  assert.deepEqual((await backend.listModels(signal)).map(model => model.id), ['4-neon', '4-hydrogen']);
  assert.equal(await backend.generate('next', signal, '4-neon', text => {
    if (text === 'next:1') throw Object.assign(new Error('bad reply'), { code: 'gemini_bad_tool_json' });
    return { finish: 'tool_calls', text };
  }).then(result => result.text), 'corrected');
  assert.equal(connections, 1);
  await assert.rejects(backend.generate('expire', signal, '4-neon', text => text), { status: 401, code: 'gemini_login_required' });
  assert.equal(await backend.generate('resumed', signal, '4-neon', text => text), 'resumed:2');

  const canceled = new AbortController();
  const running = backend.generate('hang', canceled.signal, '4-neon', text => text);
  canceled.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(await backend.generate('ready', signal, '4-neon', text => text), 'ready:3');

  await backend.listModels(signal);
  await assert.rejects(backend.generate('model limited', signal, '4-neon', text => text),
    { status: 429, code: 'gemini_model_rate_limited', retryAfter: 75 });
  await assert.rejects(backend.generate('blocked model', signal, '4-neon', text => text),
    { status: 429, code: 'gemini_model_rate_limited' });
  assert.equal(await backend.generate('working model', signal, '4-hydrogen', text => text), 'working model:3');

  await assert.rejects(backend.generate('limited', signal, '4-hydrogen', text => text), { status: 429, retryAfter: 75 });
  await assert.rejects(backend.listModels(signal), { status: 429 });
  assert.equal(connections, 3);
});
