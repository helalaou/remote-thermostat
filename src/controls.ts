import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';

export const CONTROL_MODES = ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

/** What the user code may do. The admin is never restricted. */
export interface UserAccess {
  enabled: boolean;
  modes: ControlMode[];
  eco: boolean;
  minCelsius: number;
  maxCelsius: number;
}

export interface AccessStore {
  get(): Promise<unknown>;
  set(access: UserAccess): Promise<void>;
}

export function defaultAccess(config: Config): UserAccess {
  return {
    enabled: true,
    modes: [...CONTROL_MODES],
    eco: true,
    minCelsius: config.minCelsius,
    maxCelsius: config.maxCelsius,
  };
}

export function parseUserAccess(input: unknown, config: Config): UserAccess | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const { enabled, modes, eco, minCelsius, maxCelsius } = value;
  if (
    Object.keys(value).length !== 5 ||
    typeof enabled !== 'boolean' ||
    typeof eco !== 'boolean' ||
    !Array.isArray(modes) ||
    modes.some((mode) => !CONTROL_MODES.includes(mode)) ||
    new Set(modes).size !== modes.length ||
    typeof minCelsius !== 'number' ||
    typeof maxCelsius !== 'number' ||
    !(minCelsius >= config.minCelsius) ||
    !(maxCelsius <= config.maxCelsius) ||
    !(maxCelsius - minCelsius >= config.minRangeGapCelsius)
  )
    return null;
  return {
    enabled,
    modes: CONTROL_MODES.filter((mode) => modes.includes(mode)),
    eco,
    minCelsius,
    maxCelsius,
  };
}

export async function readUserAccess(store: AccessStore, config: Config): Promise<UserAccess> {
  let saved: unknown;
  try {
    saved = await store.get();
  } catch {
    // If saved settings can't be read, lock the user out rather than fall back to full access.
    return { ...defaultAccess(config), enabled: false };
  }
  return parseUserAccess(saved, config) ?? defaultAccess(config);
}

/** Why the user may not send this command, or null if allowed. Turning Eco off is always allowed. */
export function userRefusal(command: unknown, access: UserAccess): string | null {
  if (!access.enabled) return 'Access is turned off.';
  if (!command || typeof command !== 'object') return null;
  const { type, mode, heatCelsius, coolCelsius } = command as Record<string, unknown>;
  const needed =
    type === 'mode'
      ? mode
      : type === 'heat'
        ? 'HEAT'
        : type === 'cool'
          ? 'COOL'
          : type === 'range'
            ? 'HEATCOOL'
            : null;
  if (needed !== null && !access.modes.includes(needed as ControlMode))
    return 'This mode is turned off for you.';
  if (type === 'eco' && mode !== 'OFF' && !access.eco) return 'Eco is turned off for you.';
  for (const target of [heatCelsius, coolCelsius])
    if (
      typeof target === 'number' &&
      (target < access.minCelsius - 0.001 || target > access.maxCelsius + 0.001)
    )
      return `Pick a temperature between ${access.minCelsius} and ${access.maxCelsius} °C.`;
  return null;
}

/** Local runs keep user access in data/access.json. */
export function fileAccessStore(directory: string): AccessStore {
  const file = join(directory, 'access.json');
  return {
    async get() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return null;
      }
    },
    async set(access) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(access), { mode: 0o600 });
    },
  };
}

export function memoryAccessStore(): AccessStore {
  let saved: unknown = null;
  return {
    async get() {
      return saved;
    },
    async set(access) {
      saved = access;
    },
  };
}
