import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureServer } from './autostart.mjs';

const dir = mkdtempSync(join(tmpdir(), 'gw-autostart-'));
const keyPath = join(dir, 'key');
writeFileSync(keyPath, 'test-key');
const calls = [];
const fakeSpawn = (_cmd, args) => { calls.push(args); return { unref() {} }; };

test('reports not-configured before the adapter has ever run', async () => {
  const result = await ensureServer({ fetchImpl: () => null, spawnImpl: fakeSpawn, keyPath: join(dir, 'missing') });
  assert.equal(result, 'not-configured');
  assert.equal(calls.length, 0);
});

test('leaves a healthy adapter alone', async () => {
  let auth;
  const result = await ensureServer({
    fetchImpl: (url, init) => { auth = init.headers.Authorization; return Promise.resolve({ status: 200 }); },
    spawnImpl: fakeSpawn,
    keyPath,
  });
  assert.equal(result, 'running');
  assert.equal(auth, 'Bearer test-key');
  assert.equal(calls.length, 0);
});

test('spawns the adapter when it is unreachable or answers the wrong key', async () => {
  const down = await ensureServer({ fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')), spawnImpl: fakeSpawn, keyPath });
  assert.equal(down, 'started');
  const stale = await ensureServer({ fetchImpl: () => Promise.resolve({ status: 401 }), spawnImpl: fakeSpawn, keyPath });
  assert.equal(stale, 'started');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].map(a => a.split('/').pop()), ['cli.mjs', 'start']);
});
