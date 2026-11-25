import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './browser.mjs';

// Sends a request the size of a real OpenCode turn (about 40 KB, with tools) through the running adapter.
const key = readFileSync(join(stateDir, 'key'), 'utf8').trim();
const model = process.argv.slice(2).find(arg => arg !== 'smoke') ?? '4-hydrogen'; // 'smoke' is argv[2] when started through the CLI
const limit = 240_000; // matches the adapter's generation timeout; Gemini latency alone varies from 10s to 200s
const body = {
  model,
  tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  messages: [
    { role: 'system', content: 'Smoke test context with "quotes", `code` and <tags>. '.repeat(600) },
    { role: 'user', content: 'Reply with exactly: OK' },
  ],
};
const started = Date.now();
const response = await fetch('http://127.0.0.1:19323/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(limit),
}).catch(error => {
  console.error(error.name === 'TimeoutError'
    ? `FAIL: no reply within ${limit / 1000}s. Gemini may be slow or its page hung.`
    : `FAIL: ${error.message}. Is the adapter running (opencode-gemini-web start)?`);
  process.exit(1);
});
const seconds = (Date.now() - started) / 1000;
const payload = await response.json().catch(() => ({}));
const reply = payload.choices?.[0]?.message;
if (!response.ok || !(reply?.content || reply?.tool_calls)) {
  console.error(`FAIL: HTTP ${response.status} after ${seconds}s: ${payload.error?.message ?? 'no reply'}`);
  process.exit(1);
}
console.log(`OK: ${JSON.stringify(body).length} byte request answered in ${seconds}s by ${model}.`);
