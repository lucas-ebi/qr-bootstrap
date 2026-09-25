// QB1 protocol core: dense GF(2) fountain code, base45 framing, signed container.
// Pure ES module (no DOM) so the browser loader and the Node tools/tests share it.

export const MAX_N = 256;        // blocks per stream
export const MAX_LEN = 1 << 18;  // container bytes
export const MAX_B = 1500;       // bytes per block

// ---- PRNG ------------------------------------------------------------------

export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// Coefficient vector of a symbol: block j is included iff bit j is set (p = 1/2).
export function mask(seed, n) {
  const rng = mulberry32(seed), m = new Uint8Array(n);
  for (let j = 0, w = 0; j < n; j++) {
    if (j % 32 === 0) w = rng();
    m[j] = (w >>> (j % 32)) & 1;
  }
  return m;
}

export function xor(a, b) {
  for (let i = 0; i < a.length; i++) a[i] ^= b[i];
  return a;
}

// ---- Base45 (RFC 9285): 2 bytes -> 3 chars, all in the QR alphanumeric set --

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function b45encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const v = bytes[i] * 256 + bytes[i + 1];
      s += B45[v % 45] + B45[Math.floor(v / 45) % 45] + B45[Math.floor(v / 2025)];
    } else {
      s += B45[bytes[i] % 45] + B45[Math.floor(bytes[i] / 45)];
    }
  }
  return s;
}

export function b45decode(s) {
  const v = [...s].map(c => B45.indexOf(c));
  if (v.includes(-1) || s.length % 3 === 1) throw new Error('bad base45');
  const out = [];
  for (let i = 0; i < v.length; i += 3) {
    if (i + 2 < v.length) {
      const n = v[i] + v[i + 1] * 45 + v[i + 2] * 2025;
      if (n > 65535) throw new Error('bad base45');
      out.push(n >> 8, n & 255);
    } else {
      const n = v[i] + v[i + 1] * 45;
      if (n > 255) throw new Error('bad base45');
      out.push(n);
    }
  }
  return Uint8Array.from(out);
}

export function b64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// ---- Frame: QB1/<streamId>/<n>/<len>/<seed>/<base45 block> -------------------

const FRAME = /QB1\/([0-9A-F]{16})\/(\d+)\/(\d+)\/(\d+)\/([\s\S]+)$/;

// Returns a validated frame or null. Everything is bounded before any allocation.
export function parseFrame(raw) {
  const m = FRAME.exec(raw);
  if (!m) return null;
  const [n, len, seed] = [+m[2], +m[3], +m[4]];
  if (!(n >= 1 && n <= MAX_N && len > 64 && len <= MAX_LEN && n <= len && seed <= 0xFFFFFFFF)) return null;
  const b = Math.ceil(len / n);
  if (b > MAX_B) return null;
  let data;
  try { data = b45decode(m[5]); } catch { return null; }
  return data.length === b ? { id: m[1], n, len, seed, data } : null;
}

export function frame(id, n, len, seed, data) {
  return `QB1/${id}/${n}/${len}/${seed}/${b45encode(data)}`;
}

// ---- Decoder: incremental Gaussian elimination over GF(2) --------------------

export class Decoder {
  constructor(n, len) {
    this.n = n;
    this.len = len;
    this.b = Math.ceil(len / n);
    this.rows = new Array(n).fill(null); // rows[j] has its leading 1 at column j
    this.rank = 0;
    this.seen = new Set();
  }

  // Returns true once all n blocks are determined.
  add(seed, data) {
    if (this.rank < this.n && !this.seen.has(seed) && data.length === this.b) {
      this.seen.add(seed);
      const c = mask(seed, this.n), d = data.slice();
      for (let j = 0; j < this.n; j++) {
        if (!c[j]) continue;
        const r = this.rows[j];
        if (!r) { this.rows[j] = { c, d }; this.rank++; break; }
        xor(c, r.c);
        xor(d, r.d);
      }
    }
    return this.rank === this.n;
  }

  // Back-substitute and return the original bytes (trimmed to len).
  solve() {
    const { n, b } = this, out = new Uint8Array(n * b);
    for (let j = n - 1; j >= 0; j--) {
      const { c, d } = this.rows[j];
      for (let k = j + 1; k < n; k++) if (c[k]) xor(d, out.subarray(k * b, (k + 1) * b));
      out.set(d, j * b);
    }
    return out.subarray(0, this.len);
  }
}

// ---- Container: Ed25519 signature (64 B) || deflate-raw("<type> <id>\n" + payload)

async function pipe(bytes, transform) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());
}

export const inflate = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));

export const importKey = b64 => crypto.subtle.importKey('raw', b64url(b64), 'Ed25519', false, ['verify']);

export async function streamId(container) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', container));
  return [...h.subarray(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Verifies the signature against any trusted key, then decompresses. Throws on failure.
export async function open(container, keys) {
  const sig = container.subarray(0, 64), body = container.subarray(64);
  let ok = false;
  for (const k of keys) if (await crypto.subtle.verify('Ed25519', k, sig, body)) { ok = true; break; }
  if (!ok) throw new Error(keys.length ? 'bad signature' : 'no trusted key');
  const raw = await inflate(body), nl = raw.indexOf(10);
  const [type, id] = nl < 0 ? [] : new TextDecoder().decode(raw.subarray(0, nl)).split(' ');
  if (!type || !id) throw new Error('malformed container');
  return { type, id, payload: raw.subarray(nl + 1) };
}

// ---- Receiver: many interleaved streams, each completed and opened exactly once

export class Receiver {
  constructor(keys, maxStreams = 8) {
    this.keys = keys;
    this.maxStreams = maxStreams;
    this.streams = new Map(); // streamId -> Decoder
    this.closed = new Map();  // streamId -> ignore-until (ms); Infinity once opened
  }

  // Feed one scanned string. Returns null (ignored), {id, rank, n} (progress),
  // {id, rank, n, opened} (done) or {id, rank, n, error}.
  async push(raw) {
    const f = parseFrame(raw);
    if (!f || Date.now() < (this.closed.get(f.id) ?? 0)) return null;

    let d = this.streams.get(f.id);
    if (!d) {
      if (this.streams.size >= this.maxStreams) this.streams.delete(this.streams.keys().next().value);
      this.streams.set(f.id, d = new Decoder(f.n, f.len));
    } else if (d.n !== f.n || d.len !== f.len) return null;

    const progress = { id: f.id, n: d.n };
    if (!d.add(f.seed, f.data)) return { ...progress, rank: d.rank };

    // Complete: close the stream synchronously so concurrent pushes cannot re-open it.
    this.streams.delete(f.id);
    this.closed.set(f.id, Infinity);
    try {
      const container = d.solve();
      if (await streamId(container) !== f.id) throw new Error('corrupt stream');
      return { ...progress, rank: d.n, opened: await open(container, this.keys) };
    } catch (e) {
      this.closed.set(f.id, Date.now() + 5000); // allow a retry shortly
      return { ...progress, rank: d.n, error: e.message };
    }
  }
}
