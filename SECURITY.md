# Security

This app changes the temperature in a real home. Treat access keys like house keys.

## How access works

- Keys are random 256-bit tokens. Only their hashes are stored. Signing in exchanges a key for an HttpOnly session cookie.
- The owner key is created from the server CLI, never by the first visitor.
- Guests get only the one thermostat, and only the modes the owner allows. They never see Google tokens.
- Revoking a key ends its sessions immediately.
- All writes check the request origin and a CSRF token.

## Secrets

- The Google refresh token is encrypted with `TOKEN_ENCRYPTION_KEY` before it is stored. Keep that key out of git and back it up privately.
- `.env` and `data/` are private. Never commit them.
- Never put keys in URLs, screenshots, issues or chat.

## If something leaks

1. Revoke the key: `npm run admin -- list`, then `npm run admin -- revoke KEY_ID`.
2. If the Google token or server may be exposed, stop the app and remove its access at [Google Partner Connections](https://nestservices.google.com/partnerconnections).
3. Rotate secrets and reconnect.

## Limits

This doesn't protect against a stolen active session, a compromised server, or a guest misusing access you gave them. It isn't a safety system. Keep the physical thermostat available.

Report vulnerabilities privately through GitHub's **Security → Report a vulnerability**.
