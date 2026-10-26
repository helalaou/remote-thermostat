/**
 * The SDM boundary. Unknown or missing traits never become invented capabilities.
 * Google reports all temperature values in Celsius, regardless of display scale.
 * Reference: https://developers.google.com/nest/device-access/api/thermostat
 */
export const THERMOSTAT_MODES = ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] as const;
export const ECO_MODES = ['MANUAL_ECO', 'OFF'] as const;
export type ThermostatMode = (typeof THERMOSTAT_MODES)[number];
export type EcoMode = (typeof ECO_MODES)[number];

export interface ThermostatSnapshot {
  connection: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  mode: ThermostatMode | null;
  availableModes: ThermostatMode[];
  ecoMode: EcoMode | null;
  availableEcoModes: EcoMode[];
  hasEco: boolean;
  hasSetpoint: boolean;
  hasFan: boolean;
  fanTimerMode: 'ON' | 'OFF' | null;
  fanTimerTimeout: string | null;
  ambientCelsius: number | null;
  humidityPercent: number | null;
  heatCelsius: number | null;
  coolCelsius: number | null;
  ecoHeatCelsius: number | null;
  ecoCoolCelsius: number | null;
  temperatureScale: 'CELSIUS' | 'FAHRENHEIT' | null;
  hvacStatus: 'OFF' | 'HEATING' | 'COOLING' | null;
  /** Time this server observed the response, not a device-reported update time. */
  observedAt: string;
}

/** These are application safety limits, not a claim about device-wide limits. */
export interface ControlPolicy {
  minCelsius: number;
  maxCelsius: number;
  minRangeGapCelsius: number;
  maxSnapshotAgeMs: number;
}

export const DEFAULT_CONTROL_POLICY: Readonly<ControlPolicy> = Object.freeze({
  minCelsius: 10,
  maxCelsius: 30,
  minRangeGapCelsius: 1.5,
  maxSnapshotAgeMs: 15_000,
});

export type ThermostatAction =
  | { type: 'heat'; heatCelsius: number }
  | { type: 'cool'; coolCelsius: number }
  | { type: 'range'; heatCelsius: number; coolCelsius: number }
  | { type: 'mode'; mode: ThermostatMode }
  | { type: 'eco'; mode: EcoMode }
  | { type: 'fan'; timerMode: 'ON'; durationSeconds: number }
  | { type: 'fan'; timerMode: 'OFF' };

export type SdmCommand =
  | {
      command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat';
      params: { heatCelsius: number };
    }
  | {
      command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool';
      params: { coolCelsius: number };
    }
  | {
      command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange';
      params: { heatCelsius: number; coolCelsius: number };
    }
  | { command: 'sdm.devices.commands.ThermostatMode.SetMode'; params: { mode: ThermostatMode } }
  | { command: 'sdm.devices.commands.ThermostatEco.SetMode'; params: { mode: EcoMode } }
  | {
      command: 'sdm.devices.commands.Fan.SetTimer';
      params: { timerMode: 'ON'; duration: string } | { timerMode: 'OFF' };
    };

export class CommandValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = 'CommandValidationError';
    this.code = code;
    this.status = status;
  }
}

const traitPrefix = 'sdm.devices.traits.';
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const member = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  typeof value === 'string' && values.includes(value as T) ? (value as T) : null;
const members = <T extends string>(value: unknown, values: readonly T[]): T[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.map((item) => member(item, values)).filter((item): item is T => item !== null),
        ),
      ]
    : [];

export function isDeviceResource(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^enterprises\/[A-Za-z0-9_-]+\/devices\/[A-Za-z0-9_-]+$/.test(value)
  );
}

/** Only parse the configured thermostat. Never expose its resource name to the UI. */
export function parseThermostat(
  raw: unknown,
  expectedResource: string,
  now = Date.now(),
): ThermostatSnapshot {
  const device = object(raw);
  const traits = object(device?.traits);
  if (
    !isDeviceResource(expectedResource) ||
    device?.name !== expectedResource ||
    device.type !== 'sdm.devices.types.THERMOSTAT' ||
    !traits
  ) {
    throw new CommandValidationError(
      'INVALID_DEVICE_RESPONSE',
      'The configured thermostat could not be verified.',
      502,
    );
  }
  if (!Number.isFinite(now)) throw new TypeError('Observation time must be finite.');
  const trait = (name: string) => object(traits[traitPrefix + name]);
  const mode = trait('ThermostatMode');
  const eco = trait('ThermostatEco');
  const fan = trait('Fan');
  const setpoint = trait('ThermostatTemperatureSetpoint');
  const humidity = finite(trait('Humidity')?.ambientHumidityPercent);
  const timeout = fan?.timerTimeout;
  return {
    connection: member(trait('Connectivity')?.status, ['ONLINE', 'OFFLINE']) ?? 'UNKNOWN',
    mode: member(mode?.mode, THERMOSTAT_MODES),
    availableModes: members(mode?.availableModes, THERMOSTAT_MODES),
    ecoMode: member(eco?.mode, ECO_MODES),
    availableEcoModes: members(eco?.availableModes, ECO_MODES),
    hasEco: eco !== null,
    hasSetpoint: setpoint !== null,
    hasFan: fan !== null,
    fanTimerMode: member(fan?.timerMode, ['ON', 'OFF']),
    fanTimerTimeout:
      typeof timeout === 'string' && Number.isFinite(Date.parse(timeout)) ? timeout : null,
    ambientCelsius: finite(trait('Temperature')?.ambientTemperatureCelsius),
    humidityPercent: humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
    heatCelsius: finite(setpoint?.heatCelsius),
    coolCelsius: finite(setpoint?.coolCelsius),
    ecoHeatCelsius: finite(eco?.heatCelsius),
    ecoCoolCelsius: finite(eco?.coolCelsius),
    temperatureScale: member(trait('Settings')?.temperatureScale, ['CELSIUS', 'FAHRENHEIT']),
    hvacStatus: member(trait('ThermostatHvac')?.status, ['OFF', 'HEATING', 'COOLING']),
    observedAt: new Date(now).toISOString(),
  };
}

export function resolveControlPolicy(overrides: Partial<ControlPolicy> = {}): ControlPolicy {
  const policy = { ...DEFAULT_CONTROL_POLICY, ...overrides };
  if (
    !Object.values(policy).every((value) => typeof value === 'number' && Number.isFinite(value)) ||
    policy.minCelsius >= policy.maxCelsius ||
    policy.minRangeGapCelsius <= 0 ||
    policy.minRangeGapCelsius > policy.maxCelsius - policy.minCelsius ||
    policy.maxSnapshotAgeMs <= 0 ||
    policy.maxSnapshotAgeMs > 15_000
  ) {
    throw new TypeError('Invalid thermostat control policy.');
  }
  return policy;
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  ) {
    throw new CommandValidationError(
      'INVALID_COMMAND',
      'This control request contains unexpected or missing fields.',
    );
  }
}

/** Revalidate against a just-fetched snapshot immediately before execution. */
export function validateCommand(
  input: unknown,
  snapshot: ThermostatSnapshot,
  overrides: Partial<ControlPolicy> = {},
  now = Date.now(),
): SdmCommand {
  const request = object(input);
  if (!request)
    throw new CommandValidationError('INVALID_COMMAND', 'Choose a supported thermostat control.');
  const policy = resolveControlPolicy(overrides);
  const age = now - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > policy.maxSnapshotAgeMs) {
    throw new CommandValidationError(
      'STALE_STATE',
      'Refresh the thermostat before trying again.',
      409,
    );
  }
  if (snapshot.connection !== 'ONLINE') {
    throw new CommandValidationError(
      'DEVICE_OFFLINE',
      'The thermostat is offline or its connection is unknown.',
      409,
    );
  }
  const temperature = (value: unknown): number => {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < policy.minCelsius ||
      value > policy.maxCelsius
    ) {
      throw new CommandValidationError(
        'TEMPERATURE_OUT_OF_RANGE',
        `Choose a temperature between ${policy.minCelsius} and ${policy.maxCelsius} °C.`,
      );
    }
    return value;
  };
  const requireSetpoint = (mode: ThermostatMode) => {
    if (
      !snapshot.hasSetpoint ||
      snapshot.mode !== mode ||
      !snapshot.availableModes.includes(mode)
    ) {
      throw new CommandValidationError(
        'MODE_MISMATCH',
        'Select the corresponding thermostat mode first, then refresh its state.',
        409,
      );
    }
    if (snapshot.hasEco && snapshot.ecoMode !== 'OFF') {
      throw new CommandValidationError(
        'ECO_ACTIVE',
        'Turn Eco off explicitly before changing the target temperature.',
        409,
      );
    }
    if (
      (mode !== 'COOL' && snapshot.heatCelsius === null) ||
      (mode !== 'HEAT' && snapshot.coolCelsius === null)
    ) {
      throw new CommandValidationError(
        'SETPOINT_UNAVAILABLE',
        'The current temperature target is unavailable. Refresh before trying again.',
        409,
      );
    }
  };
  switch (request.type) {
    case 'heat':
      exactKeys(request, ['type', 'heatCelsius']);
      requireSetpoint('HEAT');
      return {
        command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat',
        params: { heatCelsius: temperature(request.heatCelsius) },
      };
    case 'cool':
      exactKeys(request, ['type', 'coolCelsius']);
      requireSetpoint('COOL');
      return {
        command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool',
        params: { coolCelsius: temperature(request.coolCelsius) },
      };
    case 'range': {
      exactKeys(request, ['type', 'heatCelsius', 'coolCelsius']);
      requireSetpoint('HEATCOOL');
      const heatCelsius = temperature(request.heatCelsius);
      const coolCelsius = temperature(request.coolCelsius);
      if (coolCelsius - heatCelsius < policy.minRangeGapCelsius) {
        throw new CommandValidationError(
          'RANGE_TOO_NARROW',
          `Keep cooling at least ${policy.minRangeGapCelsius} °C above heating.`,
        );
      }
      return {
        command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange',
        params: { heatCelsius, coolCelsius },
      };
    }
    case 'mode': {
      exactKeys(request, ['type', 'mode']);
      const mode = member(request.mode, THERMOSTAT_MODES);
      if (!mode || !snapshot.availableModes.includes(mode)) {
        throw new CommandValidationError(
          'UNSUPPORTED_MODE',
          'This thermostat does not report support for that mode.',
        );
      }
      return { command: 'sdm.devices.commands.ThermostatMode.SetMode', params: { mode } };
    }
    case 'eco': {
      exactKeys(request, ['type', 'mode']);
      const mode = member(request.mode, ECO_MODES);
      if (!snapshot.hasEco || !mode || !snapshot.availableEcoModes.includes(mode)) {
        throw new CommandValidationError(
          'UNSUPPORTED_ECO_MODE',
          'This thermostat does not report support for that Eco setting.',
        );
      }
      // Some models reject this when OFF. Never silently turn heating on to work around it.
      if (snapshot.mode === null)
        throw new CommandValidationError(
          'MODE_UNKNOWN',
          'Refresh the thermostat mode before changing Eco.',
          409,
        );
      return { command: 'sdm.devices.commands.ThermostatEco.SetMode', params: { mode } };
    }
    case 'fan': {
      if (!snapshot.hasFan || snapshot.fanTimerMode === null) {
        throw new CommandValidationError(
          'FAN_UNAVAILABLE',
          'This thermostat does not report an available fan timer.',
        );
      }
      if (request.timerMode === 'OFF') {
        exactKeys(request, ['type', 'timerMode']);
        return { command: 'sdm.devices.commands.Fan.SetTimer', params: { timerMode: 'OFF' } };
      }
      exactKeys(request, ['type', 'timerMode', 'durationSeconds']);
      if (
        request.timerMode !== 'ON' ||
        typeof request.durationSeconds !== 'number' ||
        !Number.isInteger(request.durationSeconds) ||
        request.durationSeconds < 1 ||
        request.durationSeconds > 43_200
      ) {
        throw new CommandValidationError(
          'INVALID_FAN_DURATION',
          'Choose a whole-number fan duration between 1 second and 12 hours.',
        );
      }
      return {
        command: 'sdm.devices.commands.Fan.SetTimer',
        params: { timerMode: 'ON', duration: `${request.durationSeconds}s` },
      };
    }
    default:
      throw new CommandValidationError('INVALID_COMMAND', 'Choose a supported thermostat control.');
  }
}
