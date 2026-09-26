# Third-party code

The files in this directory are copied unmodified from the packages named below. Each is
recorded with its SHA-256 digest, so that a copy can be checked against its source.

## zxing-wasm 3.1.4 (QR decoding, primary)

The reader build of zxing-wasm, a WebAssembly compilation of zxing-cpp. It locates and decodes
several QR codes per image in a few milliseconds, and is used by `decode-worker.js` wherever the
browser provides no `BarcodeDetector` (notably Safari on iOS). Source: npm `zxing-wasm@3.1.4`,
files `dist/es/share.js`, `dist/es/reader/index.js` and `dist/reader/zxing_reader.wasm`, placed so
that the relative import between the first two is preserved. Licences: MIT (wrapper) and
Apache-2.0 (zxing-cpp, commit `0b2d9a8f`); both texts are in [zxing/LICENSE](zxing/LICENSE).

| File | SHA-256 |
|---|---|
| `zxing/share.js` | `08868fb770b0a4e4b9eb3d717015cd5fbf3ceb06492d4cb2d2dd2739db11890f` |
| `zxing/reader/index.js` | `d90c69a827aff3b7c8c8ca310efebe91671ef076f7a0ec83722bfc542814f484` |
| `zxing/reader/zxing_reader.wasm` | `e8af31edb56d0522f4de74495839385ef019ba8bc90d38e5ecb2f18795d86fb2` |

## jsQR 1.4.0 (QR decoding, last resort)

A decoder written in JavaScript, used only where WebAssembly is unavailable. It finds one code
per image. Source: npm `jsqr@1.4.0`, file `dist/jsQR.js`. Licence: Apache-2.0, see
[jsQR.LICENSE](jsQR.LICENSE); there is no NOTICE file.

| File | SHA-256 |
|---|---|
| `jsQR.js` | `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859` |

## qrcode-generator 2.0.4 (QR encoding)

Produces the QR matrices drawn by `gif.js`, both on screen and in GIF files. Source: npm
`qrcode-generator@2.0.4`, file `dist/qrcode.mjs`. Licence: MIT, see
[qrcode.LICENSE](qrcode.LICENSE).

| File | SHA-256 |
|---|---|
| `qrcode.mjs` | `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0` |

To update a package, run `npm pack <name>@<version>`, replace the files, update the version and
digests above, and run `npm test` and `node test/e2e.mjs`.
