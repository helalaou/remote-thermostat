import { chromium } from 'playwright-core';
import { serve } from '@hono/node-server';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { createApp } from '../src/app.ts';

// Uses an existing local Chromium. Does not install a browser or contact Google.
const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const directory = await mkdtemp(join(tmpdir(), 'neighbor-browser-'));
const store = new Store(directory);
const app = createApp({ config: readConfig({ APP_ORIGIN: 'http://localhost:3000' }), store });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const outgoing = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) outgoing.push(request.url());
  });
  await page.goto(origin);
  await page.waitForFunction(
    () => document.querySelector('#notice-text').textContent !== 'Checking your connection…',
  );
  assert.equal(await page.locator('#target-value').textContent(), '—');
  assert.equal(await page.locator('#temperature-up').isDisabled(), true);
  const output = process.env.SCREENSHOT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'desktop-disconnected.png'), fullPage: true });
  }
  await page.locator('#start-demo').click();
  await page.locator('#demo-banner').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#target-value').textContent(), '21');
  await page.locator('#temperature-up').click();
  await page.locator('#apply-temperature').click();
  assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
  await page.locator('#confirm-apply').click();
  assert.equal(await page.locator('#target-value').textContent(), '21.5');
  await page.locator('#eco-toggle').click();
  await page.locator('#confirm-apply').click();
  assert.equal(await page.locator('#temperature-up').isDisabled(), true);
  await page.locator('#eco-toggle').click();
  await page.locator('#confirm-apply').click();
  await page.locator('#fan-start').click();
  await page.locator('#confirm-apply').click();
  assert.equal(await page.locator('#fan-stop').isVisible(), true);
  if (output) await page.screenshot({ path: join(output, 'desktop-demo.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'Mobile page must not overflow horizontally.',
  );
  if (output) await page.screenshot({ path: join(output, 'mobile-demo.png'), fullPage: true });
  await page.locator('#unit-f').click();
  assert.equal(await page.locator('#unit-f').getAttribute('aria-pressed'), 'true');
  await page.locator('#exit-demo').click();
  assert.equal(await page.locator('#target-value').textContent(), '—');
  assert.deepEqual(errors, []);
  assert.deepEqual(outgoing, []);
  console.log(
    'Chromium smoke passed: disconnected state, demo controls, confirmation, Eco, fan, units, responsive390px layout; no external requests.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(directory, { recursive: true, force: true });
}
