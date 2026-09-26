# Contributing

The project is kept small, free of runtime dependencies and easy to audit, because it executes code
received over an unauthenticated channel, and because its own programs must fit through that
channel. Contributions that preserve these properties are welcome.

## Setup

Node 20 or newer.

```bash
npm test            # unit tests: protocol, boot, build, command line, GIF, size budgets
```

The browser tests (`test/e2e.mjs`) and the throughput benchmark (`test/bench.mjs`) require
Playwright and Chromium; their headers explain how to run them.

## Guidelines

- **Dependencies.** The receiver is plain browser JavaScript. `fountain.js` and `gif.js` have no DOM
  access, so that the receiver, the tools and the tests share them. Third-party code is limited to
  the decoders and the QR generator in `vendor/`, each recorded with its provenance and digest.
  Please open a discussion before proposing another.
- **Size budgets.** `test/budget.test.mjs` bounds the compressed size of each program. Raising a
  budget requires a justification.
- **Protocol changes.** Any change to what is transmitted (frames, containers, the PRNG or the masks)
  must be made in the parameter block of `docs/PROTOCOL.md`. This yields a new protocol identifier,
  which must be recorded as `PROTOCOL` in `fountain.js`, together with the test vectors.
- **Boot and core.** `boot.js` should change rarely, since installed receivers can replace their core
  over the optical channel but not their boot program.
- **Security-sensitive code** (`open`, `Receiver`, `boot.js`, the policy and activation code in
  `core.js`, `tools/build.mjs`, `.github/workflows/`) requires tests that demonstrate the refusal of
  the adverse case, not only the acceptance of the intended one.
- **Keys.** Never commit private keys or `signing-key.json` (it is gitignored). Public keys are configured through the `TRUSTED_KEYS` variable, not in the source.
- **Match the surrounding style,** keep comments short, and explain why rather than what.

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Keep the change focused, and include or update tests.
3. Make sure `npm test` passes.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE). Please also follow the [Code of Conduct](CODE_OF_CONDUCT.md). For vulnerabilities, see [SECURITY.md](SECURITY.md) instead of opening an issue.
