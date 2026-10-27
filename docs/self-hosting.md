# Hosting

The app is one Node.js process with a SQLite file. It needs a server that stays on, gives it HTTPS, and keeps one folder between restarts. Static hosts like GitHub Pages can't run it.

## Run locally

```sh
npm ci
cp .env.example .env
npm start
```

Open <http://localhost:3000>.

## Deploy on Railway (recommended, ~$5/month)

Railway builds straight from your GitHub repo. No Docker or server setup.

1. Push this repo to GitHub (private is fine).
2. On [railway.com](https://railway.com), create a project → **Deploy from GitHub repo** → pick the repo. It detects Node from `package.json` and runs `npm start` (see `railway.json`).
3. In the service, **Settings → Networking → Generate Domain**. You get `https://<name>.up.railway.app`.
4. **Add a volume** to the service, mounted at `/data`. This holds the database; without it, keys and the Google connection are lost on every deploy.
5. **Variables** — add:

   ```dotenv
   APP_ORIGIN=https://<name>.up.railway.app
   HOST=0.0.0.0
   DATA_DIR=/data
   TOKEN_ENCRYPTION_KEY=...
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_DEVICE_ACCESS_PROJECT_ID=...
   ```

   Railway sets `PORT` itself. Copy the secret values from your private `.env`; don't commit them.

6. Add `https://<name>.up.railway.app/oauth/google/callback` as an authorized redirect URI on your Google OAuth client.
7. Create the owner key on the server with the [Railway CLI](https://docs.railway.com/guides/cli):

   ```sh
   railway link
   railway ssh -- npm run admin -- create-owner
   ```

   Save the key it prints. Then open the site, sign in, and click **Connect Google Nest** (see [google-setup.md](google-setup.md)).

Every push to the GitHub branch redeploys automatically.

## Any other Linux server

Install Node.js 24, clone the repo, `npm ci`, fill in `.env` (`APP_ORIGIN=https://your-domain`, `DATA_DIR` on persistent disk), run `npm start` under a process manager (e.g. systemd), and put an HTTPS proxy like [Caddy](https://caddyserver.com/docs/quick-starts/reverse-proxy) in front. Keep port 3000 private.

## Guest keys

Add and revoke guests in the app (**Access**, owner only), or with the CLI (prefix with `railway ssh --` on Railway):

```sh
npm run admin -- create-guest "Sam" --days 30
npm run admin -- list
npm run admin -- revoke KEY_ID
```

Send the link and the key separately and privately. A guest gets only this thermostat — no Google account access. Revoking a key ends its sessions immediately. Choose which modes and Eco guests can use in **Settings → Guests can use**.

## Temperature bounds

Default allowed targets are 10–30 °C with 1.5 °C between heat and cool. Change with `TEMPERATURE_MIN_C`, `TEMPERATURE_MAX_C`, `TEMPERATURE_MIN_GAP_C` (allowed 5–35 °C).

## Keep in mind

- Run one instance only (one SQLite file).
- Back up `TOKEN_ENCRYPTION_KEY` somewhere private. If it's lost, reconnect Google.
- Lost owner key: `npm run admin -- list`, `npm run admin -- revoke OWNER_ID`, then `npm run admin -- create-owner`.
- `/healthz` only shows the server is up, not that the thermostat is online.
- The physical thermostat, schedules and other apps still work and can override changes.
