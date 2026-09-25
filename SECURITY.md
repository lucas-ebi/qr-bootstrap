# Security policy

QR Bootstrap receives software over QR codes and runs it, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security tab → Report a vulnerability** on this repository.

This is a personal project without a service-level agreement. Reports are handled on a best-effort basis, and I will try to acknowledge one within about a week.

## Supported versions

Only the latest commit on `main` (the deployed loader) is supported.

## What is in scope

- Ways to make the loader run a payload that was not signed by a pinned key, or to bypass the version (replay) check or the first-run confirmation.
- Escapes from the HTML payload sandbox.
- Crafted QR frames that hang the loader, exhaust memory, or otherwise cause denial of service.
- Service worker or caching behavior that lets content persist or be replaced unexpectedly.
- Problems in the build, signing or deploy tooling and workflows (`tools/`, `.github/workflows/`), such as key leakage.

## What is out of scope (by design)

- A payload signed by a trusted key doing harmful things. Trusting a signer is the model; see "Trust model" in the [README](README.md).
- `mjs` modules having the loader's full privileges. This is documented and intentional.
- Browsers that lack `BarcodeDetector` or Ed25519 support.

## If a signing key may be compromised

Rotate it as described under "Hardening the deployment" in the [README](README.md): add a new key to `TRUSTED_KEYS`, redeploy, sign with the new key, then remove the old one.
