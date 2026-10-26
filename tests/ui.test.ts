import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const demoTemplate = readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const limits = { minCelsius: 10, maxCelsius: 30, minRangeGapCelsius: 1.5 };
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  connection: 'ONLINE', mode: 'HEAT', availableModes: ['HEAT', 'OFF'],
  ecoMode: 'OFF', availableEcoModes: [], fanTimerMode: 'OFF', hasFan: false,
  hasSetpoint: true, ambientCelsius: 19.5, humidityPercent: 42,
  heatCelsius: 21, coolCelsius: 24, observedAt: new Date().toISOString(), ...overrides,
});
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() {
  for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}
// Tests inspect lexical state only in this isolated VM; production exposes no debugging API.
function createUI(handler: (path: string, options?: Record<string, unknown>) => unknown, demo = false) {
  const dom = new JSDOM(demo ? demoTemplate : template, {
    url: 'https://thermostat.example/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const window = dom.window;
  const calls: string[] = [];
  Object.defineProperty(window, 'fetch', { value: (path: string, options: Record<string, unknown>) => {
    calls.push(path); return Promise.resolve(handler(path, options));
  } });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.eval(`${source}\nwindow.__ui = { state, enterDemo, exitDemo, refreshSession, refreshStatus, askCommand, executePendingCommand, validateConfirmation, adjustTemperature, canControl, setpointEditable, render, api };`);
  // jsdom deliberately treats JavaScript evaluated from a string as dynamically typed.
  const ui = (window as unknown as { __ui: Record<string, any> }).__ui;
  const el = <T extends Element = HTMLElement>(id: string) => {
    const element = window.document.getElementById(id);
    assert.ok(element, `missing element: ${id}`);
    return element as unknown as T;
  };
  return { window, calls, ui, el, close: () => dom.window.close() };
}
function normalHandler(path: string) {
  if (path === '/api/session') return response({ authenticated: true, role: 'neighbor', csrfToken: 'test-csrf', configured: true });
  if (path === '/api/thermostat') return response({ connected: true, stale: false, snapshot: snapshot(), limits });
  throw new Error(`Unexpected request: ${path}`);
}

test('isolated demo never fetches, including command interactions', async (t) => {
  const app = createUI(() => { throw new Error('Static demo used fetch'); }, true);
  t.after(app.close);
  assert.equal(app.ui.state.demo, true);
  assert.equal(app.el('target-value').textContent, '21');
  app.ui.adjustTemperature(1);
  assert.equal(app.ui.state.snapshot.heatCelsius, 21, 'a draft is not an applied temperature');
  app.ui.askCommand({ type: 'heat', heatCelsius: 21.5 });
  await app.ui.executePendingCommand();
  assert.equal(app.ui.state.snapshot.heatCelsius, 21.5);
  app.ui.askCommand({ type: 'eco', mode: 'MANUAL_ECO' });
  await app.ui.executePendingCommand();
  assert.equal(app.ui.setpointEditable(), false);
  assert.equal(app.el<HTMLButtonElement>('temperature-up').disabled, true);
  await assert.rejects(app.ui.api('/api/commands'), /no server connection/);
  assert.deepEqual(app.calls, []);
});

test('disconnected state never invents a live temperature', async (t) => {
  const app = createUI((path) => path === '/api/session'
    ? response({ authenticated: true, role: 'neighbor', csrfToken: 'test', configured: true })
    : response({ connected: false, stale: false, limits }));
  t.after(app.close);
  await settle();
  assert.equal(app.el('target-value').textContent, '—');
  assert.equal(app.el('ambient-value').textContent, '—');
  assert.equal(app.el('connection-label').textContent, 'Not connected');
  assert.equal(app.el<HTMLButtonElement>('apply-temperature').disabled, true);
});

test('available controls come from the reported device capabilities', async (t) => {
  const app = createUI(normalHandler);
  t.after(app.close);
  await settle();
  const buttons = [...app.el('mode-buttons').querySelectorAll('button')].map((button) => button.textContent);
  assert.deepEqual(buttons, ['☀  Heat', '⏻  Off']);
  assert.equal(app.el<HTMLElement>('fan-card').hidden, true);
  assert.equal(app.el<HTMLElement>('eco-controls').hidden, true);
  assert.equal(app.el<HTMLButtonElement>('temperature-up').disabled, false);
});

test('live write locks view transitions and logout until its result is known', async (t) => {
  const command = deferred<ReturnType<typeof response>>();
  const app = createUI((path) => path === '/api/commands' ? command.promise : normalHandler(path));
  t.after(app.close);
  await settle();
  app.ui.askCommand({ type: 'heat', heatCelsius: 22 });
  const running = app.ui.executePendingCommand();
  assert.equal(app.el<HTMLButtonElement>('start-demo').disabled, true);
  assert.equal(app.el<HTMLButtonElement>('logout').disabled, true);
  app.ui.enterDemo();
  assert.equal(app.ui.state.demo, false);
  command.resolve(response({ accepted: true, confirmed: true, snapshot: snapshot({ heatCelsius: 22 }) }));
  await running;
  assert.equal(app.ui.state.snapshot.heatCelsius, 22);
  assert.equal(app.ui.state.busy, false);
});

test('late status result cannot overwrite a newer local demo', async (t) => {
  let deferNext = false;
  const status = deferred<ReturnType<typeof response>>();
  const app = createUI((path) => path === '/api/thermostat' && deferNext ? status.promise : normalHandler(path));
  t.after(app.close);
  await settle();
  deferNext = true;
  const running = app.ui.refreshStatus();
  app.ui.enterDemo();
  status.resolve(response({ connected: true, stale: false, snapshot: snapshot({ heatCelsius: 29 }), limits }));
  await running;
  assert.equal(app.ui.state.demo, true);
  assert.equal(app.ui.state.snapshot.heatCelsius, 21);
  assert.equal(app.el('session-label').textContent, 'Local demo');
  assert.equal(app.ui.state.loading, false);
});

test('late session response cannot switch a demo into an authenticated view', async (t) => {
  const session = deferred<ReturnType<typeof response>>();
  const app = createUI(() => session.promise);
  t.after(app.close);
  app.ui.enterDemo();
  session.resolve(response({ authenticated: true, role: 'owner', csrfToken: 'old', configured: true }));
  await settle();
  assert.equal(app.ui.state.demo, true);
  assert.equal(app.ui.state.session.authenticated, false);
  assert.deepEqual(app.calls, ['/api/session']);
});

test('late login response cannot overwrite a newer demo transition', async (t) => {
  const login = deferred<ReturnType<typeof response>>();
  const app = createUI((path) => path === '/api/login' ? login.promise : response({ authenticated: false, configured: true }));
  t.after(app.close);
  await settle();
  app.el<HTMLInputElement>('access-key').value = 'a-test-only-access-key';
  app.el('login-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  app.ui.enterDemo();
  login.resolve(response({ ok: true }));
  await settle();
  assert.equal(app.ui.state.demo, true);
  assert.equal(app.ui.state.session.authenticated, false);
  assert.equal(app.calls.filter((path) => path === '/api/session').length, 1);
  assert.equal(app.el<HTMLInputElement>('access-key').value, '');
});

test('confirmation expires and cannot send a delayed command', async (t) => {
  const app = createUI(normalHandler);
  t.after(app.close);
  await settle();
  app.ui.askCommand({ type: 'heat', heatCelsius: 22 });
  assert.equal(app.el<HTMLDialogElement>('confirm-dialog').open, true);
  app.ui.state.pendingCommand.createdAt -= 31_000;
  await app.ui.executePendingCommand();
  assert.equal(app.ui.state.pendingCommand, null);
  assert.equal(app.el<HTMLDialogElement>('confirm-dialog').open, false);
  assert.equal(app.calls.includes('/api/commands'), false);
});

test('a freshly changed target invalidates a pending confirmation', async (t) => {
  let changed = false;
  const app = createUI((path) => path === '/api/thermostat' && changed
    ? response({ connected: true, stale: false, snapshot: snapshot({ heatCelsius: 23 }), limits })
    : normalHandler(path));
  t.after(app.close);
  await settle();
  app.ui.askCommand({ type: 'heat', heatCelsius: 22 });
  changed = true;
  await app.ui.refreshStatus();
  assert.equal(app.ui.state.pendingCommand, null);
  assert.equal(app.el<HTMLDialogElement>('confirm-dialog').open, false);
  assert.equal(app.calls.includes('/api/commands'), false);
});

for (const connected of [false, true]) {
  test(`owner can ${connected ? 'reconnect an existing grant' : 'start Google setup without a selected device'}`, async (t) => {
    const app = createUI((path) => {
      if (path === '/api/session') return response({ authenticated: true, role: 'owner', csrfToken: 'test', configured: true });
      if (path === '/api/owner/status') return response({ googleConfigured: true, googleConnected: connected, deviceConfigured: false, accessKeys: [] });
      return response({ connected: false, stale: false, limits });
    });
    t.after(app.close);
    await settle();
    assert.equal(app.el<HTMLButtonElement>('google-connect').disabled, false);
    assert.equal(app.el('google-connect').textContent, connected ? 'Reconnect Google Nest' : 'Connect Google Nest');
  });
}
