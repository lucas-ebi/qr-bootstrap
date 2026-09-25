# QR Bootstrap

A tiny offline PWA that receives **signed** software over an animated QR stream and runs it. No network, no install step beyond the page itself.

- **Loss-tolerant:** a fountain code, so frames can be missed and scanned in any order.
- **Authenticated:** payloads carry an Ed25519 signature and only run if signed by a key pinned in the loader.
- **Compact:** payloads are deflate-compressed and framed in base45, which QR codes store in their dense alphanumeric mode.

## Quick start

Needs Node 20+ for the tools and a Chromium-based browser (with `BarcodeDetector` and Ed25519 WebCrypto) for the loader.

```bash
# 1. Make a signing key. The private key stays in signing-key.json (gitignored).
node tools/encode.mjs keygen
#    Paste the printed public key into TRUSTED_KEYS in index.html.

# 2. Serve the loader (camera access needs localhost or HTTPS)
npm run serve

# 3. Turn the example game into an animated QR player, and open it on another screen
node tools/encode.mjs sign examples/snake.html --id snake --html snake.player.html
```

Point the loader's camera at the player. The HUD shows progress, then the game starts. On a phone, host the loader on any static HTTPS site (a phone cannot reach your `localhost`).

`sign` without `--html` prints one frame per line, so you can feed any other QR renderer.

## How it works

1. **Seal.** `sig(64 B) || deflate-raw("<type> <id>\n" + payload)`, where the Ed25519 signature covers the compressed part.
2. **Split** the container into `n` blocks of `b = ceil(len / n)` bytes.
3. **Encode.** Each symbol is the XOR of a random subset of the blocks. The subset is fully determined by a 32-bit seed: block `j` is included iff bit `j` of the Mulberry32 output stream is set (a fresh 32-bit word every 32 blocks).
4. **Decode.** The loader runs incremental Gaussian elimination over GF(2). Any `n` linearly independent symbols recover the container. In practice `n + 1` to `n + 2` symbols are enough (measured by `npm test`: about 1.2 to 2.1 extra symbols for `n` = 8 to 150).
5. **Verify, then run.** The stream ID must match the SHA-256 prefix of the container, the signature must verify against a pinned key, and only then is the payload decompressed and activated.

### Frame format

```
QB1/<streamId>/<n>/<len>/<seed>/<data>
```

| Field | Meaning |
|-------|---------|
| `QB1` | Protocol version |
| `streamId` | First 8 bytes of SHA-256(container), uppercase hex |
| `n` | Block count (1 to 256) |
| `len` | Container length in bytes (65 to 262144) |
| `seed` | Symbol seed (uint32) |
| `data` | One symbol (`b` bytes), base45 (RFC 9285) |

Every character is in the QR alphanumeric set, so encoders should use alphanumeric mode (`tools/encode.mjs --html` does). Frames are self-describing; the loader may also receive one via the page URL hash (`https://host/#QB1/...`).

### Payload types

| Type | Behavior |
|------|----------|
| `mjs` | Imported as an ES module; its `init({ id, modules, log, startScanner, stopScanner })` is called |
| `html` | The page navigates to it (a `blob:` URL) |
| `json` | Parsed and stored in `window.qrboot.modules` |

## Trust model

- Only payloads signed by a key in `TRUSTED_KEYS` run. Frames from anyone else are rejected after decoding.
- A signature proves who authored a payload, not that it is safe. `mjs` and `html` payloads run with the loader's full origin privileges (for example, they could rewrite the service-worker cache). Sign only code you trust.
- There is no replay protection: an old signed version of a payload is still valid. Put a version check in the payload if that matters.

## Limits and support

- Browsers: needs `BarcodeDetector` (Chromium-based; not available in Firefox or Safari) and Ed25519 in WebCrypto.
- Streams are capped at 256 blocks, 256 KiB and 1500 B per block; anything beyond that is rejected before allocation.
- Updates: the service worker is stale-while-revalidate, so an installed copy updates on the next load after it.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Loader UI: camera, scanner, HUD, payload activation |
| `fountain.js` | Protocol core (base45, frames, decoder, container, receiver). No DOM, shared with the tools and tests |
| `tools/encode.mjs` | `keygen` and `sign`: signs a file and emits frames or a QR player page |
| `examples/snake.html` | Example payload (a snake game) |
| `test/roundtrip.test.mjs` | Unit tests: `npm test` |
| `test/e2e.mjs` | Browser test with fake camera, using the snake game as payload (optional, see its header) |
| `sw.js`, `manifest.json` | Offline support and PWA metadata |

## License

MIT
