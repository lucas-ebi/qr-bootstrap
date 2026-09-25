# Vendored code

## jsQR 1.4.0

- What: a pure-JavaScript QR code decoder, used by the loader only when the browser has no built-in `BarcodeDetector` (desktop Linux/Windows Chrome, Firefox, Safari, iOS).
- Source: https://github.com/cozmo/jsQR (npm package `jsqr@1.4.0`, file `dist/jsQR.js`, unmodified).
- License: Apache-2.0, see [jsQR.LICENSE](jsQR.LICENSE). It has no NOTICE file.
- SHA-256 of `jsQR.js`: `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859`

To update: `npm pack jsqr@<version>`, replace both files, update the version and checksum here, and run `npm test` and `node test/e2e.mjs`.
