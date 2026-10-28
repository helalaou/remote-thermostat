# Security

This app changes the temperature in a real home. Treat both codes like house keys.

## How access works

- Two codes: **admin** (full control) and **user** (only what the admin allows). `ADMIN_CODE` must be at least 12 characters.
- Signing in gives an HttpOnly, signed cookie. Changing a code signs out everyone using it.
- The user can't reach the admin panel, and every user command is checked on the server against the admin's settings. Turning Eco off is always allowed.
- Wrong codes are rate-limited. A short user code can still be guessed eventually, so keep the user's modes and temperature range narrow, or switch access off when it isn't needed.
- All writes check the request origin and a CSRF token.

## Secrets

- Codes and Google credentials live only in `.env` (local) and Netlify environment variables. Never commit them.
- The Google token gives access only to the devices you selected when running `google-auth`. Select just the thermostat.

## If something leaks

- **User code:** turn access off in the admin panel, then change `USER_CODE` and redeploy.
- **Admin code or Google values:** change them in Netlify and redeploy, and remove the app at [Google Partner Connections](https://nestservices.google.com/partnerconnections). Then run `npm run google-auth` again.

## Limits

This isn't a safety system. Keep the physical thermostat available.

Report vulnerabilities privately through GitHub's **Security → Report a vulnerability**.
