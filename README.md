# Remote Thermostat

Control your Nest thermostat from a web page, and let one other person control it with a simple code. They never get your Google account or your other devices.

- **Admin code** (yours): full control, plus an admin panel to choose what the user can do
- **User code** (theirs): only the modes, Eco and temperature range you allow; you can switch it off anytime
- Mode, target temperature, heat/cool range, Eco · light/dark · °C/°F · works on phones
- Free hosting on Netlify, no database. Settings live in environment variables.

## Run locally

```sh
npm ci
cp .env.example .env    # set ADMIN_CODE and USER_CODE
npm start
```

Open <http://localhost:3000>. **Try demo** works without signing in.

## Set it up for real

1. [Connect your thermostat](docs/google-setup.md). Needs Google's one-time US$5 Device Access fee.
2. [Put it on Netlify](docs/hosting.md) (free).

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
