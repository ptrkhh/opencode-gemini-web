import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './browser.mjs';

export async function ensureServer({ fetchImpl = fetch, spawnImpl = spawn, keyPath = join(stateDir, 'key') } = {}) {
  if (!existsSync(keyPath)) return 'not-configured';
  const key = readFileSync(keyPath, 'utf8').trim();
  const response = await fetchImpl('http://127.0.0.1:19323/v1/models', {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);
  if (response?.status === 200) return 'running';
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
  spawnImpl('node', [cli, 'start'], { detached: true, stdio: 'ignore' }).unref();
  return 'started';
}
