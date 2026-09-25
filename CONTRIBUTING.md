# Contributing

Thanks for your interest. This project aims to stay **small, dependency-free and easy to audit**, because it runs code received over the air. Changes that keep it that way are the most welcome.

## Setup

Node 20 or newer.

```bash
npm test            # unit tests (protocol, signing, build, CLI)
```

The browser end-to-end test is optional; its header in `test/e2e.mjs` explains how to run it (it needs Playwright, qrcode-generator and Chromium).

## Guidelines

- **No runtime dependencies.** The loader is plain browser JavaScript; `fountain.js` must stay DOM-free so the loader, tools and tests share it. The one exception is the vendored fallback QR decoder (`vendor/jsQR.js`, see `vendor/README.md`); please discuss before adding another.
- **Protocol changes.** Anything that changes what goes over the wire (frames, the container, the PRNG or `mask`) breaks existing streams. Bump the protocol version, update the regression vector in `test/roundtrip.test.mjs`, and update the README.
- **Security-sensitive code** (`open`, `Receiver`, payload activation in `index.html`, `tools/build.mjs`, anything in `.github/workflows/`) needs tests that show the bad case is refused, not only that the good case works.
- **Keys.** Never commit private keys or `signing-key.json` (it is gitignored). Public keys are configured through the `TRUSTED_KEYS` variable, not in the source.
- **Match the surrounding style,** keep comments short, and explain why rather than what.

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Keep the change focused, and include or update tests.
3. Make sure `npm test` passes.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE). Please also follow the [Code of Conduct](CODE_OF_CONDUCT.md). For vulnerabilities, see [SECURITY.md](SECURITY.md) instead of opening an issue.
