import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export interface Config {
  origin: string;
  secureCookies: boolean;
  host: string;
  port: number;
  dataDir: string;
  encryptionKey?: Buffer;
  googleClientId?: string;
  googleClientSecret?: string;
  googleProjectId?: string;
  googleDeviceId?: string;
  minCelsius: number;
  maxCelsius: number;
  minRangeGapCelsius: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = new URL(env.APP_ORIGIN || 'http://localhost:3000');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  ) {
    throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
    return value;
  };
  const minCelsius = number('TEMPERATURE_MIN_C', 10);
  const maxCelsius = number('TEMPERATURE_MAX_C', 30);
  const minRangeGapCelsius = number('TEMPERATURE_MIN_GAP_C', 1.5);
  if (
    minCelsius < 5 ||
    maxCelsius > 35 ||
    minCelsius >= maxCelsius ||
    minRangeGapCelsius < 0.5 ||
    minRangeGapCelsius > maxCelsius - minCelsius
  ) {
    throw new Error('Invalid temperature policy. Use 5–35 C bounds and a positive range gap.');
  }
  const port = number('PORT', 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid.');
  const secret = (name: string): string | undefined => {
    if (env[name] && env[`${name}_FILE`])
      throw new Error(`Set either ${name} or ${name}_FILE, not both.`);
    return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : env[name];
  };
  const keyValue = secret('TOKEN_ENCRYPTION_KEY');
  let encryptionKey: Buffer | undefined;
  if (keyValue) {
    encryptionKey = Buffer.from(keyValue, 'base64');
    if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== keyValue) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 32 bytes in canonical base64.');
    }
  }
  for (const name of ['GOOGLE_DEVICE_ACCESS_PROJECT_ID', 'GOOGLE_DEVICE_ID']) {
    if (env[name] && !/^[A-Za-z0-9_-]+$/.test(env[name]!))
      throw new Error(`${name} contains invalid characters.`);
  }
  return {
    origin: url.origin,
    secureCookies: url.protocol === 'https:',
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: resolve(env.DATA_DIR || './data'),
    encryptionKey,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: secret('GOOGLE_CLIENT_SECRET'),
    googleProjectId: env.GOOGLE_DEVICE_ACCESS_PROJECT_ID,
    googleDeviceId: env.GOOGLE_DEVICE_ID,
    minCelsius,
    maxCelsius,
    minRangeGapCelsius,
  };
}
export function googleConfigured(config: Config): boolean {
  return Boolean(
    config.googleClientId &&
    config.googleClientSecret &&
    config.googleProjectId &&
    config.encryptionKey,
  );
}
