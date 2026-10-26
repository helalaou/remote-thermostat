# Before sharing a connected deployment

Offline tests are necessary, not sufficient. Complete this checklist in your own environment when you are ready to connect Google.

## Source and build

- [ ] Review the code, README, MIT license attribution, and dependency lockfile.
- [ ] Run `npm ci` and `npm run check` on Node.js 24.
- [ ] If deploying Docker, build and run the image locally; verify the non-root container can write its data volume and restart without losing state.
- [ ] Verify no `.env`, tokens, real device IDs, database files, or private screenshots are in the repository or image.
- [ ] If publishing to GitHub, choose the intended repository/visibility and inspect the remote commit and CI results. A local Git history is not a published repository.

## Access and deployment

- [ ] HTTPS is valid and `APP_ORIGIN` matches the exact browser origin.
- [ ] Port 3000 is not directly exposed to the internet.
- [ ] Owner key is stored privately; no default/demo credentials exist.
- [ ] Confirm a neighbor cannot access owner settings or Google linking.
- [ ] Confirm a revoked/expired key loses access from an already-open session.
- [ ] Test private backup and recovery of the data volume and encryption key.
- [ ] Check proxy logs do not store tokens, cookies, bodies, or OAuth callback query strings.

## Optional Google and hardware checks

- [ ] Review Google's current terms and fee yourself; configure your own projects and credentials.
- [ ] Complete owner consent and verify only the intended thermostat is pinned.
- [ ] Confirm live readings against the physical thermostat; do not confuse demo with real data.
- [ ] Review target bounds and available modes against your home's equipment.
- [ ] Make one appropriate small change and verify its read-back/physical result.
- [ ] Confirm stale/offline behavior and recovery without repeated command submission.
- [ ] Check OAuth refresh after the initial access token expires, and after seven days if applicable to your consent setup.
- [ ] Keep manual/official thermostat access available, and explain it to the neighbor.

Do not record a hardware test as passed until it was actually performed. Do not test disruptive Off/Eco changes merely for completeness when conditions make that unsafe or inconvenient.
