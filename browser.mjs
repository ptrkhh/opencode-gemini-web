import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

export const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode-hydrogen');
export const geminiURL = 'https://gemini.google.com/u/0/app?hl=en';
export const googleAccounts = 'https://accounts.google.com';
const profile = join(stateDir, 'chrome');

function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const candidates = process.platform === 'win32'
    ? roots.filter(Boolean).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
         join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
      : (process.env.PATH || '').split(delimiter).filter(Boolean).flatMap(root =>
          ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(name => join(root, name)));
  const chrome = candidates.find(existsSync);
  if (!chrome) throw new Error('Install Google Chrome or set CHROME_PATH to its executable.');
  return chrome;
}

async function connectProfile() {
  let data;
  try {
    data = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const [port, path] = data.trim().split(/\r?\n/);
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(path ?? '')) return;
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`, { timeout: 1000 }).catch(() => null);
  if (browser) return { browser, port };
}

export async function openBrowser() {
  const active = await connectProfile();
  if (active) return active;

  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const child = spawn(chromeExecutable(), [
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--lang=en-US',
    ...(headless ? ['--headless=new'] : []), 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  child.unref();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const connection = await connectProfile();
    if (connection) return connection;
    await delay(200);
  }
  throw new Error('Unable to open the Gemini browser. Close Chrome windows using the adapter profile and run npm run login.');
}

// Runs in the browser. Keep selectors and origin checks inside this function.
export function geminiPageState(loginOnly = false) {
  if (location.origin === 'https://accounts.google.com') return 'login-required';
  if (location.origin !== 'https://gemini.google.com') return null;
  const signIn = [...document.querySelectorAll('a,button')].some(element =>
    element.getClientRects().length && !element.closest('model-response,user-query') &&
    (element.getAttribute('aria-label') || element.textContent.trim()) === 'Sign in');
  if (signIn) return 'login-required';
  if (!loginOnly && document.querySelector('[aria-label="Google Account"],[aria-label^="Google Account:"]')) return 'ready';
  return null;
}

export async function waitForSession(page) {
  const state = await page.waitForFunction(geminiPageState, false, { polling: 200 });
  try {
    return await state.jsonValue();
  } finally {
    await state.dispose();
  }
}
