import { setTimeout as delay } from 'node:timers/promises';

// A hung Gemini renderer never answers, so a 1+1 round trip tells a hung page from a slow or logged-out one.
export const pageResponsive = (page, ms = 2000) =>
  Promise.race([page.evaluate(() => true), delay(ms).then(() => false)]).catch(() => false);

// While tripped, callers refuse new work instead of stacking more tabs on a wedged browser.
export function createCooldown(ms, now = Date.now) {
  let until = 0;
  return { trip: () => { until = now() + ms; }, active: () => now() < until };
}

// Google's "unusual traffic" interstitial replaces Gemini; every further load makes the block last longer.
export const captchaPage = url => /^https:\/\/(www\.)?google\.[a-z.]+\/sorry\//.test(url);
