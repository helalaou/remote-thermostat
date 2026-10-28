# Connect your Nest thermostat

You need a Nest thermostat on a personal Google account (not Workspace). Nest Learning Thermostat 1st/2nd gen no longer work with Google's API ([notice](https://support.google.com/googlehome/answer/16233096)).

Never paste these values into chat, issues or git. They go only in `.env` and in Netlify.

## 1. Google Cloud: OAuth client (free)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Smart Device Management API**.
2. Set up the **OAuth consent screen**: audience **External**, and add your Google account as a test user.
3. **Credentials → Create credentials → OAuth client ID → Web application.** Add this redirect URI: `http://localhost:3000/oauth/google/callback`
4. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Set publishing status to **In production**. While it's in Testing, Google's tokens expire after 7 days. You'll see an "unverified app" warning for your own app; that's expected.

## 2. Device Access: US$5, one time

1. In the [Device Access Console](https://console.nest.google.com/), accept the terms and pay Google's US$5 fee.
2. Create a project and paste in the OAuth client ID. You don't need events or Pub/Sub.
3. Put the **Device Access project ID** in `.env` as `GOOGLE_DEVICE_ACCESS_PROJECT_ID`. It's different from the Cloud project ID.

## 3. Get the thermostat token

Stop the app if it's running, then:

```sh
npm run google-auth
```

Google opens in your browser. Sign in and select **only the thermostat**; leave cameras, doorbells and everything else unchecked. When it finishes, `GOOGLE_REFRESH_TOKEN` and `GOOGLE_DEVICE_ID` are saved in `.env`.

## 4. Check it

Run `npm start`, sign in with your admin code, and compare the reading with the real thermostat. Make one small change and confirm the thermostat follows it. Then [put it on Netlify](hosting.md).

To withdraw Google access entirely, remove the app at [Google Partner Connections](https://nestservices.google.com/partnerconnections).

## Problems

| Symptom                    | Fix                                                                           |
| -------------------------- | ----------------------------------------------------------------------------- |
| `redirect_uri_mismatch`    | The OAuth client needs exactly `http://localhost:3000/oauth/google/callback`. |
| Access denied              | Use the right Google account, and add it as a test user.                      |
| "Found 2 thermostats"      | Run again and select one, or set `GOOGLE_DEVICE_ID`.                          |
| Stops working after 7 days | Set the OAuth app to **In production**, then run `google-auth` again.         |
| "Too many requests"        | Wait. Google's command limit is shared with other apps.                       |
