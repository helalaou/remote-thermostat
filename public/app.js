const $ = (id) => document.getElementById(id);
const DEMO_ONLY = document.querySelector('meta[name="demo-only"]')?.content === 'true';
const POLL_MS = 30_000;
const modeNames = { HEAT: 'Heat', COOL: 'Cool', HEATCOOL: 'Heat/Cool', OFF: 'Off' };
const fallbackLimits = { minCelsius: 10, maxCelsius: 30, minRangeGapCelsius: 1.5 };
let unit = 'C';
try {
  unit = localStorage.getItem('neighbor-temperature-unit') === 'F' ? 'F' : 'C';
} catch {
  /* Storage is optional. */
}
const state = {
  session: { authenticated: false, configured: false },
  snapshot: null,
  connected: false,
  stale: false,
  checkedAt: null,
  limits: { ...fallbackLimits },
  draft: null,
  dirty: false,
  busy: false,
  loading: false,
  demo: false,
  pollTimer: null,
  owner: null,
  pendingCommand: null,
  confirmTimer: null,
  lastNotice: null,
  generation: 0,
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const toDisplay = (celsius) => (unit === 'F' ? (celsius * 9) / 5 + 32 : celsius);
const toCelsius = (value) => (unit === 'F' ? ((value - 32) * 5) / 9 : value);
const round = (value, places = 1) => Number(value.toFixed(places));
const numberText = (value) =>
  finite(value)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(round(toDisplay(value)))
    : '—';
const temperatureText = (value) => (finite(value) ? `${numberText(value)}°${unit}` : '—');
const text = (id, value) => {
  $(id).textContent = value;
};
function notice(message, tone = 'info') {
  text('notice-text', message);
  $('notice').dataset.tone = tone;
  state.lastNotice = { message, tone };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
function contextKey() {
  const s = state.snapshot;
  return JSON.stringify(
    s
      ? {
          mode: s.mode,
          eco: s.ecoMode,
          heat: s.heatCelsius,
          cool: s.coolCelsius,
          modes: s.availableModes,
          ecoModes: s.availableEcoModes,
          fan: s.hasFan,
          fanTimer: s.fanTimerMode,
          setpoint: s.hasSetpoint,
        }
      : null,
  );
}
function dismissConfirmation(message) {
  clearTimeout(state.confirmTimer);
  state.pendingCommand = null;
  if ($('confirm-dialog').open) $('confirm-dialog').close();
  if (message) notice(message, 'error');
}
function transitionView() {
  state.generation += 1;
  state.loading = false;
  clearTimeout(state.pollTimer);
  dismissConfirmation();
  return state.generation;
}
function clearCreatedKey() {
  $('key-token').value = '';
  $('key-created').hidden = true;
}
function lockSession() {
  clearCreatedKey();
  state.session = { authenticated: false, configured: state.session.configured };
  state.connected = false;
  state.snapshot = null;
  state.owner = null;
  resetDraft();
}
function validateConfirmation() {
  const pending = state.pendingCommand;
  if (
    pending &&
    (pending.generation !== state.generation ||
      Date.now() - pending.createdAt > 30_000 ||
      pending.context !== contextKey() ||
      state.stale ||
      !state.connected)
  ) {
    dismissConfirmation(
      'The thermostat status changed or this confirmation expired. Review the current settings and confirm again.',
    );
  }
}

async function api(path, options = {}) {
  // A separately hosted preview must never touch the server or attempt real login/control.
  if (DEMO_ONLY) throw new Error('This preview has no server connection.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = { Accept: 'application/json', ...options.headers };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET' && state.session.csrfToken)
      headers['X-CSRF-Token'] = state.session.csrfToken;
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof data.error === 'string' ? data.error : data.error?.message || data.message;
      const error = new Error(
        message ||
          (response.status === 429
            ? 'Too many requests. Wait a moment before trying again.'
            : 'The request could not be completed.'),
      );
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError')
      throw new Error('The server did not respond in time. No change has been confirmed.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resetDraft() {
  const s = state.snapshot;
  state.draft = s ? { heatCelsius: s.heatCelsius, coolCelsius: s.coolCelsius } : null;
  state.dirty = false;
}
function canControl() {
  return Boolean(
    (state.demo || state.session.authenticated) &&
    state.connected &&
    state.snapshot?.connection === 'ONLINE' &&
    !state.stale &&
    !state.busy &&
    !state.loading,
  );
}
function setpointEditable() {
  const s = state.snapshot;
  return (
    canControl() &&
    s?.hasSetpoint &&
    (!s.ecoMode || s.ecoMode === 'OFF') &&
    ['HEAT', 'COOL', 'HEATCOOL'].includes(s.mode)
  );
}
function selectedTarget() {
  const s = state.snapshot;
  if (!s || !state.draft) return null;
  return s.mode === 'COOL' ? state.draft.coolCelsius : state.draft.heatCelsius;
}
function timeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function render() {
  const s = state.snapshot;
  const eco = s?.ecoMode === 'MANUAL_ECO';
  const online = state.connected && s?.connection === 'ONLINE';
  const editable = setpointEditable();
  const hasRange = s?.mode === 'HEATCOOL' && !eco;
  const current = selectedTarget();
  const live = state.demo || state.session.authenticated;
  text(
    'session-label',
    state.demo
      ? 'Demo'
      : state.session.authenticated
        ? state.session.role === 'owner'
          ? 'Owner'
          : state.session.label || 'Guest'
        : '',
  );
  $('login-open').hidden = state.session.authenticated || DEMO_ONLY;
  $('logout').hidden = !state.session.authenticated || state.demo;
  $('logout').disabled = state.busy;
  $('login-open').disabled = state.busy;
  $('start-demo').disabled = state.busy;
  $('exit-demo').disabled = state.busy;
  $('confirm-apply').disabled = state.busy || state.loading;
  $('demo-banner').hidden = !state.demo;
  $('exit-demo').hidden = DEMO_ONLY;
  $('start-demo').hidden = state.demo || state.session.authenticated || DEMO_ONLY;
  $('unit-c').setAttribute('aria-pressed', String(unit === 'C'));
  $('unit-f').setAttribute('aria-pressed', String(unit === 'F'));
  const badge = state.demo
    ? 'Demo'
    : state.stale && state.connected
      ? 'Stale'
      : online
        ? 'Connected'
        : state.connected && s
          ? 'Offline'
          : 'Not connected';
  text('connection-label', badge);
  $('connection-badge').dataset.state =
    state.demo || (online && !state.stale)
      ? 'online'
      : state.connected && (state.stale || s)
        ? 'offline'
        : 'disconnected';
  $('dial').dataset.mode =
    state.connected && s ? (eco ? 'ECO' : s.mode || 'disconnected') : 'disconnected';
  text('target-unit', `°${unit}`);
  $('target-unit').hidden = eco || s?.mode === 'OFF';
  if (!state.connected || !s) {
    text('target-value', '—');
    text('dial-label', 'Target');
    text('dial-description', '');
  } else if (eco) {
    text('target-value', 'Eco');
    text('dial-label', 'Eco');
    text('dial-description', '');
  } else if (s.mode === 'OFF') {
    text('target-value', '—');
    text('dial-label', 'Off');
    text('dial-description', '');
  } else if (hasRange) {
    text(
      'target-value',
      `${numberText(state.draft?.heatCelsius)}–${numberText(state.draft?.coolCelsius)}`,
    );
    text('dial-label', 'Range');
    text('dial-description', state.dirty ? 'Not applied' : '');
  } else {
    text('target-value', numberText(current));
    text('dial-label', s.mode === 'COOL' ? 'Cooling to' : 'Heating to');
    text(
      'dial-description',
      state.dirty
        ? 'Not applied'
        : s.hvacStatus === 'HEATING'
          ? 'Heating'
          : s.hvacStatus === 'COOLING'
            ? 'Cooling'
            : '',
    );
  }
  if (finite(current)) {
    const proportion = Math.max(
      0,
      Math.min(
        1,
        (current - state.limits.minCelsius) / (state.limits.maxCelsius - state.limits.minCelsius),
      ),
    );
    $('dial').style.setProperty('--arc', `${90 + proportion * 180}deg`);
  } else $('dial').style.removeProperty('--arc');
  $('stepper').hidden = hasRange;
  $('range-controls').hidden = !hasRange;
  $('temperature-down').disabled =
    !editable || !finite(current) || current <= state.limits.minCelsius;
  $('temperature-up').disabled =
    !editable || !finite(current) || current >= state.limits.maxCelsius;
  text(
    'stepper-hint',
    editable
      ? `${temperatureText(state.limits.minCelsius)}–${temperatureText(state.limits.maxCelsius)}`
      : '',
  );
  for (const [id, field] of [
    ['range-heat', 'heatCelsius'],
    ['range-cool', 'coolCelsius'],
  ]) {
    const input = $(id);
    input.disabled = !editable;
    input.min = String(round(toDisplay(state.limits.minCelsius)));
    input.max = String(round(toDisplay(state.limits.maxCelsius)));
    input.step = unit === 'F' ? '1' : '0.5';
    if (document.activeElement !== input)
      input.value = finite(state.draft?.[field])
        ? String(round(toDisplay(state.draft[field])))
        : '';
  }
  document.querySelectorAll('.range-unit').forEach((node) => {
    node.textContent = `°${unit}`;
  });
  $('apply-temperature').disabled = !editable || !state.dirty;
  text('apply-temperature', state.busy ? 'Sending…' : 'Apply');
  text('ambient-value', temperatureText(s?.ambientCelsius));
  text('humidity-value', finite(s?.humidityPercent) ? `${Math.round(s.humidityPercent)}%` : '—');
  const synced = timeLabel(state.checkedAt || s?.observedAt);
  text(
    'sync-status',
    state.demo
      ? 'Sample data'
      : s
        ? `${state.stale ? 'Last reading' : 'Updated'}${synced ? ` ${synced}` : ''}`
        : '',
  );
  $('refresh').disabled = state.loading || state.busy || (!live && !state.demo);
  const modes =
    state.connected && s
      ? (s.availableModes || []).filter((m) => Object.hasOwn(modeNames, m))
      : ['HEAT', 'OFF'];
  $('mode-buttons').replaceChildren();
  for (const mode of modes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = modeNames[mode];
    button.dataset.mode = mode;
    button.setAttribute('aria-pressed', String(s?.mode === mode));
    button.disabled = !canControl() || s?.mode === mode;
    button.addEventListener('click', () => askCommand({ type: 'mode', mode }));
    $('mode-buttons').append(button);
  }
  const hasEco = Boolean(
    s?.availableEcoModes?.includes('MANUAL_ECO') && s.availableEcoModes.includes('OFF'),
  );
  $('eco-controls').hidden = !hasEco;
  $('eco-toggle').disabled = !canControl();
  $('eco-toggle').setAttribute('aria-pressed', String(eco));
  $('eco-toggle').setAttribute('aria-label', eco ? 'Turn Eco off' : 'Turn Eco on');
  text('eco-description', eco ? 'on' : '');
  $('eco-readings').hidden = !eco;
  text(
    'eco-readings',
    `Eco range ${temperatureText(s?.ecoHeatCelsius)}–${temperatureText(s?.ecoCoolCelsius)}`,
  );
  $('fan-card').hidden = !s?.hasFan;
  const fanRunning = s?.fanTimerMode === 'ON';
  text(
    'fan-description',
    fanRunning ? `Running${s.fanTimerTimeout ? ` until ${timeLabel(s.fanTimerTimeout)}` : ''}` : '',
  );
  $('fan-start').hidden = fanRunning;
  $('fan-duration').hidden = fanRunning;
  $('fan-start').disabled = !canControl();
  $('fan-duration').disabled = !canControl();
  $('fan-stop').hidden = !fanRunning;
  $('fan-stop').disabled = !canControl();
  $('owner-card').hidden = state.session.role !== 'owner' || state.demo;
  $('google-connect').disabled = state.busy || !state.owner?.googleConfigured;
  $('main').classList.toggle('is-busy', state.busy);
}

function scheduleRefresh() {
  clearTimeout(state.pollTimer);
  if (!document.hidden && !state.demo && state.session.authenticated) {
    state.pollTimer = setTimeout(async () => {
      await refreshStatus(false);
      scheduleRefresh();
    }, POLL_MS);
  }
}
async function refreshStatus(manual = false) {
  if (state.loading || state.busy) return;
  if (state.demo) {
    notice('Demo data.');
    return;
  }
  if (!state.session.authenticated) return;
  const generation = state.generation;
  state.loading = true;
  render();
  try {
    const result = await api('/api/thermostat');
    if (generation !== state.generation || state.demo) return;
    state.connected = Boolean(result.connected);
    state.snapshot = result.snapshot || null;
    state.stale = Boolean(result.stale);
    state.checkedAt = result.checkedAt || result.snapshot?.observedAt || null;
    state.limits = { ...fallbackLimits, ...result.limits };
    if (!state.dirty || !state.snapshot || state.snapshot.mode !== state.draft?.mode) {
      // Keep unsent changes only while their mode is unchanged.
      const draftMode = state.draft?.mode;
      if (!state.dirty || draftMode !== state.snapshot?.mode) resetDraft();
    }
    if (state.draft) state.draft.mode = state.snapshot?.mode;
    if (result.message) notice(result.message, state.stale && state.connected ? 'error' : 'info');
    else if (!state.connected) notice('Google Nest is not connected.');
    else if (state.stale) notice('Showing last reading. Refresh before making changes.', 'error');
    else if (state.snapshot?.connection !== 'ONLINE') notice('Thermostat is offline.', 'error');
    else if (manual) notice('Refreshed.', 'success');
    else if (state.lastNotice?.tone !== 'success') notice('');
  } catch (error) {
    if (generation !== state.generation) return;
    if (error.status === 401) lockSession();
    state.stale = Boolean(state.snapshot);
    notice(`${errorMessage(error)}${state.snapshot ? ' Showing last reading.' : ''}`, 'error');
  } finally {
    if (generation === state.generation) {
      state.loading = false;
      validateConfirmation();
      render();
    }
  }
}
async function refreshSession() {
  const generation = state.generation;
  try {
    const session = await api('/api/session');
    if (generation !== state.generation) return;
    state.session = session;
    if (!state.session.authenticated)
      notice(
        state.session.configured
          ? 'Sign in with your access key.'
          : 'No owner key yet. Run: npm run admin -- create-owner',
      );
    render();
    if (state.session.authenticated) {
      await refreshStatus();
      if (generation === state.generation && state.session.role === 'owner') await refreshOwner();
    }
  } catch (error) {
    if (generation !== state.generation) return;
    notice(errorMessage(error), 'error');
    render();
  }
  if (generation === state.generation) scheduleRefresh();
}
async function refreshOwner() {
  const generation = state.generation;
  try {
    const owner = await api('/api/owner/status');
    if (generation !== state.generation) return;
    state.owner = owner;
    text(
      'owner-description',
      state.owner.googleConnected
        ? 'Connected.'
        : state.owner.googleConfigured
          ? 'Not connected.'
          : 'Not configured. See docs/google-setup.md.',
    );
    text(
      'google-connect',
      state.owner.googleConnected ? 'Reconnect Google Nest' : 'Connect Google Nest',
    );
    $('access-list').replaceChildren();
    for (const entry of state.owner.accessKeys || []) {
      const row = document.createElement('div');
      row.className = 'access-row';
      const name = document.createElement('span');
      name.textContent = entry.label || 'Key';
      const detail = document.createElement('span');
      detail.className = 'muted small';
      detail.textContent =
        entry.role === 'owner'
          ? 'Owner'
          : entry.expiresAt
            ? `until ${new Date(entry.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
            : 'Guest';
      row.append(name, detail);
      if (entry.role !== 'owner') {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', () => revokeKey(entry));
        row.append(revoke);
      }
      $('access-list').append(row);
    }
    render();
  } catch (error) {
    if (generation === state.generation) text('owner-description', errorMessage(error));
  }
}
async function revokeKey(entry) {
  if (state.busy || !window.confirm(`Revoke access for ${entry.label}?`)) return;
  try {
    await api(`/api/owner/keys/${encodeURIComponent(entry.id)}`, {
      method: 'DELETE',
      body: '{}',
    });
    notice(`Revoked ${entry.label}.`, 'success');
  } catch (error) {
    notice(errorMessage(error), 'error');
  }
  await refreshOwner();
}
function setUnit(next) {
  unit = next;
  try {
    localStorage.setItem('neighbor-temperature-unit', unit);
  } catch {
    /* Storage is optional. */
  }
  render();
}
function adjustTemperature(direction) {
  if (!setpointEditable()) return;
  const field = state.snapshot.mode === 'COOL' ? 'coolCelsius' : 'heatCelsius';
  const current = state.draft[field];
  if (!finite(current)) return;
  const increment = unit === 'F' ? 5 / 9 : 0.5;
  state.draft[field] = Math.max(
    state.limits.minCelsius,
    Math.min(state.limits.maxCelsius, round(current + direction * increment, 4)),
  );
  state.dirty = true;
  render();
}
function commandDescription(command) {
  switch (command.type) {
    case 'heat':
      return `Heat to ${temperatureText(command.heatCelsius)}?`;
    case 'cool':
      return `Cool to ${temperatureText(command.coolCelsius)}?`;
    case 'range':
      return `Keep between ${temperatureText(command.heatCelsius)} and ${temperatureText(command.coolCelsius)}?`;
    case 'mode':
      return command.mode === 'OFF'
        ? 'Turn the thermostat off?'
        : `Switch to ${modeNames[command.mode]}?`;
    case 'eco':
      return command.mode === 'MANUAL_ECO' ? 'Turn Eco on?' : 'Turn Eco off?';
    case 'fan':
      return command.timerMode === 'OFF'
        ? 'Stop the fan?'
        : `Run the fan for ${$('fan-duration').selectedOptions[0]?.textContent || `${command.durationSeconds / 60} min`}?`;
    default:
      return 'Apply this change?';
  }
}
function askCommand(command) {
  if (!canControl()) return;
  if (['heat', 'cool', 'range'].includes(command.type)) {
    const values = [command.heatCelsius, command.coolCelsius].filter((v) => v !== undefined);
    if (
      !values.length ||
      values.some(
        (v) =>
          !finite(v) || v < state.limits.minCelsius - 0.001 || v > state.limits.maxCelsius + 0.001,
      )
    ) {
      notice(
        `Pick ${temperatureText(state.limits.minCelsius)}–${temperatureText(state.limits.maxCelsius)}.`,
        'error',
      );
      return;
    }
    if (
      command.type === 'range' &&
      command.coolCelsius - command.heatCelsius < state.limits.minRangeGapCelsius - 0.001
    ) {
      notice(
        `Heat and cool need ${unit === 'F' ? round((state.limits.minRangeGapCelsius * 9) / 5) : state.limits.minRangeGapCelsius}°${unit} between them.`,
        'error',
      );
      return;
    }
  }
  dismissConfirmation();
  state.pendingCommand = {
    command,
    createdAt: Date.now(),
    context: contextKey(),
    generation: state.generation,
  };
  state.confirmTimer = setTimeout(() => validateConfirmation(), 30_050);
  text('confirm-title', state.demo ? 'Confirm (demo)' : 'Confirm');
  text('confirm-description', commandDescription(command));
  text('confirm-apply', 'Confirm');
  $('confirm-dialog').showModal();
  $('confirm-cancel').focus();
}
function demoApply(command) {
  const s = state.snapshot;
  if (command.type === 'heat' || command.type === 'range') s.heatCelsius = command.heatCelsius;
  if (command.type === 'cool' || command.type === 'range') s.coolCelsius = command.coolCelsius;
  if (command.type === 'mode') {
    s.mode = command.mode;
    s.hvacStatus =
      command.mode === 'HEAT' ? 'HEATING' : command.mode === 'COOL' ? 'COOLING' : 'OFF';
  }
  if (command.type === 'eco') s.ecoMode = command.mode;
  if (command.type === 'fan') {
    s.fanTimerMode = command.timerMode;
    s.fanTimerTimeout =
      command.timerMode === 'ON'
        ? new Date(Date.now() + command.durationSeconds * 1000).toISOString()
        : null;
  }
  s.observedAt = new Date().toISOString();
  state.checkedAt = s.observedAt;
  resetDraft();
  if (state.draft) state.draft.mode = s.mode;
  notice('Done.', 'success');
}
async function executePendingCommand() {
  validateConfirmation();
  const pending = state.pendingCommand;
  if (!pending || !canControl()) return;
  const { command, generation } = pending;
  dismissConfirmation();
  if (state.demo) {
    demoApply(command);
    render();
    return;
  }
  state.busy = true;
  render();
  notice('Sending…');
  try {
    const result = await api('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), command }),
    });
    if (generation !== state.generation) return;
    if (result.snapshot) {
      state.snapshot = result.snapshot;
      state.checkedAt = result.snapshot.observedAt;
      state.stale = false;
    }
    if (result.confirmed) {
      resetDraft();
      if (state.draft) state.draft.mode = state.snapshot?.mode;
      notice(result.message || 'Done.', 'success');
    } else {
      state.stale = true;
      notice(result.message || 'Sent, but not confirmed yet. Refresh to check.', 'error');
    }
  } catch (error) {
    if (generation !== state.generation) return;
    if (error.status === 401) lockSession();
    state.stale = Boolean(state.snapshot);
    notice(`${errorMessage(error)} Refresh to check before retrying.`, 'error');
  } finally {
    if (generation === state.generation) {
      state.busy = false;
      render();
      scheduleRefresh();
    }
  }
}
function enterDemo() {
  if (state.busy) return;
  transitionView();
  state.demo = true;
  state.busy = false;
  state.connected = true;
  state.stale = false;
  state.limits = { ...fallbackLimits };
  state.snapshot = {
    connection: 'ONLINE',
    mode: 'HEAT',
    availableModes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'],
    ecoMode: 'OFF',
    availableEcoModes: ['MANUAL_ECO', 'OFF'],
    fanTimerMode: 'OFF',
    fanTimerTimeout: null,
    ambientCelsius: 19.5,
    humidityPercent: 42,
    heatCelsius: 21,
    coolCelsius: 24,
    ecoHeatCelsius: 16,
    ecoCoolCelsius: 27,
    temperatureScale: 'CELSIUS',
    hasSetpoint: true,
    hasFan: true,
    hvacStatus: 'HEATING',
    observedAt: new Date().toISOString(),
  };
  state.checkedAt = state.snapshot.observedAt;
  resetDraft();
  state.draft.mode = 'HEAT';
  notice('');
  render();
}
async function exitDemo() {
  if (DEMO_ONLY || state.busy) return;
  transitionView();
  state.demo = false;
  state.connected = false;
  state.snapshot = null;
  state.stale = false;
  resetDraft();
  render();
  notice('');
  await refreshSession();
}
$('unit-c').addEventListener('click', () => setUnit('C'));
$('unit-f').addEventListener('click', () => setUnit('F'));
$('temperature-down').addEventListener('click', () => adjustTemperature(-1));
$('temperature-up').addEventListener('click', () => adjustTemperature(1));
for (const [id, field] of [
  ['range-heat', 'heatCelsius'],
  ['range-cool', 'coolCelsius'],
]) {
  $(id).addEventListener('input', (event) => {
    if (!setpointEditable()) return;
    state.draft[field] =
      event.target.value === '' ? Number.NaN : round(toCelsius(Number(event.target.value)), 4);
    state.dirty = true;
    render();
  });
}
$('apply-temperature').addEventListener('click', () => {
  if (!setpointEditable()) return;
  const { heatCelsius, coolCelsius } = state.draft;
  askCommand(
    state.snapshot.mode === 'HEATCOOL'
      ? { type: 'range', heatCelsius, coolCelsius }
      : state.snapshot.mode === 'COOL'
        ? { type: 'cool', coolCelsius }
        : { type: 'heat', heatCelsius },
  );
});
$('eco-toggle').addEventListener('click', () =>
  askCommand({
    type: 'eco',
    mode: state.snapshot?.ecoMode === 'MANUAL_ECO' ? 'OFF' : 'MANUAL_ECO',
  }),
);
$('fan-start').addEventListener('click', () =>
  askCommand({ type: 'fan', timerMode: 'ON', durationSeconds: Number($('fan-duration').value) }),
);
$('fan-stop').addEventListener('click', () => askCommand({ type: 'fan', timerMode: 'OFF' }));
$('confirm-apply').addEventListener('click', executePendingCommand);
for (const id of ['confirm-cancel', 'confirm-close'])
  $(id).addEventListener('click', () => dismissConfirmation());
$('confirm-dialog').addEventListener('cancel', () => dismissConfirmation());
$('refresh').addEventListener('click', () => refreshStatus(true));
$('start-demo').addEventListener('click', enterDemo);
$('exit-demo').addEventListener('click', exitDemo);
$('login-open').addEventListener('click', () => {
  $('login-error').hidden = true;
  $('login-dialog').showModal();
  $('access-key').focus();
});
$('login-close').addEventListener('click', () => $('login-dialog').close());
$('login-dialog').addEventListener('close', () => {
  $('access-key').value = '';
});
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = $('access-key').value.trim();
  $('access-key').value = '';
  if (!key) return;
  const generation = transitionView();
  $('login-submit').disabled = true;
  $('login-error').hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ key }) });
    if (generation !== state.generation) return;
    $('login-dialog').close();
    state.demo = false;
    state.snapshot = null;
    state.connected = false;
    resetDraft();
    await refreshSession();
  } catch (error) {
    if (generation !== state.generation) return;
    text('login-error', errorMessage(error));
    $('login-error').hidden = false;
    $('access-key').focus();
  } finally {
    $('login-submit').disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  if (state.busy) return;
  const generation = transitionView();
  state.busy = true;
  render();
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    if (generation !== state.generation) return;
    state.session = { authenticated: false, configured: state.session.configured };
    state.connected = false;
    state.snapshot = null;
    state.owner = null;
    clearCreatedKey();
    resetDraft();
    clearTimeout(state.pollTimer);
    render();
    notice('Signed out.');
  } catch (error) {
    if (generation === state.generation) notice(errorMessage(error), 'error');
  } finally {
    if (generation === state.generation) {
      state.busy = false;
      render();
      scheduleRefresh();
    }
  }
});
$('google-connect').addEventListener('click', async () => {
  if (state.demo || DEMO_ONLY || state.session.role !== 'owner' || state.busy) return;
  const generation = state.generation;
  state.busy = true;
  render();
  $('google-connect').disabled = true;
  try {
    const result = await api('/api/owner/google/connect', { method: 'POST', body: '{}' });
    if (generation !== state.generation) return;
    const url = new URL(result.url);
    // Only Google's official authorization host may receive a top-level connection redirect.
    if (
      url.protocol !== 'https:' ||
      !['nestservices.google.com', 'accounts.google.com'].includes(url.hostname)
    )
      throw new Error('The connection URL could not be verified.');
    window.location.assign(url.href);
  } catch (error) {
    if (generation === state.generation) notice(errorMessage(error), 'error');
  } finally {
    if (generation === state.generation) {
      state.busy = false;
      render();
    }
  }
});
$('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const label = $('key-label').value.trim();
  if (!label || state.busy || state.session.role !== 'owner') return;
  $('key-create').disabled = true;
  try {
    const created = await api('/api/owner/keys', {
      method: 'POST',
      body: JSON.stringify({ label, days: Number($('key-days').value) }),
    });
    $('key-label').value = '';
    $('key-token').value = created.token;
    $('key-created').hidden = false;
    $('key-token').select();
    await refreshOwner();
  } catch (error) {
    notice(errorMessage(error), 'error');
  } finally {
    $('key-create').disabled = false;
  }
});
$('key-copy').addEventListener('click', async () => {
  $('key-token').select();
  try {
    await navigator.clipboard.writeText($('key-token').value);
  } catch {
    document.execCommand?.('copy');
  }
  text('key-copy', 'Copied');
  setTimeout(() => text('key-copy', 'Copy'), 1500);
});
document.addEventListener('visibilitychange', () => {
  clearTimeout(state.pollTimer);
  if (!document.hidden && state.session.authenticated && !state.demo)
    refreshStatus().finally(scheduleRefresh);
});
window.addEventListener('pagehide', () => {
  clearTimeout(state.pollTimer);
  $('access-key').value = '';
  clearCreatedKey();
});
render();
if (DEMO_ONLY) enterDemo();
else refreshSession();
