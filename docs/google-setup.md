# Connect your Nest thermostat

You need a Nest thermostat on a personal Google account (not Workspace). Nest Learning Thermostat 1st/2nd gen no longer work with Google's API ([notice](https://support.google.com/googlehome/answer/16233096)).

Never paste these credentials into chat, issues or git.

## 1. Google Cloud: OAuth client (free)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Smart Device Management API**.
2. Set up the **OAuth consent screen**: audience **External**, and add your Google account as a test user.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**. Add these redirect URIs:
   - `http://localhost:3000/oauth/google/callback`
   - `https://<your-app>.up.railway.app/oauth/google/callback`
4. Copy the client ID and secret.
5. Set publishing status to **In production**. While it's in Testing, Google's tokens expire after 7 days. You'll see an "unverified app" warning for your own app; that's expected.

## 2. Device Access: US$5, one time

1. In the [Device Access Console](https://console.nest.google.com/), accept the terms and pay Google's US$5 fee.
2. Create a project and paste in the OAuth client ID. You don't need events or Pub/Sub.
3. Copy the **Device Access project ID**. It's different from the Cloud project ID.

## 3. Configure the app

Set these locally in `.env`, or in Railway → Variables:

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_DEVICE_ACCESS_PROJECT_ID=...
TOKEN_ENCRYPTION_KEY=...   # node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Back up `TOKEN_ENCRYPTION_KEY`. If you lose it, you'll have to connect Google again. Restart the app after changing settings.

## 4. Connect

1. Sign in as owner and click **Connect Google Nest**.
2. On Google's screen, select **only the thermostat**. Leave cameras, doorbells and everything else unchecked.
3. You'll be sent back to the app, now locked to that thermostat.

If you have several thermostats, select just one. Or set `GOOGLE_DEVICE_ID` and reconnect.

## 5. Check it, then share

1. Compare the app's reading with the real thermostat.
2. Make one small change and confirm the thermostat follows it.
3. Add your guest under **Access**, choose their modes in **Settings → Guests can use**, and send them the link and key separately.

To withdraw Google access entirely, remove the app at [Google Partner Connections](https://nestservices.google.com/partnerconnections).

## Problems

| Symptom                    | Fix                                                                       |
| -------------------------- | ------------------------------------------------------------------------- |
| `redirect_uri_mismatch`    | The redirect URI must be exactly `APP_ORIGIN` + `/oauth/google/callback`. |
| Access denied              | Use the right Google account, and add it as a test user.                  |
| Stops working after 7 days | Set the OAuth app to **In production**, then reconnect.                   |
| "Too many requests"        | Wait. Google's command limit is shared with other apps.                   |
| Target rejected            | Turn off Eco or pick Heat/Cool first.                                     |
