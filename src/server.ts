// Local server: the API plus the files in public/. Netlify uses netlify/functions/api.ts instead.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readConfig } from './config.ts';
import { createApp } from './app.ts';
import { fileAccessStore } from './controls.ts';

const config = readConfig();
const api = createApp({ config, access: fileAccessStore(config.dataDir) });
const app = new Hono();
app.use('/*', serveStatic({ root: './public' }));
app.route('/', api);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  console.log(`Remote Thermostat running at ${config.origin}`);
  if (!config.adminCode) console.log('Set ADMIN_CODE in .env to sign in.');
});
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
