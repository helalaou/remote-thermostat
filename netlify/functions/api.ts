import { getStore } from '@netlify/blobs';
import { createApp } from '../../src/app.ts';
import { readConfig } from '../../src/config.ts';
import type { AccessStore } from '../../src/controls.ts';

// User access lives in Netlify Blobs; everything else comes from environment variables.
const blobs = () => getStore('remote-thermostat');
const access: AccessStore = {
  get: () => blobs().get('user-access', { type: 'json', consistency: 'strong' }),
  set: async (value) => {
    await blobs().setJSON('user-access', value);
  },
};
const app = createApp({ config: readConfig(), access });

export default (request: Request) => app.fetch(request);
export const config = { path: ['/api/*', '/healthz'] };
