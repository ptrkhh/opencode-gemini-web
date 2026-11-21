import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdapter, RequestError } from './adapter.mjs';
import { geminiPageState, geminiURL, openBrowser, stateDir, waitForSession } from './browser.mjs';

const mode = 'Hydrogen Thinking';
const generationTimeout = 150_000;
let browser;

function loginRequired() {
  return new RequestError(401, 'Sign in to Gemini again. Run npm run login in the adapter folder, finish in Chrome, then retry in OpenCode.', 'gemini_login_required');
}

async function generate(prompt, signal) {
  if (!browser?.isConnected()) {
    try {
      ({ browser } = await openBrowser());
    } catch (error) {
      throw new RequestError(503, error.message, 'gemini_browser_unavailable');
    }
  }
  signal.throwIfAborted();
  const page = await browser.contexts()[0].newPage();
  const close = () => page.close().catch(() => {});
  signal.addEventListener('abort', close, { once: true });
  page.setDefaultTimeout(10000);
  let stage = 'opening Gemini';
  try {
    signal.throwIfAborted();
    await page.goto(geminiURL, { waitUntil: 'domcontentloaded' });
    if (await waitForSession(page) === 'login-required') throw loginRequired();
    const expired = page.waitForFunction(geminiPageState, true, { polling: 300, timeout: 0 })
      .then(() => { throw loginRequired(); });
    expired.catch(() => {});

    stage = 'enabling Temporary Chat';
    await page.getByRole('button', { name: 'Turn on temporary chat', exact: true }).click();
    await page.getByRole('button', { name: 'Turn off temporary chat', exact: true }).waitFor();

    stage = 'selecting Hydrogen Thinking';
    const picker = page.locator('[data-test-id=bard-mode-menu-button]:visible');
    await picker.waitFor();
    if (!(await picker.getAttribute('aria-label'))?.endsWith(mode)) {
      await picker.click();
      const option = page.getByText(mode, { exact: true }).last();
      const available = await option.waitFor({ timeout: 3000 }).then(() => true, () => false);
      if (available) await option.click();
    }
    if (!(await picker.getAttribute('aria-label'))?.endsWith(mode)) {
      throw new RequestError(403, 'Hydrogen Thinking is unavailable for the signed-in Gemini account.', 'gemini_model_unavailable');
    }

    stage = 'submitting the prompt';
    const composer = page.locator('rich-textarea [contenteditable=true]:visible');
    await composer.fill(prompt);
    const started = page.waitForResponse(res => {
      const url = new URL(res.url());
      return url.origin === 'https://gemini.google.com' && url.pathname.endsWith('/StreamGenerate')
        && res.request().method() === 'POST';
    }, { timeout: 15000 });
    started.catch(() => {});
    await composer.press('Enter');
    const upstream = await Promise.race([started, expired]);
    if (upstream.status() === 401) throw loginRequired();
    if (!upstream.ok()) {
      throw new RequestError(upstream.status() === 429 ? 429 : 502, `Gemini returned HTTP ${upstream.status()}.`);
    }

    stage = 'waiting for Gemini’s reply';
    const copy = page.locator('model-response').last().getByRole('button', { name: 'Copy', exact: true });
    await Promise.race([copy.waitFor({ timeout: generationTimeout }), expired]);
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });

    stage = 'copying the reply';
    await page.evaluate(() => {
      const save = async text => { window.__opencodeMarkdown = text; };
      Object.defineProperties(navigator.clipboard, {
        writeText: { value: save },
        write: {
          value: async ([item]) => save(await (await item.getType('text/plain')).text()),
        },
      });
    });
    await copy.click();
    await page.waitForFunction(() => typeof window.__opencodeMarkdown === 'string');
    const text = await page.evaluate(() => window.__opencodeMarkdown);
    if (!text.trim()) throw new RequestError(502, 'Gemini returned an empty reply.');
    return text;
  } catch (error) {
    if (error.status) throw error;
    if (await page.evaluate(geminiPageState, true).catch(() => null)) throw loginRequired();
    if (error.name === 'TimeoutError') throw new RequestError(504, `Timed out while ${stage}.`);
    throw new RequestError(502, `The Gemini browser failed while ${stage}.`);
  } finally {
    signal.removeEventListener('abort', close);
    await close();
  }
}

const keyPath = join(stateDir, 'key');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
try {
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const key = readFileSync(keyPath, 'utf8').trim();
const server = createAdapter(key, generate);
server.listen(19323, '127.0.0.1', () => {
  console.log('Hydrogen adapter listening on 127.0.0.1:19323');
  console.log(`OpenCode apiKey file is ${keyPath}`);
});
