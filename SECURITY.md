# Security policy

QR Bootstrap receives programs over an optical channel and executes them, and its security model is
set out in Section 4 of the [README](README.md). Reports of weaknesses in that model are welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security tab → Report a vulnerability** on this repository.

This is a personal project without a service-level agreement. Reports are handled on a best-effort basis, and I will try to acknowledge one within about a week.

## Supported versions

Only the latest commit on `main` (the deployed loader) is supported.

## What is in scope

- Execution of code not signed by a trusted key; circumvention of the version check or of the approval of new signers.
- Execution or active rendering of a received file.
- A core, stored or received, that changes the trusted keys or evades the rollback mechanism of `boot.js`.
- Escapes from the sandbox of HTML programs.
- Frames that cause excessive memory or time consumption before validation.
- Service-worker or storage behaviour that lets content persist or be replaced unexpectedly.
- Weaknesses in the vendored decoders as used here (please also report them upstream).
- Weaknesses in the build, signing and deployment tooling (`tools/`, `.github/workflows/`), such as key disclosure.

## What is out of scope (by design)

- Harmful behaviour of code signed by a trusted key; trust in the signer is the premise of the model.
- The privileges of `mjs` modules, which run in the receiver's context by design.
- The absence of authenticity for files (only integrity is provided).
- Browsers without camera access or Ed25519 support.

## If a signing key may be compromised

Rotate it as described in Section 7.4 of the [README](README.md).
