// Protocol core (docs/PROTOCOL.md): dense GF(2) fountain code, base45 framing, containers.
// Pure ES module without DOM access, shared by the loader, the worker, the tools and the tests.

// First 32 bits of SHA-256 over the parameter block of docs/PROTOCOL.md (checked by the tests).
export const PROTOCOL = 'CB79D2AC';
export const MAX_N = 4096, MAX_LEN = 1 << 22, MAX_B = 2900;
export const CODE = 1, FILE = 2, FILE_STORED = 3; // container tags

// ---- PRNG and coefficient masks --------------------------------------------

export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// Block j is in symbol `seed` iff bit j%32 of word j/32 is set; bits beyond n are cleared.
export function maskWords(seed, n) {
  const rng = mulberry32(seed), w = new Uint32Array((n + 31) >>> 5);
  for (let i = 0; i < w.length; i++) w[i] = rng();
  if (n & 31) w[w.length - 1] &= (1 << (n & 31)) - 1;
  return w;
}

export const mask = (seed, n, w = maskWords(seed, n)) => Uint8Array.from({ length: n }, (_, j) => (w[j >>> 5] >>> (j & 31)) & 1);

export function xor(a, b) {
  for (let i = 0; i < a.length; i++) a[i] ^= b[i];
  return a;
}

// ---- Base45 (RFC 9285): 2 bytes -> 3 characters of the QR alphanumeric set ---

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function b45encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 2) {
    let v = bytes[i];
    if (i + 1 < bytes.length) v = v * 256 + bytes[i + 1], s += B45[v % 45] + B45[(v / 45 | 0) % 45] + B45[v / 2025 | 0];
    else s += B45[v % 45] + B45[v / 45 | 0];
  }
  return s;
}

export function b45decode(s) {
  if (s.length % 3 === 1) throw new Error('bad base45');
  const out = new Uint8Array(Math.floor(s.length / 3) * 2 + (s.length % 3 ? 1 : 0));
  for (let i = 0, o = 0; i < s.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map(k => i + k < s.length ? B45.indexOf(s[i + k]) : 0);
    const v = a + b * 45 + c * 2025;
    if (a < 0 || b < 0 || c < 0 || v > (i + 2 < s.length ? 65535 : 255)) throw new Error('bad base45');
    if (i + 2 < s.length) out[o++] = v >> 8;
    out[o++] = v & 255;
  }
  return out;
}

export function b64url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

// ---- Frames: <protocol>/<stream id>/<n>/<len>/<seed>/<base45 symbol> ---------

const FRAME = new RegExp(`^${PROTOCOL}/([0-9A-F]{16})/(\\d{1,4})/(\\d{1,7})/(\\d{1,10})/([0-9A-Z $%*+./:-]+)$`);

// Returns { id, n, len, seed, data } or null. Everything is bounded before allocation.
export function parseFrame(raw) {
  const m = FRAME.exec(raw);
  if (!m) return null;
  const [n, len, seed] = [+m[2], +m[3], +m[4]], b = Math.ceil(len / n);
  if (!(n >= 1 && n <= MAX_N && len >= 2 && len <= MAX_LEN && n <= len && b <= MAX_B && seed <= 0xFFFFFFFF)) return null;
  if (m[5].length !== Math.floor(b / 2) * 3 + (b % 2) * 2) return null;
  try { return { id: m[1], n, len, seed, data: b45decode(m[5]) }; } catch { return null; }
}

export const frame = (id, n, len, seed, data) => `${PROTOCOL}/${id}/${n}/${len}/${seed}/${b45encode(data)}`;

// Symbols are XORs of 32-bit words; blocks are padded to a multiple of 4 bytes internally.
const words = (bytes, w) => { const u = new Uint8Array(w * 4); u.set(bytes); return new Uint32Array(u.buffer); };

export async function streamId(container) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', container));
  return [...h.subarray(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Splits a container into n blocks of about `block` bytes; frame(seed) returns symbol `seed`.
export async function encoder(container, block = 1200) {
  const len = container.length, n = Math.ceil(len / block), b = Math.ceil(len / n), w = (b + 3) >>> 2;
  if (len < 2 || len > MAX_LEN || n > MAX_N || b > MAX_B) {
    throw new Error(`container is ${len} B (${n} blocks of ${b} B); limits are ${MAX_LEN} B, ${MAX_N} blocks, ${MAX_B} B/block`);
  }
  const data = new Uint32Array(n * w), id = await streamId(container);
  for (let j = 0; j < n; j++) data.set(words(container.subarray(j * b, (j + 1) * b), w), j * w);
  return {
    id, n, b, len,
    frame(seed) {
      const m = maskWords(seed, n), s = new Uint32Array(w);
      for (let j = 0; j < n; j++) {
        if (!((m[j >>> 5] >>> (j & 31)) & 1)) continue;
        for (let k = 0, o = j * w; k < w; k++) s[k] ^= data[o + k];
      }
      return frame(id, n, len, seed, new Uint8Array(s.buffer, 0, b));
    },
  };
}

// ---- Decoder: incremental Gaussian elimination over GF(2) --------------------

const low = (c, from) => { // index of the lowest set bit at or after word `from`, or -1
  for (let i = from; i < c.length; i++) if (c[i]) return i * 32 + 31 - Math.clz32(c[i] & -c[i]);
  return -1;
};

export class Decoder {
  constructor(n, len) {
    Object.assign(this, { n, len, b: Math.ceil(len / n), rank: 0, rows: new Array(n), seen: new Set() });
    this.w = (this.b + 3) >>> 2;
  }

  // Adds symbol `seed`; returns true once all n blocks are determined.
  add(seed, data) {
    if (this.rank < this.n && !this.seen.has(seed) && data.length === this.b) {
      this.seen.add(seed);
      const c = maskWords(seed, this.n), d = words(data, this.w);
      for (let j = low(c, 0); j >= 0; j = low(c, j >>> 5)) {
        const r = this.rows[j];
        if (!r) { this.rows[j] = { c, d }; this.rank++; break; }
        xor(c, r.c);
        xor(d, r.d);
      }
    }
    return this.rank === this.n;
  }

  // Back-substitution; returns the original bytes.
  solve() {
    const { n, w } = this, out = new Uint32Array(n * w);
    for (let j = n - 1; j >= 0; j--) {
      const { c, d } = this.rows[j];
      for (let k = low(c, (j + 1) >>> 5); k >= 0; k = low(c, (k >>> 5))) {
        if (k > j) xor(d, out.subarray(k * w, (k + 1) * w));
        c[k >>> 5] &= ~(1 << (k & 31));
      }
      out.set(d, j * w);
    }
    const bytes = new Uint8Array(out.buffer), res = new Uint8Array(this.len);
    for (let j = 0; j < n; j++) res.set(bytes.subarray(j * w * 4, j * w * 4 + Math.min(this.b, this.len - j * this.b)), j * this.b);
    return res;
  }
}

// ---- Containers -----------------------------------------------------------
// CODE: 0x01 || Ed25519 sig (64 B) || deflate-raw("<type> <id> <version>\n" payload), signed over
//       DOMAIN || the deflated part.   FILE: 0x02 || deflate-raw(meta) and FILE_STORED: 0x03 || meta,
//       where meta = "<mime> <percent-encoded name>\n" bytes. Files are data; they are never run.

export const DOMAIN = new TextEncoder().encode('qr-bootstrap code\0');

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
};

const pipe = async (bytes, t) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(t)).arrayBuffer());
export const deflate = bytes => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflate = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));

const line = raw => {
  const nl = raw.indexOf(10);
  if (nl < 0) throw new Error('malformed container');
  return [new TextDecoder().decode(raw.subarray(0, nl)).split(' '), raw.subarray(nl + 1)];
};

// A trusted key plus a short fingerprint (its first 8 base64url characters) to show people.
export async function loadKey(b64) {
  return { fp: b64.slice(0, 8), key: await crypto.subtle.importKey('raw', b64url(b64), 'Ed25519', false, ['verify']) };
}

// Verifies a CODE container against any trusted key, then decompresses. Throws on failure.
export async function open(container, keys) {
  if (container[0] !== CODE) throw new Error('not a code container');
  const sig = container.subarray(1, 65), body = container.subarray(65);
  let signer;
  for (const k of keys) if (await crypto.subtle.verify('Ed25519', k.key, sig, concat(DOMAIN, body))) { signer = k.fp; break; }
  if (!signer) throw new Error(keys.length ? 'bad signature' : 'no trusted key');
  const [[type, id, v], payload] = line(await inflate(body));
  if (!type || !id || !/^\d{1,15}$/.test(v)) throw new Error('malformed container');
  return { type, id, version: +v, payload, signer };
}

export async function packFile(name, mime, bytes) {
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = 'application/octet-stream';
  const meta = concat(new TextEncoder().encode(`${mime} ${encodeURIComponent(name)}\n`), bytes), z = await deflate(meta);
  return z.length < meta.length ? concat([FILE], z) : concat([FILE_STORED], meta);
}

export async function openFile(container) {
  const tag = container[0];
  if (tag !== FILE && tag !== FILE_STORED) throw new Error('not a file container');
  const [[mime, name], bytes] = line(tag === FILE ? await inflate(container.subarray(1)) : container.subarray(1));
  return { mime, name: decodeURIComponent(name || 'file'), bytes };
}

// ---- Receiver: interleaved streams, each completed and opened exactly once ------

export class Receiver {
  // keys: [{ fp, key }] from loadKey. accept(opened) may throw to refuse verified code.
  constructor(keys, { accept, maxStreams = 8 } = {}) {
    Object.assign(this, { keys, accept, maxStreams, streams: new Map(), closed: new Map() });
  }

  hold(id, ms) { this.closed.set(id, Date.now() + ms); }

  // Feeds one scanned string. Returns null (ignored), { id, rank, n } (progress), or with
  // `container` and `opened` (code) or `file`, or with `error`.
  async push(raw) {
    const f = parseFrame(raw);
    if (!f || Date.now() < (this.closed.get(f.id) ?? 0)) return null;
    let d = this.streams.get(f.id);
    if (!d) {
      if (this.streams.size >= this.maxStreams) this.streams.delete(this.streams.keys().next().value);
      this.streams.set(f.id, d = new Decoder(f.n, f.len));
    } else if (d.n !== f.n || d.len !== f.len) return null;
    const progress = { id: f.id, n: d.n, len: d.len };
    if (!d.add(f.seed, f.data)) return { ...progress, rank: d.rank };

    this.streams.delete(f.id); // closed synchronously, so concurrent pushes cannot re-open it
    this.closed.set(f.id, Infinity);
    try {
      const container = d.solve();
      if (await streamId(container) !== f.id) throw new Error('corrupt stream');
      if (container[0] !== CODE) return { ...progress, rank: d.n, container, file: await openFile(container) };
      const opened = await open(container, this.keys);
      await this.accept?.(opened);
      return { ...progress, rank: d.n, container, opened };
    } catch (e) {
      this.closed.set(f.id, Date.now() + 5000);
      return { ...progress, rank: d.n, error: e.message };
    }
  }
}
