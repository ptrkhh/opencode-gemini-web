import { performance } from 'node:perf_hooks';
import { repairToolReply, RequestError } from './adapter.mjs';
import { geminiPageState, geminiURL, openBrowser, waitForSession } from './browser.mjs';
import { captchaPage, createCooldown, guardPage, pageResponsive, typePrompt, within } from './health.mjs';
import { readModelMenu, selectModel, verifyModel } from './models.mjs';

const generationTimeout = 240_000;
const requestTimeout = 300_000;
const hang = createCooldown(30_000);
const blocked = createCooldown(120_000);
const limited = createCooldown(60_000);
let browserConnection;
let challengeTab;

const captcha = () => new RequestError(422, 'Google is showing an unusual-traffic CAPTCHA. Solve it in the adapter Chrome window or run opencode-gemini-web login to bring it forward, then retry after the cooldown.', 'gemini_captcha');
const pageHung = () => {
  hang.trip();
  return new RequestError(422, 'The Gemini page stopped responding. Close the hung tab or restart the adapter after 30 seconds, then retry.', 'gemini_page_hung');
};
const loginRequired = () => new RequestError(401, 'Sign in to Gemini again. Run opencode-gemini-web login, finish in Chrome, then retry in OpenCode.', 'gemini_login_required');

function rateLimited() {
  const error = new RequestError(429, 'Gemini rate-limited the browser. Wait before retrying.', 'gemini_rate_limited');
  error.retryAfter = Math.max(1, Math.ceil(limited.remaining() / 1000));
  return error;
}

async function withChat(signal, operation) {
  signal.throwIfAborted();
  if (blocked.active() || (challengeTab && !challengeTab.isClosed() && captchaPage(challengeTab.url()))) throw captcha();
  challengeTab = undefined;
  if (limited.active()) throw rateLimited();
  if (hang.active()) throw new RequestError(422, 'The Gemini browser is cooling down after a hung page. Retry after 30 seconds.', 'gemini_page_hung');

  browserConnection ??= openBrowser().then(({ browser }) => {
    browser.once('disconnected', () => { browserConnection = undefined; });
    return browser;
  }).catch(error => {
    browserConnection = undefined;
    throw new RequestError(503, error.message, 'gemini_browser_unavailable');
  });
  const browser = await browserConnection;
  signal.throwIfAborted();
  const context = browser.contexts()[0];
  challengeTab = context.pages().find(tab => captchaPage(tab.url()));
  if (challengeTab) {
    blocked.trip();
    throw captcha();
  }
  const opening = context.newPage();
  let page;
  try {
    page = await within(opening, 10_000, new RequestError(422, 'Chrome did not open the Gemini tab. Restart the browser or adapter.', 'gemini_browser_unavailable'));
  } catch (error) {
    hang.trip();
    void opening.then(tab => tab.close()).catch(() => {});
    throw error;
  }

  page.setDefaultTimeout(10_000);
  const started = performance.now();
  let stage = 'opening Gemini';
  const setStage = next => { stage = next; };
  const challenge = Promise.withResolvers();
  const navigated = frame => {
    if (frame !== page.mainFrame() || !captchaPage(frame.url())) return;
    challengeTab = page;
    blocked.trip();
    challenge.reject(captcha());
  };
  challenge.promise.catch(() => {});
  page.on('framenavigated', navigated);
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new RequestError(504, 'The Gemini request exceeded five minutes including any tool correction.', 'gemini_request_timeout'));
  }, requestTimeout);
  const requestSignal = AbortSignal.any([signal, deadline.signal]);

  try {
    const run = async () => {
      await page.goto(geminiURL, { waitUntil: 'domcontentloaded' });
      if (await waitForSession(page) === 'login-required') throw loginRequired();
      const expired = page.waitForFunction(geminiPageState, true, { polling: 1000, timeout: 0 })
        .then(handle => { void handle.dispose().catch(() => {}); throw loginRequired(); });
      const chat = async () => {
        setStage('enabling Temporary Chat');
        await page.getByRole('button', { name: 'Turn on temporary chat', exact: true }).click();
        await page.getByRole('button', { name: 'Turn off temporary chat', exact: true }).waitFor();
        requestSignal.throwIfAborted();
        return operation(page, setStage, requestSignal);
      };
      return Promise.race([chat(), expired]);
    };
    return await guardPage(page, requestSignal, () => Promise.race([challenge.promise, run()]), pageHung);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const typed = error instanceof RequestError;
    let failure = error;
    if ((!typed || error.status === 504) && !page.isClosed() && !(await pageResponsive(page))) {
      failure = pageHung();
    } else if (!typed) {
      failure = error.name === 'TimeoutError'
        ? new RequestError(504, `Timed out while ${stage}.`, 'gemini_stage_timeout')
        : new RequestError(502, `The Gemini browser failed while ${stage}.`, 'gemini_browser_error');
    }
    console.warn(`Gemini ${failure.code ?? failure.status} while ${stage} after ${Math.round(performance.now() - started)} ms.`);
    throw failure;
  } finally {
    clearTimeout(timer);
    page.off('framenavigated', navigated);
    if (challengeTab === page) {
      void page.bringToFront().catch(() => {});
    } else {
      await within(page.close(), 3000).catch(() => {});
    }
  }
}

export function listModels(signal) {
  return withChat(signal, async (page, stage) => {
    stage('reading Gemini’s model menu');
    return (await readModelMenu(page)).choices;
  });
}

async function submit(page, stage, prompt, signal) {
  signal.throwIfAborted();
  stage('entering the prompt');
  const composer = page.locator('rich-textarea [contenteditable=true]:visible');
  await typePrompt(page, composer, prompt);

  stage('submitting the prompt');
  const responses = page.locator('model-response');
  const nextResponse = responses.nth(await responses.count());
  return observeGeneration(page, () => {
    signal.throwIfAborted();
    return composer.press('Enter');
  }, upstream => readReply(page, stage, nextResponse, upstream));
}

export async function observeGeneration(page, send, read) {
  const matches = request => {
    const url = new URL(request.url());
    return url.origin === 'https://gemini.google.com' && url.pathname.endsWith('/StreamGenerate') && request.method() === 'POST';
  };
  const interrupted = Promise.withResolvers();
  let active;
  const sentRequest = request => {
    if (!active && matches(request)) active = request;
  };
  const failed = request => {
    if (request === active) {
      interrupted.reject(new RequestError(502, 'Gemini interrupted its response stream.', 'gemini_stream_interrupted'));
    }
  };
  page.on('request', sentRequest);
  page.on('requestfailed', failed);
  try {
    const sent = async () => {
      const started = page.waitForResponse(response => response.request() === active, { timeout: 15_000 });
      const [response] = await Promise.all([started, Promise.resolve().then(send)]);
      return read(response);
    };
    return await Promise.race([interrupted.promise, sent()]);
  } finally {
    page.off('request', sentRequest);
    page.off('requestfailed', failed);
  }
}

async function readReply(page, stage, nextResponse, upstream) {
  if (upstream.status() === 401) throw loginRequired();
  if (upstream.status() === 429) {
    const header = upstream.headers()['retry-after'];
    const milliseconds = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    limited.trip(Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined);
    throw rateLimited();
  }
  if (upstream.status() === 403) throw new RequestError(403, 'Gemini refused access to this request.', 'gemini_access_denied');
  if (!upstream.ok()) throw new RequestError(502, `Gemini returned HTTP ${upstream.status()}.`, 'gemini_upstream_error');

  stage('waiting for Gemini’s reply');
  const copy = nextResponse.getByRole('button', { name: 'Copy', exact: true });
  const ready = async () => {
    await copy.waitFor({ timeout: generationTimeout });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden', timeout: generationTimeout });
  };
  const reply = within(ready(), generationTimeout,
    new RequestError(504, 'Gemini did not finish its reply within four minutes.', 'gemini_generation_timeout'));
  const transport = upstream.finished().catch(error => error).then(error => {
    if (error) throw new RequestError(502, 'Gemini interrupted its response stream.', 'gemini_stream_interrupted');
    return within(reply, 20_000, new RequestError(502, 'Gemini finished sending its response, but the browser showed no completed reply.', 'gemini_no_reply'));
  });
  await Promise.race([reply, transport]);

  stage('copying the reply');
  await page.evaluate(() => {
    const save = async text => { window.__opencodeMarkdown = text; };
    delete window.__opencodeMarkdown;
    Object.defineProperties(navigator.clipboard, {
      writeText: { configurable: true, value: save },
      write: {
        configurable: true,
        value: async ([item]) => save(await (await item.getType('text/plain')).text()),
      },
    });
  });
  await copy.click();
  await page.waitForFunction(() => typeof window.__opencodeMarkdown === 'string');
  const text = await page.evaluate(() => window.__opencodeMarkdown);
  if (!text.trim()) throw new RequestError(502, 'Gemini returned an empty reply.', 'gemini_no_reply');
  return text;
}

export function generate(prompt, signal, model, format) {
  return withChat(signal, async (page, stage, requestSignal) => {
    stage('selecting the requested model');
    const selected = await selectModel(page, model);
    let chatURL;
    return repairToolReply(async next => {
      if (chatURL !== undefined) {
        stage('checking the conversation before correcting the reply');
        if (page.url() !== chatURL || !(await page.locator('model-response').count())) {
          throw new RequestError(422, 'Gemini left the Temporary Chat before the tool reply could be corrected.', 'gemini_chat_changed');
        }
      }
      const text = await submit(page, stage, next, requestSignal);
      stage('verifying the requested model');
      await verifyModel(page, selected);
      chatURL = page.url();
      return text;
    }, prompt, format);
  });
}
