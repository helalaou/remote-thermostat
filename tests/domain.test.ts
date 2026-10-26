import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommandValidationError,
  parseThermostat,
  resolveControlPolicy,
  validateCommand,
} from '../src/domain/thermostat.ts';

const resource = 'enterprises/test-project/devices/test-device';
const now = Date.parse('2026-01-01T12:00:00.000Z');
const prefix = 'sdm.devices.traits.';

function raw(overrides: Record<string, unknown> = {}) {
  return {
    name: resource,
    type: 'sdm.devices.types.THERMOSTAT',
    traits: {
      [prefix + 'Connectivity']: { status: 'ONLINE' },
      [prefix + 'ThermostatMode']: { mode: 'HEAT', availableModes: ['HEAT', 'OFF'] },
      [prefix + 'ThermostatEco']: {
        mode: 'OFF',
        availableModes: ['MANUAL_ECO', 'OFF'],
        heatCelsius: 16,
        coolCelsius: 26,
      },
      [prefix + 'ThermostatTemperatureSetpoint']: { heatCelsius: 20 },
      [prefix + 'Temperature']: { ambientTemperatureCelsius: 19.5 },
      [prefix + 'Humidity']: { ambientHumidityPercent: 40 },
      [prefix + 'Settings']: { temperatureScale: 'FAHRENHEIT' },
      [prefix + 'ThermostatHvac']: { status: 'HEATING' },
      ...overrides,
    },
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return parseThermostat(raw(overrides), resource, now);
}

function code(expected: string) {
  return (error: unknown) => error instanceof CommandValidationError && error.code === expected;
}

test('parses only thermostat traits without exposing identifiers', () => {
  const state = snapshot();
  assert.equal(state.ambientCelsius, 19.5);
  assert.equal(state.temperatureScale, 'FAHRENHEIT');
  assert.equal(state.hvacStatus, 'HEATING');
  assert.deepEqual(state.availableModes, ['HEAT', 'OFF']);
  assert.equal(state.hasFan, false);
  assert.equal(state.fanTimerMode, null);
  assert.ok(!JSON.stringify(state).includes(resource));
});

test('rejects another device, type, missing traits and invalid configured resource', () => {
  for (const input of [
    null,
    {},
    { ...raw(), name: 'enterprises/other/devices/other' },
    { ...raw(), type: 'sdm.devices.types.CAMERA' },
    { ...raw(), traits: [] },
  ]) {
    assert.throws(() => parseThermostat(input, resource, now), code('INVALID_DEVICE_RESPONSE'));
  }
  assert.throws(
    () => parseThermostat(raw(), resource + '/../x', now),
    code('INVALID_DEVICE_RESPONSE'),
  );
});

test('does not invent absent or unknown capabilities', () => {
  const state = parseThermostat({ ...raw(), traits: {} }, resource, now);
  assert.equal(state.connection, 'UNKNOWN');
  assert.equal(state.mode, null);
  assert.equal(state.hasSetpoint, false);
  assert.equal(state.hasEco, false);
  assert.deepEqual(state.availableModes, []);
  assert.throws(
    () => validateCommand({ type: 'mode', mode: 'HEAT' }, state, {}, now),
    code('DEVICE_OFFLINE'),
  );
});

test('drops invalid sensor numbers and unknown enums', () => {
  const state = snapshot({
    [prefix + 'Temperature']: { ambientTemperatureCelsius: '20' },
    [prefix + 'Humidity']: { ambientHumidityPercent: 101 },
    [prefix + 'Settings']: { temperatureScale: 'KELVIN' },
    [prefix + 'ThermostatMode']: { mode: 'FUTURE', availableModes: ['HEAT', 'HEAT', 'FUTURE', 1] },
  });
  assert.equal(state.ambientCelsius, null);
  assert.equal(state.humidityPercent, null);
  assert.equal(state.mode, null);
  assert.equal(state.temperatureScale, null);
  assert.deepEqual(state.availableModes, ['HEAT']);
});

test('heat commands use Celsius and never alter mode or Eco', () => {
  assert.deepEqual(validateCommand({ type: 'heat', heatCelsius: 21.5 }, snapshot(), {}, now), {
    command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat',
    params: { heatCelsius: 21.5 },
  });
});

test('finite numeric application bounds are enforced without coercion', () => {
  for (const heatCelsius of [NaN, Infinity, -Infinity, '21', null, 9.9, 30.1]) {
    assert.throws(
      () => validateCommand({ type: 'heat', heatCelsius }, snapshot(), {}, now),
      code('TEMPERATURE_OUT_OF_RANGE'),
    );
  }
  for (const heatCelsius of [10, 30])
    assert.doesNotThrow(() => validateCommand({ type: 'heat', heatCelsius }, snapshot(), {}, now));
  assert.throws(
    () => validateCommand({ type: 'heat', heatCelsius: 25 }, snapshot(), { maxCelsius: 24 }, now),
    code('TEMPERATURE_OUT_OF_RANGE'),
  );
});

test('setpoints fail closed in wrong mode, missing targets, Eco, and unknown Eco', () => {
  assert.throws(
    () => validateCommand({ type: 'cool', coolCelsius: 22 }, snapshot(), {}, now),
    code('MODE_MISMATCH'),
  );
  assert.throws(
    () =>
      validateCommand(
        { type: 'heat', heatCelsius: 22 },
        snapshot({ [prefix + 'ThermostatTemperatureSetpoint']: {} }),
        {},
        now,
      ),
    code('SETPOINT_UNAVAILABLE'),
  );
  for (const mode of ['MANUAL_ECO', 'FUTURE', undefined]) {
    assert.throws(
      () =>
        validateCommand(
          { type: 'heat', heatCelsius: 22 },
          snapshot({ [prefix + 'ThermostatEco']: { mode, availableModes: ['MANUAL_ECO', 'OFF'] } }),
          {},
          now,
        ),
      code('ECO_ACTIVE'),
    );
  }
});

test('cool and heat-cool commands require reported capabilities and proper range', () => {
  const cool = snapshot({
    [prefix + 'ThermostatMode']: { mode: 'COOL', availableModes: ['COOL', 'OFF'] },
    [prefix + 'ThermostatTemperatureSetpoint']: { coolCelsius: 24 },
  });
  assert.deepEqual(validateCommand({ type: 'cool', coolCelsius: 23 }, cool, {}, now), {
    command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool',
    params: { coolCelsius: 23 },
  });
  const range = snapshot({
    [prefix + 'ThermostatMode']: { mode: 'HEATCOOL', availableModes: ['HEATCOOL', 'OFF'] },
    [prefix + 'ThermostatTemperatureSetpoint']: { heatCelsius: 20, coolCelsius: 24 },
  });
  assert.deepEqual(
    validateCommand({ type: 'range', heatCelsius: 20, coolCelsius: 21.5 }, range, {}, now).params,
    { heatCelsius: 20, coolCelsius: 21.5 },
  );
  for (const coolCelsius of [19, 20, 21.4])
    assert.throws(
      () => validateCommand({ type: 'range', heatCelsius: 20, coolCelsius }, range, {}, now),
      code('RANGE_TOO_NARROW'),
    );
});

test('snapshot must be online and freshly observed', () => {
  const action = { type: 'heat', heatCelsius: 21 };
  for (const status of ['OFFLINE', 'FUTURE', undefined]) {
    assert.throws(
      () => validateCommand(action, snapshot({ [prefix + 'Connectivity']: { status } }), {}, now),
      code('DEVICE_OFFLINE'),
    );
  }
  for (const checkedAt of [now - 1, now + 15_001])
    assert.throws(() => validateCommand(action, snapshot(), {}, checkedAt), code('STALE_STATE'));
  assert.throws(
    () => validateCommand(action, { ...snapshot(), observedAt: 'not-a-date' }, {}, now),
    code('STALE_STATE'),
  );
  assert.doesNotThrow(() => validateCommand(action, snapshot(), {}, now + 15_000));
});

test('rejects arbitrary commands, extra device identifiers and missing values', () => {
  for (const input of [
    null,
    [],
    {},
    { type: 'schedule' },
    { type: 'heat', heatCelsius: 21, device: 'other' },
    { type: 'heat' },
    { type: 'mode', mode: 'HEAT', command: 'anything' },
  ]) {
    assert.throws(() => validateCommand(input, snapshot(), {}, now), code('INVALID_COMMAND'));
  }
});

test('mode and Eco controls remain separate explicit operations', () => {
  assert.deepEqual(validateCommand({ type: 'mode', mode: 'OFF' }, snapshot(), {}, now), {
    command: 'sdm.devices.commands.ThermostatMode.SetMode',
    params: { mode: 'OFF' },
  });
  assert.throws(
    () => validateCommand({ type: 'mode', mode: 'COOL' }, snapshot(), {}, now),
    code('UNSUPPORTED_MODE'),
  );
  assert.deepEqual(validateCommand({ type: 'eco', mode: 'MANUAL_ECO' }, snapshot(), {}, now), {
    command: 'sdm.devices.commands.ThermostatEco.SetMode',
    params: { mode: 'MANUAL_ECO' },
  });
  assert.throws(
    () => validateCommand({ type: 'eco', mode: 'AUTO_ECO' }, snapshot(), {}, now),
    code('UNSUPPORTED_ECO_MODE'),
  );
});

test('fan controls require the trait and bounded whole-second duration', () => {
  assert.throws(
    () =>
      validateCommand({ type: 'fan', timerMode: 'ON', durationSeconds: 900 }, snapshot(), {}, now),
    code('FAN_UNAVAILABLE'),
  );
  const state = snapshot({ [prefix + 'Fan']: { timerMode: 'OFF' } });
  for (const durationSeconds of [1, 900, 43_200]) {
    assert.deepEqual(
      validateCommand({ type: 'fan', timerMode: 'ON', durationSeconds }, state, {}, now).params,
      { timerMode: 'ON', duration: `${durationSeconds}s` },
    );
  }
  for (const durationSeconds of [0, -1, 43_201, 1.5, NaN, '900'])
    assert.throws(
      () => validateCommand({ type: 'fan', timerMode: 'ON', durationSeconds }, state, {}, now),
      code('INVALID_FAN_DURATION'),
    );
  assert.deepEqual(validateCommand({ type: 'fan', timerMode: 'OFF' }, state, {}, now).params, {
    timerMode: 'OFF',
  });
  assert.throws(
    () => validateCommand({ type: 'fan', timerMode: 'OFF', durationSeconds: 900 }, state, {}, now),
    code('INVALID_COMMAND'),
  );
});

test('invalid administrator policy fails closed', () => {
  for (const policy of [
    { minCelsius: NaN },
    { minCelsius: 31 },
    { maxCelsius: 10 },
    { minRangeGapCelsius: 0 },
    { minRangeGapCelsius: 100 },
    { maxSnapshotAgeMs: 15_001 },
    { maxSnapshotAgeMs: 0 },
  ]) {
    assert.throws(() => resolveControlPolicy(policy), TypeError);
  }
});
