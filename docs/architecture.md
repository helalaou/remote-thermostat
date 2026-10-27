# Architecture and boundaries

## Small by design

```text
Phone browser
   │ HTTPS, app session + CSRF token
   ▼
Reverse proxy → Node 24 / Hono server
                     │
                     ├─ SQLite: access-key hashes, sessions, history,
                     │          rate reservations, encrypted Google token
                     │
                     └─ Google OAuth + official SDM API
                                  │
                                  ▼
                         One fixed Nest thermostat
```

The browser is static HTML/CSS/JavaScript. It never talks directly to Google. Node runs the server's erasable TypeScript; `tsc --noEmit` checks types. Built-in SQLite keeps the installation small and avoids a separate database service. Run a single app instance with its own persistent data directory.

## Two separate permissions

**App access** is a server-generated 256-bit key exchanged through a POST sign-in form for an opaque session cookie. Keys are hashed before storage. An owner provisions the initial owner key from the local CLI; there is no first-visitor bootstrap or default credential. Guest keys are separate, expire, and can be revoked. Revocation is checked server-side, including for already-issued sessions.

**Google access** is the owner's explicit OAuth grant to the app. Google refresh tokens are encrypted at rest using an operator-provided key. Keep the encryption key separate from the database. Only owner routes can start a Google connection; revoke the grant in Google when you want to withdraw it. A guest never sees these tokens or joins Google Home.

A key identifies possession of a permission, not a verified human. Use one key per recipient, a descriptive label, and a private delivery channel. This intentionally trades a second identity-provider setup for simple personal self-hosting. It is not suitable for situations requiring identity proof, MFA, or enterprise account recovery.

## One device, narrow commands

The server pins one thermostat resource during owner setup. It does not accept an arbitrary device URL, Google resource name, API endpoint, or command string from a browser. Commands are selected from a small typed allowlist and validated against a fresh device response.

The validator checks connectivity, available modes, Eco state, trait availability, numeric bounds, and range ordering. Setting a target never implicitly changes thermostat mode or disables Eco. Turning a mode or Eco on/off is a separate explicit action. Fan controls require the fan trait. The API's own device-specific constraints remain authoritative.

## Reads and freshness

Visible pages refresh periodically; hidden pages pause their timer. Requests share a server cache and concurrent refresh work, rather than each tab independently consuming Google reads. Polling is an approximation, not instant telemetry. The UI distinguishes a current observation from stale data and never invents a live temperature when disconnected.

Before a write, the server gets fresh mode/Eco state. State can still change between that read and Google's command handling; Google's precondition checks are the final arbiter. After command acceptance, the app reads back status and reports whether the requested state was observed. It does not optimistically label a request as physically applied.

## Quotas and retries

Thermostat command limits are shared across integrations: 5 per minute and 100 per hour. This app accounts for its own attempts with a shared reservation ledger, handles Google quota errors, and avoids blind command retries. It cannot know how much of the quota another integration has already consumed. Client request IDs protect against repeated submission of the same request.

A timeout can mean a command failed **or** that Google received it but the reply was lost. The correct response is to refresh and inspect status—not automatically issue the command again. See [Google rate limits](https://developers.google.com/nest/device-access/project/limits).

## Safety and operational scope

- App target bounds are operator policy, not equipment capability discovery.
- The Google grant may outlive a guest's key. Revoke them independently as needed.
- Physical controls, existing schedules, and other integrations remain in charge of their own changes.
- There is no background scheduling, presence sensing, automatic heating policy, or emergency alerting.
- The app host and its administrator are trusted. Root access to a running server can obtain secrets; at-rest encryption does not protect against a fully compromised host.
- No analytics or third-party scripts are included. The local database still contains sensitive household activity; apply appropriate access, retention, and backup controls.

See [SECURITY.md](../SECURITY.md) for deployment precautions and responsible reporting.
