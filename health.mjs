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

// fill() stalls Chrome's renderer for 10s+ whenever the composer already holds a large draft (it replaces the selection in one edit; one such replace took 81 s).
// Gemini restores unsent drafts into new tabs, even Temporary Chat, and insertText appends to them. So clear first (10 ms for 60 KB), then insert into the empty composer (about 70 ms for 44 KB).
export async function typePrompt(page, composer, text) {
  await composer.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}
