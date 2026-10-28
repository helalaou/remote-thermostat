# Architecture

```text
Browser ──HTTPS──▶ Netlify function (Hono) ──▶ Google SDM API ──▶ one Nest thermostat
                        │
                        ├─ environment: codes, Google credentials, device ID
                        └─ Netlify Blobs: user-access settings (one small record)
```

- **Frontend:** plain HTML/CSS/JS in `public/`, served as static files. It only talks to this app, never to Google.
- **Sign-in:** the code is exchanged for a signed, HttpOnly cookie. The signing key is derived from `ADMIN_CODE`, and each cookie is tied to the code it was issued for, so changing a code signs those sessions out. No sessions are stored.
- **One device:** the thermostat is fixed by `GOOGLE_DEVICE_ID`. Commands come from a small allowlist and are checked against a fresh reading.
- **User access:** the admin chooses modes, Eco, a temperature range and on/off. The server checks every user command against it. If the settings can't be read, the user is locked out.
- **Writes:** read the current state, send the command once (no blind retries), then read back to confirm. A timeout is reported as "not confirmed".
- **Limits:** wrong codes and Google requests are rate-limited in memory, per function instance. Google enforces its own limit of 5 commands a minute and 100 an hour.

| File                       | Purpose                                   |
| -------------------------- | ----------------------------------------- |
| `src/app.ts`               | Routes, sign-in, CSRF, headers            |
| `src/crypto.ts`            | Signed session cookies, code checks       |
| `src/controls.ts`          | User access: rules and storage            |
| `src/service.ts`           | Reading cache, command flow, confirmation |
| `src/domain/thermostat.ts` | Parse device data, validate commands      |
| `src/google/connection.ts` | Refresh-token → access-token              |
| `src/google/sdm.ts`        | Google SDM client                         |
| `src/store.ts`             | In-memory rate limits and recent commands |
| `src/server.ts`            | Local server                              |
| `netlify/functions/api.ts` | Netlify entry point                       |
| `scripts/google-auth.ts`   | One-time Google sign-in                   |
