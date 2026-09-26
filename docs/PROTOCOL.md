# QR Bootstrap transfer protocol

## Status of this document

This document specifies the frame format, the erasure code and the container formats used by QR
Bootstrap to move data over a one-way optical channel, from a display to a camera. The key words
MUST, MUST NOT, SHOULD and MAY are to be interpreted as described in RFC 2119.

The normative parameters are collected in the parameter block of Section 2. The *protocol
identifier* is derived from that block, so any change to it yields a new identifier and receivers
implementing a different revision ignore the frames instead of misreading them.

## 1. Overview

A sender holds a *container*, a byte string of at most 4 MiB. It splits the container into n
source blocks of equal length b (the last one zero-padded) and emits an unbounded sequence of
*symbols*, each the exclusive-or of a pseudo-random subset of the source blocks. Each symbol is
serialised as one *frame*, a string in the QR alphanumeric character set, and displayed as one QR
code. A receiver that collects any n linearly independent symbols, in any order, reconstructs the
container by Gaussian elimination over GF(2). With subsets drawn uniformly, n + 2 symbols suffice
on average, independently of which frames were lost.

```
 container ──► n blocks ──► symbol(seed) = XOR of blocks selected by mask(seed)
                                 │
                                 ▼
 frame = PROTOCOL / stream-id / n / len / seed / base45(symbol) ──► QR code ──► display
```

The channel offers no acknowledgement. Throughput is therefore governed by the product of the
bytes per code, the codes per displayed image and the image rate, less the fraction of codes the
receiver fails to decode. Error correction at the QR level is redundant with the erasure code, and
senders SHOULD use QR error-correction level L for data frames.

## 2. Parameters

The protocol identifier is the first four bytes of the SHA-256 digest of the text between the
two marker lines below (excluding the markers and the line breaks that follow them), written as
eight upper-case hexadecimal digits. The current value is recorded as `PROTOCOL` in `fountain.js`,
and the test suite recomputes it from this file.

<!-- parameters:begin -->
```text
frame     = protocol "/" stream-id "/" n "/" len "/" seed "/" symbol
protocol  = 8HEXDIGIT                  ; upper case; derived from this block
stream-id = 16HEXDIGIT                 ; upper case; first 8 bytes of SHA-256(container)
n         = 1*4DIGIT                   ; number of source blocks, 1 <= n <= 4096
len       = 1*7DIGIT                   ; container length, 2 <= len <= 4194304, n <= len
seed      = 1*10DIGIT                  ; 0 <= seed <= 4294967295
symbol    = base45(b bytes)            ; RFC 9285; b = ceil(len / n) <= 2900

prng      = mulberry32(seed)           ; 32-bit state, outputs unsigned 32-bit words
mask      : word i of the mask is the (i+1)-th prng output, i = 0 .. ceil(n / 32) - 1;
            block j is selected iff bit (j mod 32) of word floor(j / 32) is set; j < n
symbol    = XOR of the selected source blocks; block j = container[j*b .. j*b + b), zero-padded

container = tag body
tag 0x01  : code. body = signature(64) || deflate-raw(header "\n" payload)
            header = type " " id " " version ; type in {mjs, html, json}; id = 1*[A-Za-z0-9_.-]
            version = 1*15DIGIT ; signature = Ed25519 over "qr-bootstrap code" 0x00 || deflated part
tag 0x02  : file, compressed. body = deflate-raw(meta "\n" bytes)
tag 0x03  : file, stored. body = meta "\n" bytes
            meta = mime " " percent-encoded(name)
```
<!-- parameters:end -->

The mulberry32 generator is defined as follows, with all arithmetic on 32-bit integers:

```
state = state + 0x6D2B79F5
t = imul(state xor (state >>> 15), state or 1)
t = (t + imul(t xor (t >>> 7), t or 61)) xor t
output (t xor (t >>> 14)) as unsigned
```

## 3. Frames

A receiver MUST reject a frame that does not match the grammar, whose protocol field differs from
its own identifier, whose numeric fields fall outside the stated bounds, or whose symbol does not
decode to exactly b bytes. These checks MUST precede any allocation proportional to n or len.

Frames of a stream are interchangeable. A sender SHOULD begin at a random seed, so that two
senders displaying the same container at once contribute distinct symbols. A receiver MUST ignore
a frame whose n or len disagrees with earlier frames of the same stream identifier.

## 4. Decoding

The receiver maintains, per stream, a matrix in row-echelon form in which row j, when present, has
its lowest set coefficient at column j. An arriving symbol is reduced against the existing rows. If
a non-zero coefficient remains at a column without a row, the reduced symbol becomes that row;
otherwise the symbol is linearly dependent and is discarded. When all n rows are present,
back-substitution yields the source blocks. The receiver MUST then verify that the first eight bytes
of SHA-256 over the reconstructed container equal the stream identifier.

The cost is O(n²·b / 32) word operations per stream. For the limits above it stays within a few
seconds on a current telephone, spread over the reception.

## 5. Containers

**Code (tag 0x01).** The signature MUST verify under one of the receiver's trusted Ed25519 keys
before the body is decompressed. The domain prefix `qr-bootstrap code\0` prevents a signature
from being valid in any other context. A receiver MUST NOT execute a container whose version is
lower than the highest version it has executed for the same id, and SHOULD ask the user before
executing an id or signer it has not seen before. The id `loader` is reserved for the receiver's
own program (Section 6).

**File (tags 0x02 and 0x03).** Files carry no signature and MUST NOT be executed or rendered as
active content. A receiver MAY preview image, audio and video types in media elements, and MUST
offer every other type only for saving. Integrity against transmission error is provided by the
stream identifier; authenticity is not provided.

## 6. Self-update

A receiver consists of a fixed *boot* program, which holds the trusted keys, and a replaceable
*core*. A code container with id `loader` and type `mjs` carries a core. A deployment MAY publish the
container of its bundled core, byte for byte as it would be transmitted, as the file `core.bin`,
so that receivers can retransmit themselves. The boot program stores
the newest verified core, and on start executes the highest version not marked as failed. It marks
a version as failed when the core throws while starting, or when a previous start did not report
readiness. The trusted keys can therefore not be changed by a core.

```
 start ──► candidates: stored core (verified), bundled core
             │  highest version not marked failed
             ▼
          pending := version ──► import ──► start(boot) ──► ready(): pending := none
             │ throws                              │ never reports
             ▼                                     ▼
          mark failed, next candidate        next launch: mark failed
```

## 7. Test vectors

`mask(12345, 64)`, as a bit string for j = 0 .. 63:

```
1010001100011110111100110101111100000000100010101110000101110010
```

Base45 (RFC 9285): `ietf!` → `QED8WEX0`, `base-45` → `UJCLQE7W581`.
