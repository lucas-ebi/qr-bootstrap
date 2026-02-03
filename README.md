# QR Bootstrap

Offline fountain-code QR stream decoder with ES module execution. A PWA that reconstructs and runs arbitrary software from a QR code stream.

## Features

- **Fountain Codes (LT-style)** - Order-independent, loss-tolerant decoding
- **ES Module Execution** - Dynamically imports decoded JavaScript modules
- **PWA** - Works offline after installation
- **SHA-256 Verification** - Cryptographic integrity checking

## Quick Start

```bash
# Serve the PWA
npx serve -l 8080

# Open http://localhost:8080 on your device
```

## How It Works

1. **Scan** - Camera captures QR codes containing fountain-coded symbols
2. **Decode** - Symbols are collected in any order; Gaussian elimination reconstructs original blocks
3. **Verify** - SHA-256 hash confirms payload integrity
4. **Execute** - Verified payload is imported as ES module or navigated to as HTML

## Symbol Format

Each QR code contains a JSON object:

```json
{
  "t": "a",
  "id": "myapp",
  "kind": "mjs",
  "n": 12,
  "bs": 128,
  "len": 1450,
  "h": "sha256hex...",
  "r": 3007641763,
  "k": 2,
  "c": "base64url..."
}
```

| Field | Description |
|-------|-------------|
| `t` | Type: `"a"` for artifact |
| `id` | Artifact identifier |
| `kind` | `mjs`, `js`, `html`, or `json` |
| `n` | Total block count |
| `bs` | Block size in bytes |
| `len` | Original payload length |
| `h` | SHA-256 hash (hex) |
| `r` | PRNG seed (Mulberry32) |
| `k` | Degree (number of blocks XORed) |
| `c` | Symbol data (base64url) |

## Why Fountain Codes?

| Traditional Chunks | Fountain Codes |
|-------------------|----------------|
| Need ALL chunks | Need any N+ε symbols |
| Order matters | Order-independent |
| One miss = failure | Loss-tolerant |
| Fixed overhead | ~5-20% overhead |

## Files

- `index.html` - Main PWA with fountain decoder
- `sw.js` - Service worker for offline caching
- `manifest.json` - PWA manifest

## License

MIT
