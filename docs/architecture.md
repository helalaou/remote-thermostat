# Architecture

```text
Browser ──HTTPS──▶ Node 24 + Hono ──▶ Google SDM API ──▶ one Nest thermostat
                       │
                       └─ SQLite: key hashes, sessions, encrypted Google token,
                                  rate limits, command history, guest controls
```

- **Frontend:** plain HTML/CSS/JS in `public/`. No build step. It only talks to this server, never to Google.
- **Server:** `src/`. Node runs the TypeScript directly; `tsc` only type-checks.
- **One device:** the thermostat is locked in when the owner connects Google. The browser can't pick a device or send raw API calls. Commands come from a small allowlist and are validated against a fresh reading.
- **Reads:** the page refreshes every 30 seconds while it's visible. All tabs share one server-side cache.
- **Writes:** before each command the server reads the current state, sends the command once (no blind retries), then reads back to confirm. A timeout is reported as "not confirmed", not as failed or applied.
- **Quotas:** Google allows 5 commands a minute and 100 an hour across all apps. The app tracks its own usage and backs off when Google says to.
- **Guest controls:** the owner picks which modes and Eco guests can use. The server enforces it.

| File                       | Purpose                                  |
| -------------------------- | ---------------------------------------- |
| `src/app.ts`               | Routes, auth, CSRF, headers              |
| `src/service.ts`           | Status cache, command flow, confirmation |
| `src/domain/thermostat.ts` | Parse device data, validate commands     |
| `src/google/connection.ts` | OAuth and token refresh                  |
| `src/google/sdm.ts`        | SDM API client                           |
| `src/store.ts`             | SQLite: keys, sessions, rate limits      |
| `src/controls.ts`          | Owner-set guest controls                 |
| `src/admin.ts`             | CLI: create/list/revoke keys             |
