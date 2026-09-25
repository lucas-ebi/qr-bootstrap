# Vendored code (tools only)

Not shipped to the deployed loader; used by `tools/encode.mjs` to draw QR codes into GIFs.

## qrcode-generator 2.0.4

- What: a QR code generator by Kazuhiko Arase.
- Source: https://github.com/kazuhikoarase/qrcode-generator (npm `qrcode-generator@2.0.4`, file `dist/qrcode.mjs`, unmodified).
- License: MIT, see [qrcode.LICENSE](qrcode.LICENSE) (copied from the upstream repository).
- SHA-256 of `qrcode.mjs`: `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`

To update: `npm pack qrcode-generator@<version>`, replace the file, update the version and checksum here, and run `npm test`.
