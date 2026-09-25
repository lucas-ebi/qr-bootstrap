# QR Bootstrap

A tiny offline PWA that receives **signed** software over an animated QR stream and runs it. No network, no install step beyond the page itself.

- **Loss-tolerant:** a fountain code, so frames can be missed and scanned in any order.
- **Authenticated:** payloads carry an Ed25519 signature and only run if signed by a key pinned in the loader.
- **Compact:** payloads are deflate-compressed and framed in base45, which QR codes store in their dense alphanumeric mode.

## Quick start

Needs Node 20+ for the tools, and a recent browser with camera access and Ed25519 WebCrypto (Chrome, Edge, Firefox or Safari) for the loader.

```bash
# 1. Make a signing key. The private key stays in signing-key.json (gitignored).
node tools/encode.mjs keygen

# 2. Build the loader with your public key pinned, and serve it (camera access needs localhost or HTTPS)
TRUSTED_KEYS="<the printed public key>" npm run build && npx serve dist

# 3. Turn the example game into an animated QR player, and open it on another screen
node tools/encode.mjs sign examples/snake.html --id snake --html snake.player.html
```

Point the loader's camera at the player. The HUD shows progress, then the game starts. On a phone, host the loader on any static HTTPS site (a phone cannot reach your `localhost`).

`sign` without `--html` prints one frame per line, so you can feed any other QR renderer. To ship an update, sign the new build again (the version defaults to the current time, or pass `--version N`). The first run of each app asks for your approval.

## How it works

1. **Seal.** `sig(64 B) || deflate-raw("<type> <id> <version>\n" + payload)`. The Ed25519 signature covers `"QB1-payload\0" || <the compressed part>`, so it cannot be replayed in another protocol. `version` defaults to the current Unix time.
2. **Split** the container into `n` blocks of `b = ceil(len / n)` bytes.
3. **Encode.** Each symbol is the XOR of a random subset of the blocks. The subset is fully determined by a 32-bit seed: block `j` is included iff bit `j` of the Mulberry32 output stream is set (a fresh 32-bit word every 32 blocks).
4. **Decode.** The loader runs incremental Gaussian elimination over GF(2). Any `n` linearly independent symbols recover the container. In practice `n + 1` to `n + 2` symbols are enough (measured by `npm test`: about 1.2 to 2.1 extra symbols for `n` = 8 to 150).
5. **Verify, then run.** The stream ID must match the SHA-256 prefix of the container and the signature must verify against a pinned key. Only then is the payload decompressed. The loader then refuses versions older than the newest it has run, asks you to confirm the first run of each app (see below), and activates it.

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
| `html` | Runs in a fullscreen sandboxed iframe (scripts only, opaque origin) with a close button |
| `json` | Parsed and stored in `window.qrboot.modules` |

## Trust model

- **Signed only.** Payloads run only if signed by a key in `TRUSTED_KEYS`, which is pinned into the page at build time (see Deploying). Frames from anyone else are rejected after decoding.
- **No replay.** Each payload carries a version. The loader remembers the newest one it ran per app id and rejects older ones ("older version"). This state lives in the browser's `localStorage`, so clearing site data (or private browsing) resets it.
- **You approve first runs.** The first time an app id arrives from a given signer, the loader shows its name, version and the signer's key fingerprint and waits for you. Later versions from the same signer run without asking; the same id from a different signer asks again.
- **HTML apps are sandboxed.** They get an opaque origin: no access to the loader's storage, cache or service worker, or to other sites on the same host.
- **`mjs` modules are not sandboxed.** They run in the loader's page so they can extend it (`init({ id, modules, log, startScanner, stopScanner })`). A signed module has the loader's full privileges, for example it could rewrite the service-worker cache. Sign only code you trust.
- The loader is only as trustworthy as where it is hosted, since that is where the pinned key lives.

## Hardening the deployment

- Serve from your own domain rather than a shared `*.github.io` origin, so nothing else shares the loader's origin.
- Protect `main` (required review, no force-push) and turn on 2FA for the repo: whoever can change the code, the workflow or the `TRUSTED_KEYS` variable can change who is trusted.
- Keep `signing-key.json` out of the repo and off shared machines, or store it in a password manager.
- **Rotating a key:** add the new public key to the `TRUSTED_KEYS` variable and redeploy, start signing with the new key, then remove the old key from the variable and redeploy again. Installed copies update on their next load after a deploy, so keep the overlap long enough for them to pick it up.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` publishes the loader on every push to `main`. It runs the tests, pins your public key into the page, and publishes only the loader files (`tools/`, `test/` and `examples/` are not deployed). One-time setup in the repo's Settings:

1. **Pages → Build and deployment → Source:** GitHub Actions.
2. **Secrets and variables → Actions → Variables → New repository variable** named `TRUSTED_KEYS`, containing the public key(s) printed by `keygen`, comma-separated. It is a variable rather than a secret because public keys are not confidential.

The build fails, rather than deploying a loader that trusts nothing, if the variable is missing or malformed. To build the same artifact locally:

```bash
TRUSTED_KEYS="<public key>" npm run build && npx serve dist
```

## Signing in CI (keep the private key off your laptop)

Signing works locally (`tools/encode.mjs`), but the private key can instead live only in a GitHub secret, with `.github/workflows/sign.yml` doing the signing. Then you can sign from any device that can run a workflow.

One-time setup (replace `OWNER/REPO`, or run inside a clone):

```bash
# 1. An environment to hold the key. (Settings -> Environments: you can also require reviewers
#    and restrict it to the main branch, if your plan allows.)
gh api -X PUT repos/OWNER/REPO/environments/signing

# 2. Generate the key straight into the secret. It goes through a pipe and never touches disk.
#    The public key is printed to your terminal.
node tools/encode.mjs keygen - | gh secret set SIGNING_KEY --env signing -R OWNER/REPO

# 3. Set that public key as the TRUSTED_KEYS variable (see Deploying) and deploy.
gh variable set TRUSTED_KEYS -R OWNER/REPO --body "<the printed public key>"
```

To sign: **Actions → Sign payload → Run workflow**, giving the payload's path in the repo, an app id and optionally a version. Or:

```bash
gh workflow run sign.yml -f file=examples/snake.html -f id=snake
gh run watch && gh run download        # fetches player-snake/player.html
```

Good to know:
- The payload must be committed to the repo, because the workflow runs on GitHub.
- A secret cannot be read back. If it is ever lost, generate a new key and rotate (see Hardening).
- Anyone who can edit workflows on a branch that can use the `signing` environment can make it sign, or read the key. Protect `main`, and limit the environment to `main` (and require reviewers) where your plan allows.

## Limits and support

- **Browsers:** any recent browser with camera access and Ed25519 in WebCrypto. QR decoding uses the browser's built-in `BarcodeDetector` where it exists (Chrome on Android, macOS and ChromeOS) and the bundled jsQR fallback everywhere else (Chrome on desktop Linux and Windows, Firefox, Safari, iOS). The fallback is slower and reads one code per frame. So far it has only been tested with Chromium on Linux; real phone cameras, Safari and iOS have not been tested.
- Streams are capped at 256 blocks, 256 KiB and 1500 B per block; anything beyond that is rejected before allocation.
- Updates: the service worker is stale-while-revalidate, so an installed copy updates on the next load after it.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Loader UI: camera, scanner, HUD, payload activation |
| `vendor/` | jsQR (Apache-2.0), the fallback QR decoder for browsers without `BarcodeDetector` |
| `fountain.js` | Protocol core (base45, frames, decoder, container, receiver). No DOM, shared with the tools and tests |
| `tools/encode.mjs` | `keygen` and `sign`: signs a file and emits frames or a QR player page |
| `tools/build.mjs` | Assembles the deployable loader in `dist/` with `TRUSTED_KEYS` pinned (`npm run build`) |
| `.github/workflows/deploy.yml` | Tests, builds and publishes the loader to GitHub Pages |
| `.github/workflows/sign.yml` | Signs a payload with the key stored in GitHub and outputs a QR player |
| `examples/snake.html` | Example payload (a snake game) |
| `test/roundtrip.test.mjs` | Unit tests: `npm test` |
| `test/e2e.mjs` | Browser test with fake camera, using the snake game as payload (optional, see its header) |
| `sw.js`, `manifest.json` | Offline support and PWA metadata |

## Third-party

The loader bundles one third-party file, `vendor/jsQR.js` ([jsQR](https://github.com/cozmo/jsQR) 1.4.0, Apache-2.0, license in `vendor/jsQR.LICENSE`, provenance in [vendor/README.md](vendor/README.md)). It is loaded only when the browser has no built-in `BarcodeDetector`. There are no other runtime dependencies. The optional QR player page generated by `encode.mjs --html` loads [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) from cdnjs when you open it.

The app icons (`icon-192.png`, `icon-512.png`) were generated with an AI image tool. Such images may not be eligible for copyright, so the MIT license applies to them only to the extent that they are; feel free to replace them.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
