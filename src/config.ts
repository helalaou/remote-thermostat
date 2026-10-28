import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export interface Config {
  origin: string;
  secureCookies: boolean;
  host: string;
  port: number;
  dataDir: string;
  adminCode?: string;
  userCode?: string;
  sessionSecret: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleProjectId?: string;
  googleRefreshToken?: string;
  googleDeviceId?: string;
  minCelsius: number;
  maxCelsius: number;
  minRangeGapCelsius: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Netlify sets URL to the site's address.
  const url = new URL(env.APP_ORIGIN || env.URL || 'http://localhost:3000');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  )
    throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP is allowed only on localhost).');

  const number = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
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
  )
    throw new Error('Use temperature bounds within 5–35 °C and a positive range gap.');
  const port = number('PORT', 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid.');

  const adminCode = env.ADMIN_CODE?.trim() || undefined;
  const userCode = env.USER_CODE?.trim() || undefined;
  if (adminCode && adminCode.length < 12)
    throw new Error('ADMIN_CODE must be at least 12 characters.');
  if (adminCode && adminCode === userCode)
    throw new Error('ADMIN_CODE and USER_CODE must be different.');
  if (userCode && !adminCode) throw new Error('Set ADMIN_CODE before USER_CODE.');
  for (const name of ['GOOGLE_DEVICE_ACCESS_PROJECT_ID', 'GOOGLE_DEVICE_ID'])
    if (env[name] && !/^[A-Za-z0-9_-]+$/.test(env[name]!))
      throw new Error(`${name} contains invalid characters.`);

  return {
    origin: url.origin,
    secureCookies: url.protocol === 'https:',
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: resolve(env.DATA_DIR || './data'),
    adminCode,
    userCode,
    // The admin code is long and private, so it doubles as the cookie-signing secret.
    // Changing it signs everyone out.
    sessionSecret: createHash('sha256')
      .update(`session:${adminCode ?? ''}`)
      .digest('base64url'),
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    googleProjectId: env.GOOGLE_DEVICE_ACCESS_PROJECT_ID,
    googleRefreshToken: env.GOOGLE_REFRESH_TOKEN,
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
    config.googleRefreshToken &&
    config.googleDeviceId,
  );
}
