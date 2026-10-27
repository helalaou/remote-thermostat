import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';
import { googleConfigured } from '../config.ts';
import { decryptSecret, encryptSecret, randomToken } from '../crypto.ts';
import { Store } from '../store.ts';
import { GoogleApiError } from './sdm.ts';
import { isDeviceResource } from '../domain/thermostat.ts';

const SCOPE = 'https://www.googleapis.com/auth/sdm.service';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

/** Owner Nest authorization is separate from guest app logins. */
export class GoogleConnection {
  config: Config;
  store: Store;
  fetcher: typeof fetch;
  generation = 0;
  cached?: { token: string; expiresAt: number };
  refreshing?: Promise<string>;
  constructor(config: Config, store: Store, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.store = store;
    this.fetcher = fetcher;
  }
  get resource(): string | undefined {
    const resource = this.store.get('google-device-resource');
    if (!resource || !isDeviceResource(resource)) return undefined;
    const prefix = `enterprises/${this.config.googleProjectId}/devices/`;
    if (!resource.startsWith(prefix)) return undefined;
    if (this.config.googleDeviceId && resource !== prefix + this.config.googleDeviceId)
      return undefined;
    return resource;
  }
  get connected(): boolean {
    return (
      googleConfigured(this.config) && Boolean(this.resource && this.store.get('google-refresh'))
    );
  }
  async authorizationUrl(sessionHash: string): Promise<string> {
    if (!googleConfigured(this.config))
      throw new Error('Google connection is not configured. Follow the owner setup guide.');
    const verifier = randomToken();
    const state = this.store.createOAuthState(
      sessionHash,
      encryptSecret(verifier, this.config.encryptionKey!, 'oauth-verifier'),
    );
    const url = new URL(
      `https://nestservices.google.com/partnerconnections/${this.config.googleProjectId}/auth`,
    );
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId!,
      redirect_uri: this.config.origin + '/oauth/google/callback',
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return url.href;
  }
  async complete(
    code: string,
    state: string,
    sessionHash: string,
    authorized: () => boolean = () => true,
  ): Promise<void> {
    if (!googleConfigured(this.config)) throw new Error('Google is not configured.');
    const encrypted = this.store.consumeOAuthState(state, sessionHash);
    if (!encrypted)
      throw new Error(
        'This Google connection request expired or was already used. Start again from the owner panel.',
      );
    const verifier = decryptSecret(encrypted, this.config.encryptionKey!, 'oauth-verifier');
    const tokens = await this.tokenRequest({
      code,
      code_verifier: verifier,
      redirect_uri: this.config.origin + '/oauth/google/callback',
      grant_type: 'authorization_code',
    });
    if (!tokens.refresh_token)
      throw new Error(
        'Google did not provide offline access. Restart the connection and approve the requested access.',
      );
    // A first devices.list completes SDM authorization. Select exactly one verified thermostat.
    const response = await this.fetcher(
      `https://smartdevicemanagement.googleapis.com/v1/enterprises/${this.config.googleProjectId}/devices`,
      {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(
        'Google device discovery failed. Check Device Access permissions and try again.',
      );
    const raw = (await response.json()) as { devices?: unknown };
    if (!Array.isArray(raw.devices)) throw new Error('No authorized thermostat was returned.');
    const prefix = `enterprises/${this.config.googleProjectId}/devices/`;
    const choices = raw.devices.filter(
      (item): item is { name: string; type: string } =>
        item &&
        typeof item === 'object' &&
        item.type === 'sdm.devices.types.THERMOSTAT' &&
        isDeviceResource(item.name) &&
        item.name.startsWith(prefix),
    );
    const selected = this.config.googleDeviceId
      ? choices.find((item) => item.name === prefix + this.config.googleDeviceId)
      : choices.length === 1
        ? choices[0]
        : undefined;
    if (!selected)
      throw new Error(
        'Authorize exactly one thermostat, or configure GOOGLE_DEVICE_ID to select one of the authorized thermostats.',
      );
    if (!authorized()) throw new Error('Owner access expired or was revoked during connection.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.set(
        'google-refresh',
        encryptSecret(tokens.refresh_token, this.config.encryptionKey!, 'google-refresh'),
      );
      this.store.set('google-device-resource', selected.name);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.generation++;
    this.cached = {
      token: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
    };
  }
  async accessToken(): Promise<string> {
    if (!this.connected) throw new Error('Google Nest is not connected.');
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async refresh(): Promise<string> {
    const generation = this.generation;
    const refresh = decryptSecret(
      this.store.get('google-refresh')!,
      this.config.encryptionKey!,
      'google-refresh',
    );
    const tokens = await this.tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' });
    if (generation !== this.generation)
      throw new Error('The Google connection changed during token refresh.');
    if (tokens.refresh_token)
      this.store.set(
        'google-refresh',
        encryptSecret(tokens.refresh_token, this.config.encryptionKey!, 'google-refresh'),
      );
    this.cached = {
      token: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
    };
    return tokens.access_token;
  }
  private async tokenRequest(parameters: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          ...parameters,
          client_id: this.config.googleClientId!,
          client_secret: this.config.googleClientSecret!,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GoogleApiError(
        'GOOGLE_UNAVAILABLE',
        'Google authorization could not be reached. Try connecting again.',
      );
    }
    if (!response.ok)
      throw new GoogleApiError(
        'REAUTH_REQUIRED',
        'Google authorization failed. The owner may need to reconnect Nest.',
      );
    const raw = (await response.json()) as Partial<TokenResponse>;
    if (
      typeof raw.access_token !== 'string' ||
      /[\r\n]/.test(raw.access_token) ||
      typeof raw.expires_in !== 'number' ||
      !Number.isFinite(raw.expires_in) ||
      raw.expires_in <= 0 ||
      (raw.refresh_token !== undefined && typeof raw.refresh_token !== 'string')
    )
      throw new Error('Google returned an invalid token response.');
    return raw as TokenResponse;
  }
}
