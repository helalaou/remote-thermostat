# Contributing

Thanks for helping keep this small and understandable.

## Local development

Use Node.js 24. From the repository root:

```sh
npm ci
cp .env.example .env
npm run dev
npm run check
```

The disconnected app and local demo do not require Google credentials. Tests must use synthetic device responses and temporary databases, never a real household thermostat.

## Changes

1. Keep each change focused: explain the problem, solution, and trade-offs.
2. Make small, genuine commits as work progresses. Do not rewrite history to manufacture development steps or impersonate another author.
3. Add regression tests for authorization, parsing, commands, throttling, and failure behavior you change.
4. Run `npm run check` before opening a pull request. Check phone layouts, keyboard navigation, and stale/disconnected states for UI changes.
5. Update the README or setup guide when behavior, defaults, or required configuration changes.

Never commit `.env`, database files, tokens, access keys, real Google project/device IDs, or screenshots containing household information. Synthetic test values should be clearly non-production.

Avoid adding a framework or service unless it solves a concrete problem. Preserve the single-thermostat boundary and keep server validation authoritative. Do not add an arbitrary Google command proxy, silent mode/Eco changes, or an authentication bypass for demos.

Before proposing broader commercial/multi-household hosting, review Google's policies and the security model. Open source does not itself confer Google API authorization.

## Bugs and security

For ordinary bugs, include reproduction steps, expected behavior, runtime version, and sanitized output. Do not include private tokens, cookies, project/device IDs, or full OAuth URLs. Follow [SECURITY.md](SECURITY.md) for vulnerabilities rather than publishing an exploit or secrets in an issue.

## License

Contributions are provided under this repository's [MIT license](LICENSE). Credit third-party work and preserve its license notices. Nest and Google names identify interoperability; they do not imply endorsement.

### Browser smoke test (optional)

With an existing Chromium installed, run `CHROMIUM_PATH=/path/to/chromium npm run test:browser`.
The runner launches a temporary disconnected server, exercises only local demo controls, and removes
its test database afterward. Set `SCREENSHOT_DIR` to a local directory to save screenshots. It does
not install a browser. On a locked-down container, Chromium may require platform permission or may
not run at all; do not treat passing DOM tests as a substitute for browser/device verification.

Run `npm run format` to format source and `npm run format:check` before submitting a change.
