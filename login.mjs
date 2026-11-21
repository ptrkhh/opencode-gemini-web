import { geminiURL, googleAccounts, openBrowser, waitForSession } from './browser.mjs';

try {
  const { browser, port } = await openBrowser();
  try {
    const context = browser.contexts()[0];
    let page = context.pages().find(tab => tab.url().startsWith(googleAccounts + '/'));
    let ready = false;
    if (!page) {
      page = context.pages().find(tab => tab.url() === 'about:blank') ?? await context.newPage();
      await page.goto(geminiURL, { waitUntil: 'domcontentloaded' });
      const state = await waitForSession(page);
      ready = state === 'ready';
      if (state === 'login-required' && !page.url().startsWith(googleAccounts + '/')) {
        const button = page.getByRole('button', { name: 'Sign in', exact: true }).first();
        const signIn = (await button.isVisible()) ? button : page.getByRole('link', { name: 'Sign in', exact: true }).first();
        await signIn.click({ timeout: 10_000 });
      }
    }
    await page.bringToFront();
    console.log(ready
      ? 'Gemini is signed in. You can use the adapter from OpenCode.'
      : 'Use the adapter Chrome window to finish sign-in, then retry in OpenCode.');
    console.log(`On a remote host, open this window with your existing desktop or dashboard. Chrome debug port ${port} is on loopback.`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error.message.split('\n')[0]);
  process.exitCode = 1;
}
