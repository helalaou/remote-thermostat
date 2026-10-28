# Hosting

The app is one Node.js process with a SQLite file. It needs a server that stays on, has HTTPS and keeps a folder between restarts. GitHub Pages and other static hosts can't run it.

## Railway (about $5/month)

1. Push the repo to GitHub.
2. On [railway.com](https://railway.com): **New project → Deploy from GitHub repo**. It runs `npm start` (see `railway.json`).
3. **Settings → Networking → Generate Domain**. You get `https://<name>.up.railway.app`.
4. **Add a volume** mounted at `/data`. Without it, keys and the Google connection are lost on every deploy.
5. **Variables:**

   ```dotenv
   APP_ORIGIN=https://<name>.up.railway.app
   HOST=0.0.0.0
   DATA_DIR=/data
   TOKEN_ENCRYPTION_KEY=...
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_DEVICE_ACCESS_PROJECT_ID=...
   ```

6. Create the owner key with the [Railway CLI](https://docs.railway.com/guides/cli):

   ```sh
   railway link
   railway ssh -- npm run admin -- create-owner
   ```

7. Open the site, sign in, and [connect Google](google-setup.md).

Every push to GitHub redeploys.

## Any Linux server

Install Node 24, clone the repo, run `npm ci`, and fill in `.env` with your HTTPS `APP_ORIGIN` and a persistent `DATA_DIR`. Run `npm start` under systemd, and put [Caddy](https://caddyserver.com/docs/quick-starts/reverse-proxy) in front for HTTPS. Keep port 3000 private.

## Keys

Manage guests in the app under **Access**, or from the CLI (on Railway, prefix commands with `railway ssh --`):

```sh
npm run admin -- create-guest "Sam" --days 30
npm run admin -- list
npm run admin -- revoke KEY_ID
```

Lost the owner key? Revoke its ID with `list`/`revoke`, then run `create-owner` again.

## Settings

| Variable                                  | Default                |
| ----------------------------------------- | ---------------------- |
| `TEMPERATURE_MIN_C` / `TEMPERATURE_MAX_C` | 10 / 30 (allowed 5–35) |
| `TEMPERATURE_MIN_GAP_C` (heat/cool range) | 1.5                    |
| `GOOGLE_DEVICE_ID` (if you have several)  | auto                   |

Run one instance only. Back up `TOKEN_ENCRYPTION_KEY`.
