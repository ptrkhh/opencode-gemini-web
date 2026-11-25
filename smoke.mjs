import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './browser.mjs';

const base = 'http://127.0.0.1:19323/v1';
const limit = 380_000;
const explicitModel = process.argv[2] === 'smoke' ? process.argv[3] : process.argv[2];

try {
  const key = readFileSync(join(stateDir, 'key'), 'utf8').trim();
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const request = async (path, options, timeout) => {
    const response = await fetch(base + path, { ...options, headers, signal: AbortSignal.timeout(timeout) });
    const payload = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.error?.message ?? response.statusText}`);
    return payload;
  };
  let model = explicitModel;
  if (!model) {
    const { data } = await request('/models', {}, 65_000);
    model = data.find(({ id }) => id.includes('hydrogen'))?.id ?? data[0]?.id;
    if (!model) throw new Error('Gemini has no available models.');
  }
  const body = JSON.stringify({
    model,
    tools: [{
      type: 'function',
      function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    }],
    messages: [
      { role: 'system', content: 'Smoke test context with "quotes", `code` and <tags>. '.repeat(750) },
      { role: 'user', content: 'Reply with exactly: OK' },
    ],
  });
  const started = Date.now();
  const result = await request('/chat/completions', { method: 'POST', body }, limit);
  if (result.choices?.[0]?.message?.content?.trim() !== 'OK') throw new Error('Expected Gemini to reply with OK.');
  console.log(`OK: ${Buffer.byteLength(body)} byte request answered in ${(Date.now() - started) / 1000}s by ${model}.`);
} catch (error) {
  const message = error.code === 'ENOENT' || error.cause?.code === 'ECONNREFUSED'
    ? 'Start the adapter with opencode-gemini-web start.'
    : error.message;
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}
