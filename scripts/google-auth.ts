// One-time setup: sign in to Google, pick the thermostat, and save
// GOOGLE_REFRESH_TOKEN and GOOGLE_DEVICE_ID into .env. Run with: npm run google-auth
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { TOKEN_URL } from '../src/google/connection.ts';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DEVICE_ACCESS_PROJECT_ID } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_DEVICE_ACCESS_PROJECT_ID) {
  console.error(
    'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_DEVICE_ACCESS_PROJECT_ID in .env first.',
  );
  process.exit(1);
}

const PORT = 3000;
const redirectUri = `http://localhost:${PORT}/oauth/google/callback`;
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('base64url');
const authUrl = new URL(
  `https://nestservices.google.com/partnerconnections/${GOOGLE_DEVICE_ACCESS_PROJECT_ID}/auth`,
);
authUrl.search = new URLSearchParams({
  client_id: GOOGLE_CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/sdm.service',
  access_type: 'offline',
  prompt: 'consent',
  state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
}).toString();

async function finish(code: string) {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
    }),
  });
  const tokens = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string };
  if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token)
    throw new Error('Google did not return a refresh token. Run the script again.');

  // Google requires this first device list to finish linking.
  const devicesResponse = await fetch(
    `https://smartdevicemanagement.googleapis.com/v1/enterprises/${GOOGLE_DEVICE_ACCESS_PROJECT_ID}/devices`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  const { devices = [] } = (await devicesResponse.json()) as {
    devices?: { name: string; type: string }[];
  };
  const thermostats = devices.filter((device) => device.type === 'sdm.devices.types.THERMOSTAT');
  const wanted = process.env.GOOGLE_DEVICE_ID;
  const chosen = wanted
    ? thermostats.find((device) => device.name.endsWith(`/devices/${wanted}`))
    : thermostats.length === 1
      ? thermostats[0]
      : undefined;
  if (!chosen)
    throw new Error(
      thermostats.length
        ? `Found ${thermostats.length} thermostats. Select only one on Google's screen, or set GOOGLE_DEVICE_ID.`
        : 'No thermostat was shared. Run again and select your thermostat.',
    );
  saveEnv({
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
    GOOGLE_DEVICE_ID: chosen.name.split('/').pop()!,
  });
}

function saveEnv(values: Record<string, string>) {
  let env = readFileSync('.env', 'utf8');
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^#?\\s*${name}=.*$`, 'm');
    env = pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`;
  }
  writeFileSync('.env', env, { mode: 0o600 });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', redirectUri);
  if (url.pathname !== '/oauth/google/callback') {
    response.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  try {
    if (url.searchParams.get('state') !== state || !code)
      throw new Error('Google sign-in was cancelled or did not match. Run the script again.');
    await finish(code);
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Done. You can close this tab.');
    console.log(
      'Saved GOOGLE_REFRESH_TOKEN and GOOGLE_DEVICE_ID to .env. Copy both to Netlify too.',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Setup failed.';
    response.writeHead(400, { 'Content-Type': 'text/plain' }).end(message);
    console.error(message);
    process.exitCode = 1;
  }
  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Opening Google. Select only your thermostat.\nIf nothing opens, visit:');
  console.log(authUrl.href);
  execFile('open', [authUrl.href], () => {});
});
