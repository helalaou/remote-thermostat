import { isDeviceResource, parseThermostat, type SdmCommand, type ThermostatSnapshot } from "../domain/thermostat.ts";

const SDM_ORIGIN = "https://smartdevicemanagement.googleapis.com/v1/";

export class GoogleApiError extends Error {
  readonly code: string;
  /** Safe application HTTP status; upstream auth failure is not app logout. */
  readonly status: number;
  readonly upstreamStatus: number | null;
  readonly retryAfterSeconds: number | null;
  /** A failed transport can hide a successful physical action. Never auto-retry. */
  readonly outcomeUnknown: boolean;

  constructor(code: string, message: string, options: { status?: number; upstreamStatus?: number; retryAfterSeconds?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "GoogleApiError";
    this.code = code;
    this.status = options.status ?? 502;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export interface SdmClientOptions {
  deviceResource: string;
  accessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface CommandReceipt {
  accepted: true;
  confirmed: false;
}

/** A tiny fixed-device client, deliberately not an arbitrary Google API proxy. */
export class SdmClient {
  readonly #deviceResource: string;
  readonly #accessToken: () => Promise<string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(options: SdmClientOptions) {
    if (!isDeviceResource(options.deviceResource)) throw new TypeError("A single valid SDM thermostat resource is required.");
    this.#deviceResource = options.deviceResource;
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) throw new TypeError("SDM timeout must be between 1 and 30000 ms.");
  }

  async getDevice(): Promise<ThermostatSnapshot> {
    const raw = await this.#request("GET");
    return parseThermostat(raw, this.#deviceResource, this.#now());
  }

  /** Acceptance is NOT readback or proof that the HVAC has started. */
  async execute(command: SdmCommand): Promise<CommandReceipt> {
    assertWireCommand(command);
    // Snapshot before awaiting tokens so callers cannot mutate an already-checked
    // request while token refresh is in progress.
    const checked = structuredClone(command);
    await this.#request("POST", checked);
    return { accepted: true, confirmed: false };
  }

  async #request(method: "GET" | "POST", command?: SdmCommand): Promise<unknown> {
    let token: string;
    try { token = await this.#accessToken(); }
    catch { throw new GoogleApiError("REAUTH_REQUIRED", "The owner needs to reconnect Google Nest."); }
    if (typeof token !== "string" || token.length < 1 || /[\r\n]/.test(token)) {
      throw new GoogleApiError("REAUTH_REQUIRED", "The owner needs to reconnect Google Nest.");
    }
    let response: Response;
    try {
      response = await this.#fetch(SDM_ORIGIN + this.#deviceResource + (method === "POST" ? ":executeCommand" : ""), {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(command) } : {}),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new GoogleApiError(method === "POST" ? "OUTCOME_UNKNOWN" : "NETWORK_ERROR", method === "POST"
        ? "The request may have reached the thermostat. Refresh its state before trying again."
        : "Google Nest could not be reached. Try refreshing later.", { outcomeUnknown: method === "POST" });
    }
    if (!response.ok) {
      const upstreamStatus = response.status;
      // Never expose Google's error body: it may contain account/device identifiers.
      await response.body?.cancel().catch(() => {});
      if (upstreamStatus === 429) throw new GoogleApiError("RATE_LIMITED", "Google Nest is limiting requests. Wait before trying again.", {
        status: 429, upstreamStatus, retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After"), this.#now()) ?? 60,
      });
      if (upstreamStatus === 401 || upstreamStatus === 403) throw new GoogleApiError("REAUTH_REQUIRED", "The owner needs to check the Google Nest connection and permissions.", { upstreamStatus });
      if (upstreamStatus === 400 || upstreamStatus === 409 || upstreamStatus === 412) throw new GoogleApiError("DEVICE_REJECTED", "The thermostat rejected this change. Refresh its state; its mode or supported limits may have changed.", { status: 409, upstreamStatus });
      if (upstreamStatus === 404) throw new GoogleApiError("DEVICE_NOT_FOUND", "The configured thermostat is no longer available. Ask the owner to check its connection.", { upstreamStatus });
      const outcomeUnknown = method === "POST" && upstreamStatus >= 500;
      throw new GoogleApiError(outcomeUnknown ? "OUTCOME_UNKNOWN" : "GOOGLE_UNAVAILABLE", outcomeUnknown
        ? "The thermostat's result is uncertain. Refresh its state before trying again."
        : "Google Nest is temporarily unavailable.", { upstreamStatus, outcomeUnknown });
    }
    try { return await response.json(); }
    catch {
      throw new GoogleApiError(method === "POST" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", method === "POST"
        ? "Google accepted the request but its result is uncertain. Refresh the thermostat."
        : "Google Nest returned an unreadable device response.", { outcomeUnknown: method === "POST" });
    }
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(1, Math.min(seconds, 86_400)) : null;
}

/** Runtime defense in depth for callers that bypass TypeScript. */
function assertWireCommand(value: SdmCommand): void {
  const raw = value as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid SDM command.");
  const item = raw as Record<string, unknown>;
  const params = item.params;
  if (Object.keys(item).length !== 2 || !Object.hasOwn(item, "command") || !Object.hasOwn(item, "params") || !params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("Invalid SDM command.");
  const fields = params as Record<string, unknown>;
  const exact = (keys: string[]) => Object.keys(fields).length === keys.length && keys.every((key) => Object.hasOwn(fields, key));
  const finite = (key: string) => typeof fields[key] === "number" && Number.isFinite(fields[key]);
  let valid = false;
  switch (item.command) {
    case "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat": valid = exact(["heatCelsius"]) && finite("heatCelsius"); break;
    case "sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool": valid = exact(["coolCelsius"]) && finite("coolCelsius"); break;
    case "sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange": valid = exact(["heatCelsius", "coolCelsius"]) && finite("heatCelsius") && finite("coolCelsius") && Number(fields.heatCelsius) < Number(fields.coolCelsius); break;
    case "sdm.devices.commands.ThermostatMode.SetMode": valid = exact(["mode"]) && typeof fields.mode === "string" && ["HEAT", "COOL", "HEATCOOL", "OFF"].includes(fields.mode); break;
    case "sdm.devices.commands.ThermostatEco.SetMode": valid = exact(["mode"]) && typeof fields.mode === "string" && ["MANUAL_ECO", "OFF"].includes(fields.mode); break;
    case "sdm.devices.commands.Fan.SetTimer": {
      const duration = typeof fields.duration === "string" && /^\d+s$/.test(fields.duration) ? Number(fields.duration.slice(0, -1)) : NaN;
      valid = fields.timerMode === "OFF" && exact(["timerMode"]) || fields.timerMode === "ON" && exact(["timerMode", "duration"]) && duration >= 1 && duration <= 43_200;
      break;
    }
  }
  if (!valid) throw new TypeError("Unsupported or malformed SDM command.");
}
