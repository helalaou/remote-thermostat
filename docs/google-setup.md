# Connect Google later

**First get the app running, try the demo, and create your owner login.** This guide is the optional final phase. You do not need to pay anything to build or test the app locally.

Google's console labels and requirements can change. The links below are the authority; this guide was checked on 2026-10-25. Do not paste credentials, authorization codes, refresh tokens, or access keys into chat or a GitHub issue.

## Before you begin

Have a working Nest thermostat linked to a consumer Google account. Legacy Nest-only accounts need migration; Google Workspace accounts cannot register for Device Access. Choose the correct account carefully because Google's Device Access project account cannot later be swapped. [Google prerequisites](https://developers.google.com/nest/device-access/get-started).

First confirm your model still has cloud support. Nest Learning Thermostat 1st gen, 2nd gen, and European 2nd gen lost connected features on October 25, 2025; this app cannot restore them. [Google end-of-support notice](https://support.google.com/googlehome/answer/16233096?hl=en).

For a remotely accessible app, finish [HTTPS deployment](self-hosting.md) first. You must be signed in to the app with an **owner** key for account linking. Guests do not perform this setup.

## 1. Understand the two projects

| Item                     | What it is                                     | App setting                                                      |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| Google Cloud project     | Holds the enabled SDM API and OAuth web client | No Cloud project ID setting                                      |
| OAuth client ID / secret | Identifies your web app to Google              | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                       |
| Device Access project    | Links that OAuth client to Nest access         | `GOOGLE_DEVICE_ACCESS_PROJECT_ID`                                |
| Device ID                | Identifies the one chosen thermostat           | `GOOGLE_DEVICE_ID`, optional for initial single-device discovery |

The Device Access project ID is **not** the Google Cloud project ID. Copy each value from the corresponding console. [Google project setup](https://developers.google.com/nest/device-access/get-started).

## 2. Prepare the Google Cloud OAuth client

In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable the **Smart Device Management API**. Configure the OAuth consent screen for your own app, then create an OAuth client with application type **Web application**. Google's [OAuth overview](https://developers.google.com/identity/protocols/oauth2) explains client types and consent.

Register this exact authorized redirect URI, replacing the origin with your `APP_ORIGIN`:

```text
https://thermostat.example.com/oauth/google/callback
```

For localhost-only development, use `http://localhost:3000/oauth/google/callback`. The scheme, host, port, and path must match; this app uses its own callback, not the `https://www.google.com` callback shown in Google's manual quick start.

Set the OAuth audience to **External**. While its publishing status is **Testing**, add the thermostat owner's account as a test user; testing refresh tokens can expire after seven days. For a long-lived personal deployment, change the OAuth publishing status to **In production** before reconnecting. This is an OAuth consent setting—not Device Access commercial approval. [Google token troubleshooting](https://developers.google.com/nest/device-access/reference/errors/authorization).

Google permits personal-use apps with fewer than 100 users to remain unverified, with an unverified-app warning. That exception is separate from the publishing status; do not assume a testing client becomes long-lived merely because verification is unnecessary. Review Google's current [verification exceptions](https://support.google.com/cloud/answer/13464323?hl=en) and policies for your use.

Record the OAuth client ID and secret privately. The secret belongs only in server configuration, never `public/`, source control, or browser JavaScript.

## 3. Now register for Device Access — the US$5 step

When you are ready, open the [Device Access Console](https://console.nest.google.com/). Google requires accepting its terms and paying a **one-time, non-refundable US$5 fee per account** before you can create a Device Access project. This is separate from hosting or domain costs. Review Google's current price and terms yourself before paying. [Official registration guide](https://developers.google.com/nest/device-access/get-started).

Create a Device Access project, supply the OAuth client ID from step 2, and copy its project ID. This app polls instead of using Pub/Sub, so events are not required. The paid registration and any Google consent remain actions for you to complete; the app does not purchase or register anything.

## 4. Configure your server

Stop the app. Generate an encryption key locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store that value in your private `.env` as `TOKEN_ENCRYPTION_KEY` (or use the [production secret-file options](self-hosting.md#secret-files-for-production)), along with:

```dotenv
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_DEVICE_ACCESS_PROJECT_ID=your-device-access-project-id
TOKEN_ENCRYPTION_KEY=your-generated-base64-key
```

These are placeholders, not working credentials. Protect `.env` with restricted file permissions, for example `chmod 600 .env` on Linux/macOS. Make an encrypted backup of the encryption key separately from the database. Changing or losing that key prevents decryption of saved Google tokens.

Leave `GOOGLE_DEVICE_ID` unset for initial discovery if you will authorize exactly one thermostat. If you already know the intended device ID, configure it explicitly. Restart the app after changing settings.

## 5. Authorize just the thermostat

Sign in as the owner and open the connection panel. Choose **Connect Google**. You will be sent to Google's Partner Connections Manager; sign in with the thermostat's Google account and review the permissions.

Authorize only the intended home/thermostat. Do not enable other devices unnecessarily. A Google **unverified OAuth app** warning can be expected for the personal project you created; verify its name and requested permission before continuing. This is not permission to bypass browser certificate, phishing, or malware warnings—stop for those, or for any unknown app. The requested `sdm.service` scope is for SDM device access, not your entire Google account. [Google's account-linking flow](https://developers.google.com/nest/device-access/authorize).

On return, the server exchanges the authorization code and makes Google's required initial `devices.list` call. It locks the app to the configured matching thermostat, or to the sole authorized thermostat when no device ID was supplied. If multiple thermostats are returned without a configured choice, setup stops: select a single thermostat in Google's consent flow or configure its ID, then reconnect. There is no guest-facing device picker and no arbitrary device proxy.

The refresh token is encrypted on the server; no Google token is sent to the guest's browser. The callback is single-use and tied to the owner's linking session. Google's initial list call is required to complete authorization. [Google authorization completion](https://developers.google.com/nest/device-access/authorize#make_a_device_list_call).

## 6. Verify before sharing

1. Confirm the app reports a fresh, online thermostat—not demo mode.
2. Compare the displayed current mode and temperature with the physical thermostat or official app.
3. Review the app's temperature bounds for your home and equipment.
4. Make one small, appropriate change while you can check the physical thermostat. Wait for read-back confirmation; an accepted API request alone is not proof the hardware applied it.
5. Verify Off/Eco/fan only if supported and appropriate. Do not interrupt heating/cooling just to exercise every button.
6. Create and share a separate guest key. Revoke a temporary test key and verify its session no longer works.

Live account linking and hardware behavior have **not** been validated merely because this repository's offline tests pass.

## Common setup problems

| Symptom                              | What to check                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redirect URI mismatch                | OAuth web-client callback must exactly match `APP_ORIGIN` plus `/oauth/google/callback`.                                                                                                     |
| Access denied during consent         | Correct Google account and, while testing, membership in the OAuth client's test users.                                                                                                      |
| Tokens stop working after a week     | OAuth consent publishing/testing state; review Google's [refresh-token guidance](https://developers.google.com/identity/protocols/oauth2#expiration). Reconnect only after fixing the cause. |
| No thermostat / multiple thermostats | Grant only the intended device, or set the correct fixed device ID before reconnecting.                                                                                                      |
| Stale data or quota warning          | Wait for the retry time. Other integrations share the same thermostat command quota. Do not repeatedly click Apply.                                                                          |
| Target rejected in Eco or Off        | Choose a supported standard mode or leave Eco explicitly first, then refresh and set the target. The app will not do this silently.                                                          |
| App works, device does not respond   | Check internet, power, Google connectivity, and the physical thermostat. `/healthz` checks the server only.                                                                                  |

To withdraw Google's authorization, revoke the app's grant in Google's Partner Connections Manager/account permissions. Stop the app while investigating a compromised grant. Removing an app login key only revokes access to this app; it does not revoke the Google grant. This release does not yet provide an in-app Google disconnect control.

Open-sourcing this code does not authorize operating a public multi-user Google integration. Every self-hosting operator must follow Google's applicable policies and terms for their use.
