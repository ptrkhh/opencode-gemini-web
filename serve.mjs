import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdapter } from './adapter.mjs';
import { stateDir } from './browser.mjs';
import { createDirectBackend } from './direct.mjs';

const keyPath = join(stateDir, 'key');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
try {
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const key = readFileSync(keyPath, 'utf8').trim();
const useBrowser = process.env.GEMINI_TRANSPORT === 'browser';
const backend = useBrowser ? await import('./chat.mjs') : createDirectBackend();
const server = createAdapter(key, backend.generate, backend.listModels);
if (backend.close) {
  server.once('close', () => { void backend.close(); });
  const stop = () => {
    server.closeAllConnections();
    server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
server.listen(19323, '127.0.0.1', () => {
  console.log(`Gemini Web adapter listening on 127.0.0.1:19323 (${useBrowser ? 'Chrome' : 'direct HTTP'})`);
  console.log(`OpenCode apiKey file is ${keyPath}`);
});
