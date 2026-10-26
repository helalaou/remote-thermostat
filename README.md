# Neighbor Thermostat

**Share one Nest thermostat, not your Google Home.** A small, mobile-friendly web app you can run yourself.

## Why

Sometimes a neighbor, guest, or family member needs to adjust the temperature—not join your entire smart home. This app puts one thermostat behind a separate, revocable access key. Your Google account stays on the server.

Start with the local demo. Connect a real thermostat later, when you have time. There is no payment or Google account connection required to explore the app.

## Features

- A lightweight, phone-first interface with large controls and °C/°F display.
- Heating and cooling targets, heat/cool range, supported modes, Off, Eco, and a fan timer **when your thermostat exposes them**.
- Automatic refresh while the page is visible, a shared server cache, and clear stale/offline states.
- Separate owner and neighbor access keys, expiring neighbor access, server-side sessions, and immediate revocation.
- One fixed thermostat, fresh checks before commands, conservative target bounds, and command throttling.
- Vanilla browser code, a small Node.js server, SQLite, and optional Docker. No frontend build or third-party browser scripts.

This is a personal, single-household tool—not a Google Home replacement or a multi-tenant service. See [architecture](docs/architecture.md) and [security](SECURITY.md).

## Hardware and verification

Use a Nest model with current Google cloud support. **Nest Learning Thermostat 1st gen, 2nd gen, and European 2nd gen are excluded:** Google ended their connected features on October 25, 2025. Check your exact model against [Google's support notice](https://support.google.com/googlehome/answer/16233096?hl=en), even though the generic SDM page still says all models.

Available controls depend on the device's returned capabilities. **This project's real-hardware validation is still pending.** Automated tests and the demo use simulated responses; they do not prove a live Google account or HVAC system works.

## Quick start — no Google setup yet

Requires **Node.js 24** and npm.

### 1. Install and check

```sh
npm ci
cp .env.example .env
npm run check
```

### 2. Start

```sh
npm start
```

Open <http://localhost:3000> and choose **Try local demo**. Demo changes stay in your browser and cannot control a device.

### 3. Create your own login

In another terminal, in this same directory:

```sh
npm run admin -- create-owner
```

Save the generated key in your password manager and paste it into the sign-in form. No default owner key is shipped. Never put access keys in URLs or commit them.

### 4. Deploy and share when ready

Follow [self-hosting](docs/self-hosting.md) for HTTPS, Docker, temperature bounds, backups, and neighbor keys. A neighbor receives a separate key—not your Google credentials or Google Home membership.

```sh
npm run admin -- create-neighbor "Neighbor"
npm run admin -- list
npm run admin -- revoke KEY_ID
```

Neighbor keys expire after 30 days by default. Revoking a key invalidates its sessions as well. See the guide before creating or sharing live access.

## Limits worth knowing

- Only controls available through Google's official SDM API are exposed. No schedules, thermostat lock/PIN, learning preferences, or editing Eco temperatures. A fan control appears only if the fan trait exists.
- Existing schedules, physical controls, and other integrations can still change the thermostat. This app is not a permanent temperature hold.
- Google limits thermostat commands across integrations to **5 per minute and 100 per hour**. The app throttles its own commands, but cannot see every other integration's usage. [Google rate-limit documentation](https://developers.google.com/nest/device-access/project/limits).
- The default 10–30 °C target bounds are **app settings**, not a promise about your equipment's supported range. Review them before connecting.
- Keep the physical thermostat available as a fallback. This is not a safety or emergency-control system.

## Development and contributions

```sh
npm run dev       # Watch the server
npm run check     # TypeScript + automated tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Use small, reviewable commits and include regression tests for behavior changes. Do not include real device IDs, credentials, or household data in fixtures or issues.

Built with Node.js, Hono, and SQLite; integrated with Google's official Smart Device Management API. This project is independent and is not affiliated with or endorsed by Google or Nest.

[MIT licensed](LICENSE), copyright 2026 Hamza El Alaoui.

## Last step, later: Google's one-time US$5 setup

Only do this when you are ready to connect real hardware. Google charges a **one-time, non-refundable US$5 Device Access registration fee per account**; it is paid to Google, not this app. Hosting costs are separate. [Google's registration requirements](https://developers.google.com/nest/device-access/get-started).

The [step-by-step Google setup guide](docs/google-setup.md) explains the two projects, OAuth credentials, the fee, and connecting just one thermostat. Nothing in this repository pays the fee, creates a Google project, or grants access automatically.
