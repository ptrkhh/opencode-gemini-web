import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { geminiPageState } from './browser.mjs';

function state(origin, { account = false, signIn = false, insideReply = false } = {}) {
  return runInNewContext(`(${geminiPageState})()`, {
    location: { origin },
    document: {
      querySelector: () => account ? {} : null,
      querySelectorAll: () => signIn
        ? [{ getClientRects: () => [{}], getAttribute: () => null, textContent: 'Sign in', closest: () => insideReply ? {} : null }]
        : [],
    },
  });
}

test('accepts a signed-in Gemini account without a configured email', () => {
  assert.equal(state('https://gemini.google.com', { account: true }), 'ready');
  assert.equal(state('https://gemini.google.com', { account: true, signIn: true, insideReply: true }), 'ready');
});

test('recognizes a Gemini sign-in prompt and a Google Accounts redirect', () => {
  assert.equal(state('https://gemini.google.com', { signIn: true }), 'login-required');
  assert.equal(state('https://accounts.google.com'), 'login-required');
  assert.equal(state('https://gemini.google.com'), null);
  assert.equal(state('https://example.com', { account: true }), null);
});
