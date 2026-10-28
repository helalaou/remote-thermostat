# Remote Thermostat

Control your Nest thermostat from a web page, and give other people their own key to it. They can't reach your Google account or your other devices.

- Mode, target temperature, heat/cool range, Eco
- Owner adds and revokes guest keys, and picks which modes guests can use
- Light/dark theme, °C/°F, works on phones
- Node.js 24, Hono, SQLite. No build step.

## Run

```sh
npm ci
cp .env.example .env
npm start
```

Open <http://localhost:3000> and click **Try demo**.

Create the owner key (it's shown only once):

```sh
npm run admin -- create-owner
```

## Connect and host

1. [Connect your thermostat](docs/google-setup.md). Needs Google's one-time US$5 Device Access fee.
2. [Host it online](docs/self-hosting.md). Railway, about $5/month.

## Limits

- Only what Google's API allows: no schedules or fan.
- Google allows 5 commands a minute and 100 an hour across all apps.
- The thermostat itself, schedules and other apps can still change the temperature.

## Develop

```sh
npm run dev     # restart on changes
npm run check   # types + tests
```

[Architecture](docs/architecture.md) · [Security](SECURITY.md) · MIT
