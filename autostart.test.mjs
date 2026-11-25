import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureServer } from './autostart.mjs';

const dir = mkdtempSync(join(tmpdir(), 'gw-autostart-'));
const keyPath = join(dir, 'key');
writeFileSync(keyPath, 'test-key');
const calls = [];
const fakeSpawn = (cmd, args) => {
  assert.equal(cmd, 'node');
  calls.push(args);
  const child = Object.assign(new EventEmitter(), { unref() {} });
  queueMicrotask(() => child.emit('spawn'));
  return child;
};

test('reports not-configured before the adapter has ever run', async () => {
  const result = await ensureServer({ fetchImpl: () => null, spawnImpl: fakeSpawn, keyPath: join(dir, 'missing') });
  assert.equal(result, 'not-configured');
  assert.equal(calls.length, 0);
});

test('leaves a healthy adapter alone', async () => {
  let auth;
  const urls = [];
  const result = await ensureServer({
    fetchImpl: (url, init) => {
      urls.push(url);
      auth = init.headers.Authorization;
      return Promise.resolve({ status: 200 });
    },
    spawnImpl: fakeSpawn,
    keyPath,
  });
  assert.equal(result, 'running');
  assert.equal(auth, 'Bearer test-key');
  assert.deepEqual(urls, ['http://127.0.0.1:19323/health']);
  assert.equal(calls.length, 0);
});

test('spawns only when no server answers and leaves a port conflict alone', async () => {
  const down = await ensureServer({ fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')), spawnImpl: fakeSpawn, keyPath });
  assert.equal(down, 'started');
  const stale = await ensureServer({ fetchImpl: () => Promise.resolve({ status: 401 }), spawnImpl: fakeSpawn, keyPath });
  assert.equal(stale, 'unavailable');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(a => a.split('/').pop()), ['cli.mjs', 'start']);
});
