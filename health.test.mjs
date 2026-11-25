import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captchaPage, createCooldown, guardPage, pageResponsive, typePrompt } from './health.mjs';

test('a page that answers is responsive; hung or crashed pages are not', async () => {
  assert.equal(await pageResponsive({ evaluate: async () => true }, 50), true);
  assert.equal(await pageResponsive({ evaluate: () => new Promise(() => {}) }, 50), false);
  assert.equal(await pageResponsive({ evaluate: async () => { throw new Error('Target closed'); } }, 50), false);
});

test('the cooldown blocks work until it expires', () => {
  let clock = 1000;
  const cooldown = createCooldown(30_000, () => clock);
  assert.equal(cooldown.active(), false);
  cooldown.trip();
  clock += 29_999;
  assert.equal(cooldown.active(), true);
  clock += 2;
  assert.equal(cooldown.active(), false);
});

test('recognises Google\'s unusual-traffic page and nothing else', () => {
  assert.equal(captchaPage('https://www.google.com/sorry/index?continue=https://gemini.google.com/u/0/app'), true);
  assert.equal(captchaPage('https://www.google.co.uk/sorry/index?q=1'), true);
  assert.equal(captchaPage('https://gemini.google.com/u/0/app?hl=en'), false);
  assert.equal(captchaPage('https://evil.example/https://www.google.com/sorry/'), false);
});

test('typing a prompt clears a restored draft first, in a separate edit from the insert', async () => {
  const calls = [];
  const composer = { focus: async () => calls.push('focus') };
  const keyboard = { press: async key => calls.push('press ' + key), insertText: async text => calls.push('insert ' + text) };
  await typePrompt({ keyboard }, composer, 'prompt');
  assert.deepEqual(calls, ['focus', 'press ControlOrMeta+A', 'press Delete', 'insert prompt']);
});

test('the page watchdog interrupts a hung operation and honors disconnects', async () => {
  const never = new Promise(() => {});
  const hungError = new Error('page unresponsive');
  const signal = new AbortController().signal;
  await assert.rejects(guardPage({ evaluate: () => never }, signal, () => never, () => hungError, 10), /page unresponsive/);
  const client = new AbortController();
  const run = guardPage({ evaluate: async () => true }, client.signal, () => never, () => hungError, 10);
  client.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(await guardPage({}, signal, async () => 'done', () => hungError, 10), 'done');
});
