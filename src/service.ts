import { createHash } from 'node:crypto';
import { Store, RateLimitError } from './store.ts';
import {
  CommandValidationError,
  validateCommand,
  type ControlPolicy,
  type SdmCommand,
  type ThermostatSnapshot,
} from './domain/thermostat.ts';
import { GoogleApiError } from './google/sdm.ts';

export interface DeviceClient {
  getDevice(): Promise<ThermostatSnapshot>;
  execute(command: SdmCommand, authorized?: () => boolean): Promise<unknown>;
}
export interface CommandResponse {
  accepted: boolean;
  confirmed: boolean;
  message: string;
  snapshot?: ThermostatSnapshot;
  outcomeUnknown?: boolean;
  retryAfterSeconds?: number;
}
export interface ServiceOptions {
  store: Store;
  client: () => DeviceClient | null;
  policy: Partial<ControlPolicy>;
  now?: () => number;
}
export class ThermostatService {
  store: Store;
  client: () => DeviceClient | null;
  policy: Partial<ControlPolicy>;
  now: () => number;
  snapshot?: ThermostatSnapshot;
  lastError?: { message: string; retryAfterSeconds?: number };
  pendingRead?: Promise<ThermostatSnapshot>;
  busy = false;
  generation = 0;
  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.client = options.client;
    this.policy = options.policy;
    this.now = options.now || Date.now;
  }
  reset() {
    this.generation++;
    this.snapshot = undefined;
    this.lastError = undefined;
  }
  cooldown() {
    return Math.max(
      0,
      Math.ceil((Number(this.store.get('google-cooldown-until') || 0) - this.now()) / 1000),
    );
  }
  private catchQuota(error: unknown) {
    if (error instanceof GoogleApiError && error.status === 429) {
      this.store.set(
        'google-cooldown-until',
        String(this.now() + (error.retryAfterSeconds || 60) * 1000),
      );
    }
  }
  private async read(fresh = false): Promise<ThermostatSnapshot> {
    const client = this.client();
    if (!client)
      throw new CommandValidationError(
        'NOT_CONNECTED',
        'The owner has not connected Google Nest yet.',
        503,
      );
    if (
      !fresh &&
      this.snapshot &&
      !this.lastError &&
      this.now() - Date.parse(this.snapshot.observedAt) < 30_000
    )
      return this.snapshot;
    if (this.pendingRead) return this.pendingRead;
    const wait = this.cooldown();
    if (wait) throw new RateLimitError(wait);
    this.store.reserve('google-reads', [{ max: 10, windowMs: 60_000 }], this.now());
    const generation = this.generation;
    this.pendingRead = (async () => {
      try {
        const snapshot = await client.getDevice();
        if (generation !== this.generation)
          throw new CommandValidationError(
            'CONNECTION_CHANGED',
            'The connection changed. Refresh the thermostat.',
            409,
          );
        this.snapshot = snapshot;
        this.lastError = undefined;
        return snapshot;
      } catch (error) {
        this.catchQuota(error);
        if (generation === this.generation)
          this.lastError = {
            message:
              error instanceof GoogleApiError
                ? error.message
                : 'The latest thermostat status could not be read.',
            retryAfterSeconds:
              error instanceof GoogleApiError ? error.retryAfterSeconds || undefined : undefined,
          };
        throw error;
      } finally {
        this.pendingRead = undefined;
      }
    })();
    return this.pendingRead;
  }
  async status() {
    const limits = {
      minCelsius: this.policy.minCelsius ?? 10,
      maxCelsius: this.policy.maxCelsius ?? 30,
      minRangeGapCelsius: this.policy.minRangeGapCelsius ?? 1.5,
    };
    if (!this.client())
      return {
        connected: false,
        stale: true,
        limits,
        message: 'Google Nest is not connected.',
      };
    if (this.busy)
      return {
        connected: true,
        snapshot: this.snapshot,
        stale: true,
        commandInProgress: true,
        checkedAt: this.snapshot?.observedAt,
        limits,
        message: 'A change is still in progress. Wait for its outcome before sending another.',
      };
    try {
      const snapshot = await this.read();
      return { connected: true, snapshot, stale: false, checkedAt: snapshot.observedAt, limits };
    } catch (error) {
      return {
        connected: true,
        snapshot: this.snapshot,
        stale: true,
        checkedAt: this.snapshot?.observedAt,
        limits,
        message:
          error instanceof GoogleApiError || error instanceof RateLimitError
            ? error.message
            : 'Unable to refresh thermostat status.',
        retryAfterSeconds:
          error instanceof RateLimitError ? error.retryAfterSeconds : this.cooldown() || undefined,
      };
    }
  }
  async command(
    keyId: string,
    requestId: string,
    input: unknown,
    authorized: () => boolean,
  ): Promise<{ status: number; body: CommandResponse }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))
      throw new CommandValidationError('INVALID_REQUEST_ID', 'Use a unique UUID v4 request ID.');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(input) ?? 'undefined')
      .digest('hex');
    const previous = this.store.getRequest(requestId);
    if (previous) {
      const saved = JSON.parse(previous.result) as {
        fingerprint: string;
        status: number;
        body: CommandResponse;
      };
      if (previous.keyId !== keyId || saved.fingerprint !== fingerprint)
        throw new CommandValidationError(
          'REQUEST_CONFLICT',
          'This request ID has already been used.',
          409,
        );
      return { status: saved.status, body: saved.body };
    }
    this.store.reserve(
      'command-attempts',
      [
        { max: 20, windowMs: 60_000 },
        { max: 200, windowMs: 3_600_000 },
      ],
      this.now(),
    );
    if (this.busy)
      throw new CommandValidationError(
        'COMMAND_BUSY',
        'Another change is in progress. Refresh before trying again.',
        409,
      );
    this.busy = true;
    const save = (status: number, body: CommandResponse) => {
      this.store.saveRequest(requestId, keyId, { fingerprint, status, body });
      return { status, body };
    };
    let dispatched = false;
    try {
      save(202, {
        accepted: false,
        confirmed: false,
        outcomeUnknown: true,
        message:
          'This request is still pending, or the server restarted before its outcome was known. Refresh the thermostat; do not repeat it automatically.',
      });
      const initialClient = this.client();
      const generation = this.generation;
      const snapshot = await this.read(true);
      const command = validateCommand(input, snapshot, this.policy, this.now());
      if (!authorized())
        throw new CommandValidationError(
          'ACCESS_REVOKED',
          'Your access has expired or was revoked.',
          403,
        );
      const wait = this.cooldown();
      if (wait) throw new RateLimitError(wait);
      this.store.reserve(
        'google-commands',
        [
          { max: 5, windowMs: 60_000 },
          { max: 100, windowMs: 3_600_000 },
        ],
        this.now(),
      );
      const client = this.client();
      if (client !== initialClient)
        throw new CommandValidationError(
          'CONNECTION_CHANGED',
          'The owner changed the connection. Refresh before trying again.',
          409,
        );
      if (!client)
        throw new CommandValidationError(
          'NOT_CONNECTED',
          'Google Nest is no longer connected.',
          503,
        );
      dispatched = true;
      await client.execute(
        command,
        () => authorized() && generation === this.generation && this.client() === initialClient,
      );
      if (generation !== this.generation)
        return save(200, {
          accepted: true,
          confirmed: false,
          message:
            'Google accepted the change before the connection changed. Its result has not been confirmed; refresh the current thermostat.',
        });
      this.snapshot = undefined; // an old target must never masquerade as confirmation
      let readback: ThermostatSnapshot | undefined;
      try {
        readback = await this.read(true);
      } catch {
        /* Accepted does not mean read back. */
      }
      const confirmed = Boolean(readback && matches(command, readback));
      this.store.audit(
        keyId,
        'thermostat-command',
        confirmed ? 'confirmed' : 'accepted-unconfirmed',
      );
      return save(200, {
        accepted: true,
        confirmed,
        snapshot: readback,
        message: confirmed
          ? 'Change confirmed by the latest thermostat reading.'
          : 'Google accepted the request. Waiting for a matching thermostat reading; do not send it again.',
      });
    } catch (error) {
      this.catchQuota(error);
      const unknown = error instanceof GoogleApiError ? error.outcomeUnknown : dispatched;
      if (dispatched) {
        this.lastError = { message: 'Refresh the thermostat before another change.' };
      }
      const status =
        error instanceof CommandValidationError || error instanceof GoogleApiError
          ? error.status
          : error instanceof RateLimitError
            ? 429
            : 500;
      const message =
        error instanceof CommandValidationError ||
        error instanceof GoogleApiError ||
        error instanceof RateLimitError
          ? error.message
          : 'The request could not be completed. Refresh before trying again.';
      this.store.audit(keyId, 'thermostat-command', unknown ? 'outcome-unknown' : 'rejected');
      return save(status, {
        accepted: false,
        confirmed: false,
        outcomeUnknown: unknown,
        message,
        retryAfterSeconds:
          error instanceof RateLimitError
            ? error.retryAfterSeconds
            : error instanceof GoogleApiError
              ? error.retryAfterSeconds || undefined
              : undefined,
      });
    } finally {
      this.busy = false;
    }
  }
}
function matches(command: SdmCommand, state: ThermostatSnapshot): boolean {
  if (state.connection !== 'ONLINE') return false;
  const close = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.05;
  switch (command.command) {
    case 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat':
      return state.mode === 'HEAT' && close(state.heatCelsius, command.params.heatCelsius);
    case 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool':
      return state.mode === 'COOL' && close(state.coolCelsius, command.params.coolCelsius);
    case 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange':
      return (
        state.mode === 'HEATCOOL' &&
        close(state.heatCelsius, command.params.heatCelsius) &&
        close(state.coolCelsius, command.params.coolCelsius)
      );
    case 'sdm.devices.commands.ThermostatMode.SetMode':
      return state.mode === command.params.mode;
    case 'sdm.devices.commands.ThermostatEco.SetMode':
      return state.ecoMode === command.params.mode;
  }
}
