// Turns QB1 frame strings into a standalone animated GIF of QR codes (black/white, loops forever),
// optionally preceded by a countdown intro: QR codes of the loader's URL with a film-leader style
// digit in the middle, so a phone's native camera can open the web app before the data starts.
// Uses the vendored qrcode-generator for the QR matrices; the GIF encoder is ~50 lines below.
import qrcode from './vendor/qrcode.mjs';

const QUIET = 4; // quiet-zone width in modules, as the QR spec asks

// Draws every frame as a QR code at the same QR version, so all GIF frames share one size.
// Returns { width, height, frames: Uint8Array[] } with pixel values 0 = white, 1 = black.
export function renderFrames(texts, { scale = 8, ecc = 'M' } = {}) {
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
  const u16 = n => [n & 255, n >> 8];
  const out = [
    ...Buffer.from('GIF89a'), ...u16(width), ...u16(height), 0x90, 0, 0, // 2-colour global table
    255, 255, 255, 0, 0, 0,                                              // white, black
    0x21, 0xFF, 0x0B, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0,      // loop forever
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
