import type { Store } from './store.ts';

export const CONTROL_MODES = ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
/** What guests may use. The owner is never restricted. */
export interface GuestControls {
  modes: ControlMode[];
  eco: boolean;
}

const KEY = 'guest-controls';

export function parseGuestControls(input: unknown): GuestControls | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.modes) ||
    typeof value.eco !== 'boolean' ||
    value.modes.some((mode) => !CONTROL_MODES.includes(mode)) ||
    new Set(value.modes).size !== value.modes.length
  )
    return null;
  const modes = value.modes as unknown[];
  return { modes: CONTROL_MODES.filter((mode) => modes.includes(mode)), eco: value.eco };
}

export function readGuestControls(store: Store): GuestControls {
  try {
    const saved = parseGuestControls(JSON.parse(store.get(KEY) || 'null'));
    if (saved) return saved;
  } catch {
    /* Fall back to allowing everything. */
  }
  return { modes: [...CONTROL_MODES], eco: true };
}

export function writeGuestControls(store: Store, controls: GuestControls) {
  store.set(KEY, JSON.stringify(controls));
}

/** Why a guest may not send this command, or null if it's allowed. Turning Eco off is always allowed. */
export function guestRefusal(command: unknown, controls: GuestControls): string | null {
  if (!command || typeof command !== 'object') return null;
  const { type, mode } = command as Record<string, unknown>;
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
  if (needed !== null && !controls.modes.includes(needed as ControlMode))
    return 'The owner has turned this mode off.';
  if (type === 'eco' && mode !== 'OFF' && !controls.eco) return 'The owner has turned Eco off.';
  return null;
}
