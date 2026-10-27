# Remote Thermostat

Control one Nest thermostat from a web page, and give other people their own revocable key to it. Your Google account stays on the server.

Node.js 24, Hono, SQLite. No frontend build.

## Run it

```sh
npm ci
cp .env.example .env
npm start
```

Open <http://localhost:3000>. Click **Try demo** to use it with sample data — nothing is sent anywhere.

## Sign in

Create the owner key (shown once — save it):

```sh
npm run admin -- create-owner
```

Paste it into **Sign in**. As owner you can add and revoke guest keys from the **Access** section, or from the CLI:

```sh
npm run admin -- create-guest "Sam" --days 30
npm run admin -- list
npm run admin -- revoke KEY_ID
```

Guest keys expire (default 30 days). Revoking a key ends its sessions immediately.

## Connect a real thermostat

Needs a Google Device Access account (one-time US$5 fee paid to Google). Steps: [docs/google-setup.md](docs/google-setup.md). Hosting it online (Railway, ~$5/month): [docs/self-hosting.md](docs/self-hosting.md).

Nest Learning Thermostat 1st/2nd gen no longer work with Google's API.

## Limits

- Only what Google's SDM API exposes: mode, target temperature, heat/cool range, Eco on/off. No schedules or fan control.
- Google allows 5 commands/minute and 100/hour across all apps.
- Default target bounds are 10–30 °C (`TEMPERATURE_MIN_C` / `TEMPERATURE_MAX_C`).
- Schedules, the physical thermostat and other apps can still change the temperature.

## Development

```sh
npm run dev     # watch mode
npm run check   # typecheck + tests
```

More: [architecture](docs/architecture.md), [security](SECURITY.md), [contributing](CONTRIBUTING.md). MIT licensed.
