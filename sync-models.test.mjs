import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncConfig } from './sync-models.mjs';

const keyFile = '/private/key';
const models = [{ id: '3.1-pro', name: '3.1 Pro' }];

test('refreshes the existing provider and preserves other entries and model overrides', () => {
  const config = {
    enabled_providers: ['llama-swap'],
    provider: {
      'llama-swap': { name: 'Local' },
      'gemini-web': {
        options: { baseURL: 'http://127.0.0.1:19323/v1', timeout: 200000 },
        models: { '3.1-pro': { limit: { context: 8000 } }, 'old-model': {} },
      },
    },
  };
  const synced = syncConfig(config, models, keyFile);
  assert.deepEqual(synced.enabled_providers, ['llama-swap', 'gemini-web']);
  assert.equal(synced.provider['llama-swap'], config.provider['llama-swap']);
  assert.equal(synced.provider['gemini-web'].options.timeout, 200000);
  assert.deepEqual(synced.provider['gemini-web'].models, {
    '3.1-pro': { name: '3.1 Pro', tool_call: true, limit: { context: 8000 } },
  });
  assert.ok(config.provider['gemini-web'].models['old-model']);
});

test('creates a modern provider and refuses to replace a different endpoint', () => {
  const synced = syncConfig({}, models, keyFile);
  const provider = synced.providers['gemini-web'];
  assert.equal(provider.settings.apiKey, '{file:/private/key}');
  assert.deepEqual(provider.models['3.1-pro'].capabilities, { tools: true });
  assert.deepEqual(synced.plugins, ['opencode-gemini-web']);
  provider.settings.baseURL = 'http://another-server/v1';
  assert.throws(() => syncConfig(synced, models, keyFile), /different endpoint/);
  assert.throws(() => syncConfig({}, [], keyFile), /empty model list/);
});

test('registers the autostart plugin, merges existing entries, and honors the opt-out', () => {
  assert.deepEqual(syncConfig({ plugins: ['other'] }, models, keyFile).plugins, ['other', 'opencode-gemini-web']);
  assert.deepEqual(syncConfig({}, models, keyFile).plugins, ['opencode-gemini-web']);
  const optedOut = syncConfig({ plugins: ['-opencode-gemini-web'] }, models, keyFile);
  assert.deepEqual(optedOut.plugins, ['-opencode-gemini-web']);
  const legacy = syncConfig({ provider: { 'gemini-web': { options: { baseURL: 'http://127.0.0.1:19323/v1' } } } }, models, keyFile);
  assert.deepEqual(legacy.plugin, ['opencode-gemini-web']);
});
