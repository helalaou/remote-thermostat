import type { Config } from '../config.ts';
import { googleConfigured } from '../config.ts';
import { GoogleApiError } from './sdm.ts';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Turns the refresh token from the environment into short-lived access tokens. */
export class GoogleConnection {
  config: Config;
  fetcher: typeof fetch;
  cached?: { token: string; expiresAt: number };
  refreshing?: Promise<string>;
  constructor(config: Config, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  get connected(): boolean {
    return googleConfigured(this.config);
  }
  get resource(): string | undefined {
    if (!this.connected) return undefined;
    return `enterprises/${this.config.googleProjectId}/devices/${this.config.googleDeviceId}`;
  }
  async accessToken(): Promise<string> {
    if (!this.connected) throw new Error('Google Nest is not connected.');
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.config.googleRefreshToken!,
          client_id: this.config.googleClientId!,
          client_secret: this.config.googleClientSecret!,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GoogleApiError('GOOGLE_UNAVAILABLE', 'Google could not be reached. Try again.');
    }
    if (!response.ok)
      throw new GoogleApiError(
        'REAUTH_REQUIRED',
        'Google sign-in expired. The admin needs to run npm run google-auth again.',
      );
    const raw = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (
      typeof raw.access_token !== 'string' ||
      /[\r\n]/.test(raw.access_token) ||
      typeof raw.expires_in !== 'number' ||
      !(raw.expires_in > 0)
    )
      throw new Error('Google returned an invalid token response.');
    this.cached = {
      token: raw.access_token,
      expiresAt: Date.now() + raw.expires_in * 1000 - 60_000,
    };
    return raw.access_token;
  }
}
