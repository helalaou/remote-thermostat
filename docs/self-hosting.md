# Self-hosting

You can try the app without a Google account connection or payment. Live control is an optional final step.

## 1. Run it locally

Install **Node.js 24** and npm, then run these commands from the repository root:

```sh
npm ci
cp .env.example .env
npm run check
npm start
```

Open <http://localhost:3000>. The app starts disconnected. Use **Try local demo** to explore sample controls: this changes only browser memory, never a thermostat. Keep the terminal running to serve the app.

Node runs this project's erasable TypeScript directly. There is no frontend build, bundler, CDN, or third-party browser script. `npm run check` remains necessary: Node's type stripping is not type checking.

## 2. Create your owner access key

In a second terminal, from the same directory and using the same `.env`:

```sh
npm run admin -- create-owner
```

Save the generated key in your password manager, then paste it into the app's sign-in form. It is shown only when created. It is **not your Google password**. There is no default password and the first visitor cannot become the owner.

The key is a bearer credential: anyone who possesses it has its role. Never put keys in URLs, screenshots, tickets, committed files, or public chat. Local terminal history can record commands; do not pass keys as command-line arguments. The app's key-creation command does not require a secret argument.

## 3. Choose where it will live

A small always-on Linux machine or container host is sufficient for one household. You are responsible for its operating system, backups, HTTPS, and availability. Hosting, a domain, or power may cost money separately from Google's registration fee.

For remote access, set an exact external origin in `.env`, for example:

```dotenv
APP_ORIGIN=https://thermostat.example.com
HOST=127.0.0.1
PORT=3000
DATA_DIR=./data
```

Terminate TLS at a reverse proxy on the same host. An example [Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy) site block is:

```caddyfile
thermostat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Replace the example hostname with your own, point DNS at your host, and configure the proxy according to its documentation. This repository does not install a proxy or configure DNS. Keep port 3000 private; expose only the HTTPS proxy. Do not disable origin/CSRF validation to fix a proxy misconfiguration. Avoid logging request bodies, cookies, `Authorization`, or OAuth callback query strings at the proxy.

HTTP is for loopback development only. Remote access must use HTTPS; secure session cookies depend on the configured origin. The app does not trust forwarded identity headers and does not provide an authentication bypass for a proxy.

### Docker alternative

Create `.env` as above, then:

```sh
docker compose up --build -d
docker compose exec app npm run admin -- create-owner
```

The Compose file exposes `127.0.0.1:3000`, not a public network interface. It runs as a non-root user with a persistent named volume at `/app/data`. Put your HTTPS proxy in front as above. Use the `exec` form after starting the service so the admin command shares the running app's data volume.

```sh
docker compose logs --tail=50 app
docker compose down
```

Do **not** add `--volumes` to `down` unless you intend to erase access keys, sessions, connection state, and history. The image contains no `.env` or database files; configuration is injected at runtime. Do not bake credentials into an image.

### Secret files for production

The app also accepts `TOKEN_ENCRYPTION_KEY_FILE` and `GOOGLE_CLIENT_SECRET_FILE`. Each names a readable file containing the secret value; a trailing newline is ignored. Do not set the matching direct environment variable at the same time. Keep these files outside your checkout and restrict their host permissions.

For a Compose deployment, an optional override can mount Docker secrets:

```yaml
services:
  app:
    environment:
      TOKEN_ENCRYPTION_KEY_FILE: /run/secrets/token_encryption_key
      GOOGLE_CLIENT_SECRET_FILE: /run/secrets/google_client_secret
    secrets:
      - token_encryption_key
      - google_client_secret
secrets:
  token_encryption_key:
    file: /absolute/private/path/token-encryption-key
  google_client_secret:
    file: /absolute/private/path/google-client-secret
```

Use real absolute paths on the host, and remove `TOKEN_ENCRYPTION_KEY` and `GOOGLE_CLIENT_SECRET` from `.env` if using this approach. Docker's [secret guidance](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/) explains why mounted secrets are preferable to inspectable environment values. Secret files still require a trusted host and administrator.

## 4. Give one guest access

After checking your deployment, create a separate key:

```sh
npm run admin -- create-guest "Guest"
```

For Docker, prefix the command with `docker compose exec app`.

Guest keys expire after 30 days by default. To choose a shorter period, pass `--days`, for example `npm run admin -- create-guest "Guest" --days 7`. Expiry invalidates access as well as sessions.

Share the app's URL and the guest key through a private, trusted channel—preferably separately. The recipient signs in with that key; they do **not** join your Google Home or need your Google credentials. The key label is an audit label, not independently verified identity. A copied key can be used by whoever holds it.

A guest can use all controls that this app exposes for its one configured thermostat. They cannot manage app access or connect a Google account. This is not per-button permission management.

To revoke access:

```sh
npm run admin -- list
npm run admin -- revoke KEY_ID
```

Use the non-secret ID shown by `list`, not the secret key. Revocation also invalidates that key's existing sessions. Create a new key rather than recycling a revoked one. Keep owner access separate from guest access; never share the owner key.

## 5. Set app temperature bounds

The default allowed target range is **10–30 °C**. Heat/cool mode also requires a minimum separation of **1.5 °C**. These are this app's conservative deployment settings, not values discovered from your equipment and not a claim about Google's full temperature range.

Review them for your home and equipment before live use. Set `TEMPERATURE_MIN_C`, `TEMPERATURE_MAX_C`, and optionally `TEMPERATURE_MIN_GAP_C` in `.env`, then restart. The config validator permits bounds only within 5–35 °C and a gap of at least 0.5 °C; it rejects inconsistent policies rather than guessing. Google's API may reject settings inside these bounds if the thermostat has additional constraints. The app does not silently broaden bounds or override Eco/mode to make a target work.

The UI can display °C or °F; commands use Celsius. Display units are a browser preference and do not change the physical thermostat's unit setting.

## 6. Connect Google only when ready

Follow [the optional Google setup guide](google-setup.md). Until that is complete, the app stays disconnected. The app's demo and automated tests do not require the registration fee.

## Operations

- Use one server process/container for this household. This release is not a distributed or multi-household hosting service.
- Monitor `/healthz` for process availability. A healthy process does not prove the thermostat is online or authorized.
- `data/` is private runtime state. Restrict directory permissions and never serve or commit it.
- Stop the app before copying its SQLite database, or use a SQLite-consistent backup procedure. Include related WAL files if needed; copying a live database file alone is not a reliable backup.
- Back up the token encryption key separately from the database. Without it, saved Google tokens cannot be recovered; reconnecting Google is the recovery path. Do not casually change the key with a connected database.
- Upgrade with `npm ci` using the checked-in lockfile, run tests, back up data, and restart. With Docker, rebuild the image while preserving the named volume.
- If the owner key is lost, use trusted local shell access: `npm run admin -- list`, revoke the old owner ID with `npm run admin -- revoke KEY_ID`, then run `npm run admin -- create-owner`. Owner creation refuses to run while an active owner key exists. Review any activity that happened while the key was exposed.
- Existing thermostat schedules and other integrations remain active. Local physical controls are the fallback if the app, host, network, or Google is unavailable.

See [SECURITY.md](../SECURITY.md) and [architecture](architecture.md) for the trust boundaries.
