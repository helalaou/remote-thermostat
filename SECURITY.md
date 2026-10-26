# Security

This app can change the temperature in a real home. Treat access as carefully as a house key. It is a personal self-hosting tool, not a safety system or a substitute for the thermostat's own protections. No independent security audit or live-hardware certification is claimed.

## Supported deployment

- Use the current release and a supported Node.js 24 update.
- Run one instance for one household, behind HTTPS for all non-loopback access.
- Keep the app's listening port private behind the reverse proxy.
- Use a non-root runtime, restrict the data directory, and keep the operating system and dependencies updated.
- Do not put a connected instance on a public demo host or ship it with a pre-created owner key.

## Credentials and sessions

The local CLI generates high-entropy access keys. They are bearer credentials, not passwords or verified identities. The database stores their hashes; sign-in sends the key in a POST body, then uses a server-side session with an HttpOnly cookie. Never transmit keys in URL parameters, fragments, logs, or public channels.

A neighbor key grants the supported thermostat controls, including Off where available. It is not heating-only or a role with per-button restrictions. Share only with someone you trust to use the equipment. Use a separate expiring key per recipient; revoke it if a device is lost or access is no longer needed. Revocation invalidates sessions linked to that key.

The initial owner is provisioned locally, not assigned to the first browser visitor. Browser-provided role, device, or identity values are never authority. Mutating app routes require origin/CSRF checks, and owner operations require an owner session.

## Google token storage

Google credentials and tokens remain server-side. A refresh token is encrypted using the operator's encryption key before storage. Keep that key outside the database, out of source control, and backed up separately. `.env` is convenient but not a secret manager: a host administrator or process with sufficient access can read it or the runtime environment. Use `TOKEN_ENCRYPTION_KEY_FILE` and `GOOGLE_CLIENT_SECRET_FILE` with your deployment platform's secret mounts when available. SQLite files are created with mode `0600` in a `0700` data directory; protect copies and backups too.

Do not log OAuth codes, callback query strings, request bodies, cookies, or token responses at the app, reverse proxy, or observability layer. Public issue reports must remove private project/device identifiers and household data.

## What this protects against—and what it does not

Server-side authorization, narrow command validation, CSRF protections, quotas, and one-device pinning reduce accidental and unauthorized control. They do not protect against a stolen active key/session, a malicious authorized neighbor, a compromised owner browser, an XSS introduced by a future change, a compromised host, or an outage at Google.

At-rest token encryption limits exposure from a database-only leak; it does not defeat an attacker who also gets the encryption key or running server. Google and device limits are enforced independently of app limits. A successful command response is not a guarantee of physical heating/cooling.

## Incident response

1. Use local admin access to revoke any exposed app keys. For an exposed owner key, list and revoke its ID locally, then create a replacement with `create-owner`.
2. Review activity and physical thermostat settings. Keep normal thermostat access available.
3. If a Google token or the host may be compromised, stop the app and revoke the grant in Google's account/Partner Connections Manager. This release has no in-app Google disconnect control.
4. Recover the host, rotate affected secrets, and reconnect only after the cause is addressed.
5. Do not publish the compromised credentials in an issue while asking for help.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** private channel if the maintainer has enabled it. If no private reporting channel is available, open a minimal issue asking how to contact the maintainer privately, without exploit details or secrets. Do not assume a response SLA or continuous monitoring.

Report affected version/commit, a sanitized reproduction, impact, and any proposed mitigation. Do not test against someone else's connected thermostat or account without permission.
