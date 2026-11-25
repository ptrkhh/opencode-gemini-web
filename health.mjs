import { setTimeout as delay } from 'node:timers/promises';

// A hung Gemini renderer never answers, so a 1+1 round trip tells a hung page from a slow or logged-out one.
export const pageResponsive = (page, ms = 2000) =>
  within(Promise.resolve().then(() => page.evaluate(() => true)), ms).catch(() => false);

export async function within(operation, ms, error = new Error('Operation timed out.'), signal) {
  const timer = new AbortController();
  const wait = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  try {
    return await Promise.race([operation, delay(ms, undefined, { signal: wait }).then(() => { throw error; })]);
  } finally {
    timer.abort();
  }
}

export async function guardPage(page, signal, operation, onHang, interval = 5000) {
  signal.throwIfAborted();
  const timer = new AbortController();
  const stop = AbortSignal.any([timer.signal, signal]);
  const watchdog = (async () => {
    try {
      while (!stop.aborted) {
        await delay(interval, undefined, { signal: stop });
        if (!(await pageResponsive(page, Math.min(interval, 2000))) && !stop.aborted) throw onHang();
      }
    } catch (error) {
      if (!stop.aborted) throw error;
    }
  })();
  const interrupted = Promise.withResolvers();
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(operation), watchdog, interrupted.promise]);
  } finally {
    timer.abort();
    signal.removeEventListener('abort', abort);
  }
}

// While tripped, callers refuse new work instead of stacking more tabs on a wedged browser.
export function createCooldown(ms, now = Date.now) {
  let until = 0;
  return {
    trip: (duration = ms) => { until = now() + duration; },
    active: () => now() < until,
    remaining: () => Math.max(0, until - now()),
  };
}

// Google's "unusual traffic" interstitial replaces Gemini; every further load makes the block last longer.
export const captchaPage = url => /^https:\/\/(?:www\.)?google\.(?:com|[a-z]{2,3}|(?:co|com)\.[a-z]{2})\/sorry(?:[/?#]|$)/i.test(url);

// fill() stalls Chrome's renderer for 10s+ whenever the composer already holds a large draft (it replaces the selection in one edit; one such replace took 81 s).
// Gemini restores unsent drafts into new tabs, even Temporary Chat, and insertText appends to them. So clear first (10 ms for 60 KB), then insert into the empty composer (about 70 ms for 44 KB).
export async function typePrompt(page, composer, text) {
  await composer.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}
