import { serve } from '@hono/node-server';
import { Hono } from 'hono';
const app = new Hono();
app.get('/healthz', (c) => c.json({ status: 'ok', connected: false }));
app.get('/', (c) => c.text('Neighbor Thermostat — not connected.'));
serve({ fetch: app.fetch, port: Number(process.env.PORT || 3000), hostname: process.env.HOST || '127.0.0.1' });
