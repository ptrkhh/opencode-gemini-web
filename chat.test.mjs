import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { observeGeneration } from './chat.mjs';

const request = {
  url: () => 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  method: () => 'POST',
};

test('detects a failed generation before or after headers and ignores unrelated traffic', async () => {
  for (const afterHeaders of [false, true]) {
    const page = new EventEmitter();
    const response = { request: () => request };
    const { promise: started, resolve: receive } = Promise.withResolvers();
    const { promise: reading, resolve: entered } = Promise.withResolvers();
    let matches;
    page.waitForResponse = predicate => { matches = predicate; return started; };
    const generation = observeGeneration(page, async () => {
      page.emit('request', request);
      assert.equal(matches(response), true);
      if (afterHeaders) receive(response);
    }, () => {
      entered();
      return new Promise(() => {});
    });
    if (afterHeaders) await reading;
    else await Promise.resolve();
    page.emit('requestfailed', { ...request });
    assert.equal(page.listenerCount('requestfailed'), 1);
    page.emit('requestfailed', request);
    await assert.rejects(generation, { code: 'gemini_stream_interrupted' });
    assert.equal(page.listenerCount('requestfailed'), 0);
    assert.equal(page.listenerCount('request'), 0);
  }
});
