import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const limits = { minCelsius: 10, maxCelsius: 30, minRangeGapCelsius: 1.5 };
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  connection: 'ONLINE',
  mode: 'HEAT',
  availableModes: ['HEAT', 'OFF'],
  ecoMode: 'OFF',
  availableEcoModes: [],
  hasSetpoint: true,
  ambientCelsius: 19.5,
  humidityPercent: 42,
  heatCelsius: 21,
  coolCelsius: 24,
  observedAt: new Date().toISOString(),
  ...overrides,
});
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
// Tests inspect lexical state only in this isolated VM; production exposes no debugging API.
function createUI(handler: (path: string, options?: Record<string, unknown>) => unknown) {
  const dom = new JSDOM(template, {
    url: 'https://thermostat.example/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const calls: string[] = [];
  Object.defineProperty(window, 'fetch', {
    value: (path: string, options: Record<string, unknown>) => {
      calls.push(path);
      return Promise.resolve(handler(path, options));
    },
  });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  window.eval(
    `${source}\nwindow.__ui = { state, enterDemo, exitDemo, refreshSession, refreshStatus, askCommand, executePendingCommand, validateConfirmation, adjustTemperature, canControl, setpointEditable, render, api, scheduleRefresh };`,
  );
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
  if (path === '/api/session')
    return response({
      authenticated: true,
      role: 'user',
      csrfToken: 'test-csrf',
      configured: true,
    });
  if (path === '/api/thermostat')
    return response({ connected: true, stale: false, snapshot: snapshot(), limits });
  throw new Error(`Unexpected request: ${path}`);
}

test('demo commands never reach the server', async (t) => {
  const app = createUI(normalHandler);
  t.after(app.close);
  await settle();
  app.ui.enterDemo();
  const before = app.calls.length;
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
  assert.equal(app.calls.length, before);
});

test('disconnected state never invents a live temperature', async (t) => {
  const app = createUI((path) =>
    path === '/api/session'
      ? response({ authenticated: true, role: 'user', csrfToken: 'test', configured: true })
      : response({ connected: false, stale: false, limits }),
  );
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
  const buttons = [...app.el('mode-buttons').querySelectorAll('button')].map(
    (button) => button.textContent,
  );
  assert.deepEqual(buttons, ['Heat', 'Off']);
  assert.equal(app.el<HTMLElement>('eco-controls').hidden, true);
  assert.equal(app.el<HTMLButtonElement>('temperature-up').disabled, false);
});

test('live write locks view transitions and logout until its result is known', async (t) => {
  const command = deferred<ReturnType<typeof response>>();
  const app = createUI((path) =>
    path === '/api/commands' ? command.promise : normalHandler(path),
  );
  t.after(app.close);
  await settle();
  app.ui.askCommand({ type: 'heat', heatCelsius: 22 });
  const running = app.ui.executePendingCommand();
  assert.equal(app.el<HTMLButtonElement>('start-demo').disabled, true);
  assert.equal(app.el<HTMLButtonElement>('logout').disabled, true);
  app.ui.enterDemo();
  assert.equal(app.ui.state.demo, false);
  command.resolve(
    response({ accepted: true, confirmed: true, snapshot: snapshot({ heatCelsius: 22 }) }),
  );
  await running;
  assert.equal(app.ui.state.snapshot.heatCelsius, 22);
  assert.equal(app.ui.state.busy, false);
});

test('late status result cannot overwrite a newer local demo', async (t) => {
  let deferNext = false;
  const status = deferred<ReturnType<typeof response>>();
  const app = createUI((path) =>
    path === '/api/thermostat' && deferNext ? status.promise : normalHandler(path),
  );
  t.after(app.close);
  await settle();
  deferNext = true;
  const running = app.ui.refreshStatus();
  app.ui.enterDemo();
  status.resolve(
    response({ connected: true, stale: false, snapshot: snapshot({ heatCelsius: 29 }), limits }),
  );
  await running;
  assert.equal(app.ui.state.demo, true);
  assert.equal(app.ui.state.snapshot.heatCelsius, 21);
  assert.equal(app.el('session-label').textContent, 'Demo');
  assert.equal(app.ui.state.loading, false);
});

test('late session response cannot switch a demo into an authenticated view', async (t) => {
  const session = deferred<ReturnType<typeof response>>();
  const app = createUI(() => session.promise);
  t.after(app.close);
  app.ui.enterDemo();
  session.resolve(
    response({ authenticated: true, role: 'admin', csrfToken: 'old', configured: true }),
  );
  await settle();
  assert.equal(app.ui.state.demo, true);
  assert.equal(app.ui.state.session.authenticated, false);
  assert.deepEqual(app.calls, ['/api/session']);
});

test('late login response cannot overwrite a newer demo transition', async (t) => {
  const login = deferred<ReturnType<typeof response>>();
  const app = createUI((path) =>
    path === '/api/login' ? login.promise : response({ authenticated: false, configured: true }),
  );
  t.after(app.close);
  await settle();
  app.el<HTMLInputElement>('access-key').value = 'a-test-only-code';
  app
    .el('login-form')
    .dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
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
  const app = createUI((path) =>
    path === '/api/thermostat' && changed
      ? response({ connected: true, stale: false, snapshot: snapshot({ heatCelsius: 23 }), limits })
      : normalHandler(path),
  );
  t.after(app.close);
  await settle();
  app.ui.askCommand({ type: 'heat', heatCelsius: 22 });
  changed = true;
  await app.ui.refreshStatus();
  assert.equal(app.ui.state.pendingCommand, null);
  assert.equal(app.el<HTMLDialogElement>('confirm-dialog').open, false);
  assert.equal(app.calls.includes('/api/commands'), false);
});

test('automatic refresh runs every 30 seconds only while visible, with no overlap', async (t) => {
  const app = createUI(normalHandler);
  t.after(app.close);
  await settle();
  const timers = new Map<number, { callback: () => Promise<void>; delay: number }>();
  let timerId = 1000;
  const realClear = app.window.clearTimeout.bind(app.window);
  Object.defineProperty(app.window, 'setTimeout', {
    value: (callback: () => Promise<void>, delay: number) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
  });
  Object.defineProperty(app.window, 'clearTimeout', {
    value: (id: number) => {
      timers.delete(id);
      realClear(id);
    },
  });
  app.ui.scheduleRefresh();
  assert.equal([...timers.values()].filter((item) => item.delay === 30_000).length, 1);
  let hidden = true;
  Object.defineProperty(app.window.document, 'hidden', { configurable: true, get: () => hidden });
  app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
  assert.equal([...timers.values()].filter((item) => item.delay === 30_000).length, 0);
  const reads = app.calls.filter((path) => path === '/api/thermostat').length;
  app.ui.state.loading = true;
  await app.ui.refreshStatus();
  assert.equal(app.calls.filter((path) => path === '/api/thermostat').length, reads);
  app.ui.state.loading = false;
  hidden = false;
  app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
  await settle();
  assert.equal(app.calls.filter((path) => path === '/api/thermostat').length, reads + 1);
  assert.equal([...timers.values()].filter((item) => item.delay === 30_000).length, 1);
});
test('theme setting applies and persists per browser', async (t) => {
  const app = createUI(normalHandler);
  t.after(app.close);
  await settle();
  app.el<HTMLButtonElement>('settings-open').click();
  assert.equal(app.el<HTMLDialogElement>('settings-dialog').open, true);
  assert.equal(app.el<HTMLElement>('admin-card').hidden, true, 'the user has no admin panel');
  app.window.document.querySelector<HTMLButtonElement>('[data-theme-choice="dark"]')!.click();
  assert.equal(app.window.document.documentElement.dataset.theme, 'dark');
  assert.equal(
    JSON.parse(app.window.localStorage.getItem('remote-thermostat-settings')!).theme,
    'dark',
  );
  app.window.document.querySelector<HTMLButtonElement>('[data-theme-choice="system"]')!.click();
  assert.equal(app.window.document.documentElement.dataset.theme, undefined);
});
test('the user sees only allowed modes and Eco, keeping the active mode visible but locked', async (t) => {
  const app = createUI((path) => {
    if (path === '/api/thermostat')
      return response({
        connected: true,
        stale: false,
        limits,
        snapshot: snapshot({
          availableModes: ['HEAT', 'COOL', 'OFF'],
          availableEcoModes: ['MANUAL_ECO', 'OFF'],
        }),
        controls: { modes: ['COOL', 'OFF'], eco: false },
      });
    return normalHandler(path);
  });
  t.after(app.close);
  await settle();
  const buttons = [...app.el('mode-buttons').querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ['Heat', 'Cool', 'Off'],
  );
  assert.equal(app.ui.setpointEditable(), false, 'HEAT is active but not allowed');
  assert.equal(app.el('stepper-hint').textContent, 'Locked by admin');
  assert.equal(app.el<HTMLElement>('eco-controls').hidden, true);
});
test('admin edits user access through the server and stays unrestricted', async (t) => {
  const puts: unknown[] = [];
  const access = {
    enabled: true,
    modes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'],
    eco: true,
    minCelsius: 10,
    maxCelsius: 30,
  };
  const app = createUI((path, options) => {
    if (path === '/api/session')
      return response({ authenticated: true, role: 'admin', csrfToken: 'c', configured: true });
    if (path === '/api/admin/access') {
      if (options?.method === 'PUT') {
        const body = JSON.parse(options.body as string);
        puts.push(body);
        return response(body);
      }
      return response({ access, userCodeSet: true, googleConnected: true });
    }
    return normalHandler(path);
  });
  t.after(app.close);
  await settle();
  assert.equal(app.el<HTMLElement>('admin-card').hidden, false);
  assert.equal(app.el<HTMLInputElement>('user-max').value, '30');
  const off = app.window.document.querySelector<HTMLInputElement>('[data-mode-choice="OFF"]')!;
  off.checked = false;
  off.dispatchEvent(new app.window.Event('change'));
  const max = app.el<HTMLInputElement>('user-max');
  max.value = '24';
  max.dispatchEvent(new app.window.Event('change'));
  await settle();
  assert.deepEqual(puts.at(-1), {
    ...access,
    modes: ['HEAT', 'COOL', 'HEATCOOL'],
    maxCelsius: 24,
  });
  // The admin is never restricted, so Off still shows for them.
  assert.ok(
    [...app.el('mode-buttons').querySelectorAll('button')].some((b) => b.textContent === 'Off'),
  );
});
test('demo previews user access locally', async (t) => {
  const app = createUI(normalHandler);
  t.after(app.close);
  await settle();
  app.ui.enterDemo();
  assert.equal(app.el<HTMLElement>('eco-controls').hidden, false);
  assert.equal(app.el<HTMLElement>('admin-card').hidden, false);
  const eco = app.el<HTMLInputElement>('user-eco');
  eco.checked = false;
  eco.dispatchEvent(new app.window.Event('change'));
  assert.equal(app.el<HTMLElement>('eco-controls').hidden, true);
  app.ui.state.snapshot.ecoMode = 'MANUAL_ECO';
  app.ui.render();
  assert.equal(app.el<HTMLElement>('eco-controls').hidden, false, 'active Eco can be turned off');
});
