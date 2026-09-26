# QR Bootstrap

## Abstract

QR Bootstrap transfers programs and files between devices through sequences of QR codes shown on
one screen and captured by another device's camera. It requires no network, pairing or radio. Data
is protected against loss by a rateless erasure code, so the receiver may miss any subset of frames
and join a transmission at any point. Programs carry Ed25519 signatures and run only when signed by
a key fixed in the receiver. The receiver is a web application of about 21 KB (compressed, excluding the vendored QR decoders), divided
into a fixed boot program and a replaceable core. A newer core can therefore be delivered through the
same optical channel it implements, and every receiver can retransmit what it holds, the receiver
itself included. The intended use is the distribution of software and documents where networks are
unavailable, as after a disaster, starting from devices on which the receiver has been installed
beforehand.

## 1. Motivation and scope

The screen–camera channel is almost universally available, one-way and short-range, and its
bandwidth is modest. Modest is relative: one version-40 QR code holds 2,953 bytes, about three times
the memory of a Sinclair ZX81. The design follows from three constraints.

- The channel has no return path, so the sender cannot learn which frames were lost.
- Receivers are ordinary telephones with ordinary cameras.
- Whatever runs on the receiver must be small enough to travel over the channel itself.

A stock camera application does not execute code found in a QR code, and browsers refuse top-level
navigation to `data:` URLs. First contact therefore requires one installation of the receiver, from
the web or otherwise. Every subsequent transfer, including upgrades of the receiver, uses the optical
channel alone. Removing the initial installation would require support from the operating system;
it is outside the scope of this work.

## 2. System model

```
  sender screen                                       receiver camera
 ┌──────────────┐   QR frames, one-way, lossy        ┌────────────────────────────────┐
 │ loader (TX)  │ ─────────────────────────────────► │ decode worker (zxing-wasm)     │
 │ or a GIF file│                                    │   → Receiver (erasure decoder) │
 └──────────────┘                                    │   → policy: signature, version,│
                                                     │     approval → run or keep     │
                                                     └────────────────────────────────┘
```

A *container* is a byte string of at most 4 MiB. It is split into n blocks, and the sender emits
an unbounded sequence of symbols, each the XOR of a pseudo-random subset of blocks selected by a
32-bit seed. Every symbol is written as one frame in the QR alphanumeric alphabet (base45) and
shown as one QR code. The receiver solves the resulting linear system over GF(2) incrementally, and
reconstructs the container from any n linearly independent symbols. With uniformly drawn subsets
this takes n + 2 symbols on average; `npm test` measures 1.3 to 1.9 extra symbols for n between 8
and 150. The normative definition of frames, containers and the protocol identifier is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

Containers are of two kinds. A *code* container holds a program (an ES module, an HTML document
or JSON), compressed and signed. A *file* container holds arbitrary data with a name and a media
type, compressed when that helps, and unsigned, since telephones create files but hold no signing
key.

Transmissions take two forms. The receiver itself shows an endless stream of codes starting from
a random seed, so two senders showing the same container simultaneously contribute distinct
symbols. Alternatively, `tools/encode.mjs` or the receiver writes a looping GIF, which any image
viewer can display without the receiver. A GIF may begin with a countdown of QR codes that link to
the receiver's address with the fragment `#scan`, so that a telephone's camera application can open
the receiver before the data frames begin. On a telephone with a single device, a saved GIF or a
screen recording can be opened as a file and decoded without a camera.

## 3. The receiver

### 3.1 Boot and core

The receiver consists of two programs. `boot.js` (1.6 KB compressed) holds the trusted public keys
and a key-value store in IndexedDB. On each start it selects a core: either the one shipped with the
installation or the newest stored core whose signature verifies, whichever version is higher, unless
that version has been marked as failed. `core.js` (about 10 KB compressed) implements everything else:
the interface, scanning, the transmission view, the library and file handling. It even supplies its
own style sheet, so a newer core can change any aspect of the receiver except the set of trusted
keys.

A core arrives as a code container with the reserved id `loader`. It is verified, stored, and takes
effect at the next start. Before starting a stored core, the boot program records it as pending, and
clears that mark once `start()` has completed. A core that throws is marked as failed at once. One
that never completes is marked as failed at the next launch. In both cases the next candidate
starts, and the bundled core is always available as a last resort. Section 6 of the specification
gives the state diagram.

### 3.2 Decoding

Decoding runs in a dedicated worker so that the camera loop is never blocked. The worker uses the
browser's `BarcodeDetector` where one exists. Otherwise it uses zxing-wasm, a WebAssembly build of
zxing-cpp, which finds several codes in one image in a few milliseconds. jsQR is the last resort.
The erasure decoder packs coefficients into 32-bit words. Decoding costs O(n²·b/32) word operations,
spread across the reception. For the largest admissible container (3,496 blocks), encoding and
decoding together take about 10 s on a desktop computer.

### 3.3 Landing

A visit to the receiver's address shows the receiver's own signed stream (`core.bin`), so that a
device holding an older receiver can obtain the current one from any screen that displays the site.
The camera is not requested until the user closes this view. The address with the fragment `#scan`,
used by GIF countdowns and as the start address of the installed application, opens the scanner
directly.

### 3.4 Presentation

The interface imitates a phosphor terminal: green (or amber) monospaced text, a boot log in place
of progress indicators, a directory listing for stored items, and dialogs answered with keys.
The QR codes themselves are always drawn black on white, as reliable decoding requires. Every
program and module is subject to a size budget (`test/budget.test.mjs`), measured after compression
because that is the form in which it crosses the channel.

## 4. Security

**Assets and adversary.** The adversary may display arbitrary frames to the receiver, replay any
frame or container ever transmitted, and interleave several streams. The adversary does not hold a
trusted private key, and cannot modify the hosted receiver or its deployment pipeline.

**Guarantees.**

1. **Code must be signed.** Code runs only if its Ed25519 signature verifies under a key fixed in
   `boot.js` at build time. The signature covers a domain prefix and the compressed body, and is
   checked before decompression.
2. **No replay or rollback.** For each id, the receiver refuses versions older than the newest it
   has accepted.
3. **Approval of new signers.** The first container of an id, or of an id from a different signer,
   requires the user's explicit approval.
4. **Sandboxed HTML.** HTML programs run in a sandboxed frame with an opaque origin, without access
   to the receiver's storage, cache or keys.
5. **Files are never executed or rendered as active content.** Images, audio and video are
   previewed in media elements; everything else can only be saved.
6. **Bounded frames.** Frames are validated against fixed bounds before any allocation proportional
   to their declared size.
7. **Trust stays in the boot program.** A core cannot alter the trusted keys, which live in
   `boot.js`.

**Non-guarantees.**

- ES modules (`mjs`) run with the receiver's privileges, by design, so that they can extend it.
- Files are authenticated by nothing but their stream identifier, which protects against
  transmission errors only.
- Replay protection is local state: clearing the site's data resets it.
- The receiver is as trustworthy as its hosting, where the keys are fixed. A shared origin such as
  `*.github.io` places other sites on the same host, and a dedicated domain is preferable.
- Key rotation currently requires a web deployment.

Vulnerabilities should be reported as described in [SECURITY.md](SECURITY.md).

## 5. Performance

Throughput is the product of the bytes per code, the codes per displayed image and the displayed
images per second, less the codes the receiver fails to decode. QR error correction duplicates the
function of the erasure code, so data frames use level L.

`test/bench.mjs` simulates a telephone camera filming a telephone screen in portrait orientation.
The screen fills 70 % of the height of a 1920 × 1080 image, with a Gaussian blur of 0.8 pixels,
reduced contrast and additive noise. The camera takes 30 images per second through a rolling
shutter with a 25 ms readout. The receiver decodes with zxing-wasm, with decoding times multiplied
by three to approximate a telephone's processor. Each configuration ran for 3 s of simulated time.

| Bytes per code | QR version | Codes per image | Images per second | Codes received per second | KB/s |
|---:|---:|---:|---:|---:|---:|
| 698 | 19 | 1 | 8 | 8.3 | 5.7 |
| 698 | 19 | 1 | 12 | 11.3 | 7.7 |
| 698 | 19 | 1 | 20 | 14.7 | 10.0 |
| 698 | 19 | 2 | 8–20 | 0 | 0 |
| 1,200 | 25 | 1–2 | 8–20 | 0 | 0 |
| 2,000 | 34 | 1–2 | 8–20 | 0 | 0 |

In this geometry the limiting factor is spatial rather than temporal resolution. Codes above
version 19, or two codes on one telephone screen, leave fewer than about three camera pixels per
module and are not decoded. The defaults are therefore one code of 700 bytes per image at 15 images
per second, which gives roughly 8–10 KB/s (a 300 KB photograph in about 35 s). This rate is eight
times that of the previous version of the receiver.

Larger codes and several codes per image become useful when the sending screen is larger or
closer; the transmission view lets the user change both. The simulation omits motion, focus and
moiré, so it is likely optimistic, and it has not yet been validated against measurements on
physical telephones.

## 6. Limitations

- **First contact** requires one installation of the receiver (Section 1).
- **Colour.** Multiplexing codes in colour channels could roughly triple capacity. It was not
  pursued, because channel separation between a screen and a camera depends on the display and on
  white balance, and failures would be total rather than gradual.
- **No return path.** The rate cannot adapt to the receiver: the sender chooses it manually.
- **Tested platforms.** The automated tests use Chromium. Safari on iOS, the principal target, has
  so far been tested only manually and only with the previous version of the receiver.
- **Size.** Containers are limited to 4 MiB, and at the rates above such a container takes minutes
  to transfer.

## 7. Operation

### 7.1 Tools

Node 20 or newer is required. `node tools/encode.mjs keygen` creates a key pair and writes the
private key to `signing-key.json`, which is ignored by git. The following command signs a program and
writes a looping GIF whose countdown leads to the receiver:

```
node tools/encode.mjs sign examples/snake.html --id snake --gif snake.gif --url https://<host>/<path>/
```

Options: `--version` (default: the current Unix time), `--block` (bytes per code, default 700),
`--fps` (default 10), `--scale` (pixels per module, default 8), `--ecc` (default L) and `--intro`
(countdown seconds, 0–9, default 5). Without `--gif`, the command prints one frame per line.

### 7.2 Deployment

`.github/workflows/deploy.yml` runs the tests and builds the receiver on every push to `main`. The
build fixes the public keys held in the repository variable `TRUSTED_KEYS`, stamps the core's version,
and signs the core into `core.bin` with the private key held in the secret `SIGNING_KEY` of the
environment `signing`. With the same key it writes looping GIFs of the receiver and of the two
examples to `gifs/` (for example `https://<owner>.github.io/<repo>/gifs/loader.gif`), each with a
countdown to the receiver's `#scan` address; the repository variable `LOADER_URL` overrides that
address. It then publishes the result to GitHub Pages. The build fails if no valid key
is configured. To build locally:

```
TRUSTED_KEYS=<public key> npm run build && npx serve dist
```

Without a signing key the local build omits `core.bin`; the receiver then cannot transmit itself, and
opens on the scanner.

### 7.3 Signing without a local key

The private key can exist solely as a GitHub secret, generated directly into it:

```
gh api -X PUT repos/OWNER/REPO/environments/signing
node tools/encode.mjs keygen - | gh secret set SIGNING_KEY --env signing -R OWNER/REPO
gh variable set TRUSTED_KEYS -R OWNER/REPO --body "<the printed public key>"
```

`.github/workflows/sign.yml` then signs any file in the repository and produces a GIF:

```
gh workflow run sign.yml -f file=examples/snake.html -f id=snake
```

Anyone able to run workflows on a branch permitted to use the `signing` environment can cause
signatures to be made. The environment should therefore be restricted to `main`, and `main` should
be protected.

### 7.4 Key rotation

Add the new public key to `TRUSTED_KEYS` and deploy. Sign with the new key. Once installed receivers
have updated, remove the old key and deploy again.

## 8. Repository

| Path | Content |
|---|---|
| `docs/PROTOCOL.md` | Normative specification; its parameter block defines the protocol identifier |
| `fountain.js` | Protocol core: frames, erasure code, containers, receiver (no DOM) |
| `boot.js`, `core.js`, `index.html` | The receiver: fixed boot program, replaceable core, minimal page |
| `decode-worker.js` | QR detection and erasure decoding off the main thread |
| `gif.js` | QR rendering, GIF encoding with countdown, GIF decoding |
| `sw.js`, `manifest.json` | Offline operation and installation |
| `tools/encode.mjs`, `tools/build.mjs` | Key generation and signing; assembly of the deployable receiver |
| `examples/` | Two programs used as payloads: Snake and Tetris |
| `test/` | Unit tests (`npm test`), budgets, browser tests (`test/e2e.mjs`) and the benchmark (`test/bench.mjs`) |
| `vendor/` | Third-party code with provenance and digests |

## 9. Third-party components

The receiver includes zxing-wasm 3.1.4 (MIT), which contains zxing-cpp (Apache-2.0); jsQR 1.4.0
(Apache-2.0); and qrcode-generator 2.0.4 (MIT). Provenance, digests and licence texts are in
[vendor/](vendor/README.md). The application icons were produced with an image-generation tool.
Such images may not be eligible for copyright, and the MIT licence applies to them only to the
extent that they are.

## Licence

[MIT](LICENSE). Contributions are governed by [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).
