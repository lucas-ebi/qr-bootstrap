// QR frames as a standalone animated GIF (black/white, loops forever), optionally preceded by a
// film-leader countdown of QR codes pointing at the loader's URL; and a minimal GIF decoder, so the
// loader can read such a file without a camera. Browser and Node alike; QR matrices come from the
// vendored qrcode-generator.
import qrcode from './vendor/qrcode.mjs';

const QUIET = 4; // quiet-zone width in modules, as the QR spec asks

// Draws every frame as a QR code at the same QR version, so all GIF frames share one size.
// Returns { width, height, frames: Uint8Array[] } with pixel values 0 = white, 1 = black.
export function renderFrames(texts, { scale = 8, ecc = 'L' } = {}) {
  const make = (text, version) => {
    const q = qrcode(version, ecc);
    q.addData(text, 'Alphanumeric');
    q.make();
    return q;
  };
  const version = Math.max(...texts.map(t => (make(t, 0).getModuleCount() - 17) / 4));
  const modules = 17 + 4 * version, side = (modules + 2 * QUIET) * scale;
  const frames = texts.map(text => {
    const q = make(text, version), px = new Uint8Array(side * side);
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (!q.isDark(r, c)) continue;
        for (let y = (r + QUIET) * scale; y < (r + QUIET + 1) * scale; y++) {
          px.fill(1, y * side + (c + QUIET) * scale, y * side + (c + QUIET + 1) * scale);
        }
      }
    }
    return px;
  });
  return { width: side, height: side, frames, version };
}

// 5x7 digits for the countdown counter, one string per row.
const GLYPH = [
  ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
];

// A QR code of `url` with a countdown counter (a white disc with a black ring and a digit) over its
// centre, drawn on a side x side canvas. Error correction level H tolerates the covered centre.
// Returns one frame per digit in `digits`, e.g. [5, 4, 3, 2, 1].
export function renderIntro(url, digits, side, { ecc = 'H' } = {}) {
  const q = qrcode(0, ecc);
  q.addData(url);
  q.make();
  const modules = q.getModuleCount(), k = Math.floor(side / (modules + 2 * QUIET)), off = Math.floor((side - modules * k) / 2);
  if (k < 2) throw new Error('the loader URL is too long for the QR size; raise --scale');
  const base = new Uint8Array(side * side);
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (!q.isDark(r, c)) continue;
      for (let y = off + r * k; y < off + (r + 1) * k; y++) base.fill(1, y * side + off + c * k, y * side + off + (c + 1) * k);
    }
  }
  const cx = side / 2, cy = side / 2, R = Math.round(modules * k * 0.11), ring = Math.max(2, Math.round(R / 8));
  const scale = Math.max(1, Math.floor(R / 7)), gw = 5 * scale, gh = 7 * scale;
  return digits.map(digit => {
    const px = base.slice();
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= R) px[y * side + x] = d > R - ring ? 1 : 0;
      }
    }
    const [x0, y0] = [Math.round(cx - gw / 2), Math.round(cy - gh / 2)];
    GLYPH[digit].forEach((row, gy) => {
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] !== '#') continue;
        for (let y = 0; y < scale; y++) px.fill(1, (y0 + gy * scale + y) * side + x0 + gx * scale, (y0 + gy * scale + y) * side + x0 + (gx + 1) * scale);
      }
    });
    return px;
  });
}

// GIF flavour of LZW with a 2-colour palette (minimum code size 2), following the usual
// encoder/decoder "timing" for growing the code size.
function lzw(pixels) {
  const min = 2, clear = 1 << min, eoi = clear + 1, out = [];
  let next = eoi + 1, size = min + 1, table = new Map(), cur = 0, bits = 0;
  const emit = code => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; }
  };
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i], key = (prefix << 8) | k, hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = eoi + 1;
      size = min + 1;
    } else {
      if (next >= (1 << size)) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return out;
}

// delay is in hundredths of a second per frame; delays[i], when given, overrides it for frame i.
export function encodeGif({ width, height, frames }, { delay = 17, delays = [] } = {}) {
  const u16 = n => [n & 255, n >> 8], ascii = s => [...s].map(c => c.charCodeAt(0));
  const out = [
    ...ascii('GIF89a'), ...u16(width), ...u16(height), 0x90, 0, 0, // 2-colour global table
    255, 255, 255, 0, 0, 0,                                              // white, black
    0x21, 0xFF, 0x0B, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0,      // loop forever
  ];
  for (const [i, px] of frames.entries()) {
    out.push(0x21, 0xF9, 4, 0x04, ...u16(delays[i] ?? delay), 0, 0);     // frame delay
    out.push(0x2C, 0, 0, 0, 0, ...u16(width), ...u16(height), 0, 2);     // full-size image, LZW min size 2
    const data = lzw(px);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3B);
  return Uint8Array.from(out);
}

function unlzw(bytes, min, size) {
  const clear = 1 << min, out = new Uint8Array(size), pre = new Int32Array(4096), suf = new Uint8Array(4096), len = new Uint16Array(4096);
  let next, bits, prev = -1, o = 0, cur = 0, have = 0;
  for (let i = 0; i < clear; i++) [pre[i], suf[i], len[i]] = [-1, i, 1];
  const reset = () => { next = clear + 2; bits = min + 1; prev = -1; };
  const first = c => { while (pre[c] >= 0) c = pre[c]; return suf[c]; };
  const put = c => { // writes the string for code c
    const l = len[c];
    for (let i = l - 1, k = c; i >= 0; i--, k = pre[k]) if (o + i < size) out[o + i] = suf[k];
    o += l;
  };
  reset();
  for (let p = 0; ;) {
    while (have < bits && p < bytes.length) { cur |= bytes[p++] << have; have += 8; }
    if (have < bits) break;
    const c = cur & ((1 << bits) - 1);
    cur >>>= bits;
    have -= bits;
    if (c === clear) { reset(); continue; }
    if (c === clear + 1 || o >= size) break;
    if (prev >= 0 && next < 4096) {
      [pre[next], suf[next], len[next]] = [prev, first(c < next ? c : prev), len[prev] + 1];
      next++;
      if (next === 1 << bits && bits < 12) bits++;
    }
    if (c >= next) throw new Error('bad GIF data');
    put(c);
    prev = c;
  }
  return out;
}

// Decodes a GIF into full-canvas frames of palette indices: { width, height, palette, frames }.
// Enough for the loader's own files and other simple GIFs; transparency is not composited.
export function decodeGif(b) {
  const u16 = i => b[i] | (b[i + 1] << 8), ct = f => f & 0x80 ? 3 << ((f & 7) + 1) : 0;
  if (String.fromCharCode(...b.subarray(0, 3)) !== 'GIF') throw new Error('not a GIF');
  const width = u16(6), height = u16(8), gct = ct(b[10]), palette = b.slice(13, 13 + gct);
  const frames = [], canvas = new Uint8Array(width * height);
  let p = 13 + gct;
  const blocks = () => {
    const parts = [];
    for (let n = b[p++]; n; n = b[p++]) parts.push(b.subarray(p, p += n));
    const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    parts.reduce((o, x) => (out.set(x, o), o + x.length), 0);
    return out;
  };
  while (p < b.length) {
    const kind = b[p++];
    if (kind === 0x21) { p++; blocks(); }
    else if (kind === 0x2C) {
      const [x, y, w, h, f] = [u16(p), u16(p + 2), u16(p + 4), u16(p + 6), b[p + 8]];
      p += 9 + ct(f);
      if (f & 0x40) throw new Error('interlaced GIFs are not supported');
      const min = b[p++], px = unlzw(blocks(), min, w * h);
      for (let r = 0; r < h && y + r < height; r++) canvas.set(px.subarray(r * w, r * w + Math.min(w, width - x)), (y + r) * width + x);
      frames.push(canvas.slice());
    } else break;
  }
  return { width, height, palette, frames };
}
