// Test helpers: a small GIF89a parser with its own LZW decoder (independent of tools/gif.mjs),
// and jsQR loaded from the vendored UMD file (which cannot be import()ed as an ES module).
import { readFileSync } from 'node:fs';

export const jsQR = new Function('self', readFileSync(new URL('../../vendor/jsQR.js', import.meta.url), 'utf8') + '\nreturn self.jsQR;')({});

function lzwDecode(bytes, min) {
  const clear = 1 << min, eoi = clear + 1, out = [];
  let table, next, size, prev, bits = 0, cur = 0, pos = 0;
  const reset = () => { table = Array.from({ length: clear }, (_, i) => [i]); next = eoi + 1; size = min + 1; prev = null; };
  reset();
  for (;;) {
    while (bits < size && pos < bytes.length) { cur |= bytes[pos++] << bits; bits += 8; }
    if (bits < size) break;
    const code = cur & ((1 << size) - 1);
    cur >>= size;
    bits -= size;
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    const entry = code < next ? table[code] : [...prev, prev[0]];
    for (const v of entry) out.push(v);
    if (prev && next < 4096) table[next++] = [...prev, entry[0]];
    prev = entry;
    if (next === (1 << size) && size < 12) size++;
  }
  return Uint8Array.from(out);
}

// Returns { width, height, loops, palette, frames: [{ delay, pixels }] } (delay in 1/100 s).
export function parseGif(b) {
  const u16 = i => b[i] | (b[i + 1] << 8);
  if (Buffer.from(b.subarray(0, 6)).toString() !== 'GIF89a') throw new Error('not a GIF89a');
  const width = u16(6), height = u16(8), gct = b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0;
  const palette = [];
  for (let i = 0; i < gct; i += 3) palette.push([b[13 + i], b[14 + i], b[15 + i]]);
  let pos = 13 + gct, loops = false, delay = 0;
  const frames = [];
  const subBlocks = () => {
    const parts = [];
    for (let n = b[pos++]; n; n = b[pos++]) { parts.push(b.subarray(pos, pos + n)); pos += n; }
    return Buffer.concat(parts);
  };
  for (;;) {
    const kind = b[pos++];
    if (kind === 0x3B) break;
    if (kind === 0x21) {
      const label = b[pos++];
      const data = subBlocks();
      if (label === 0xF9) delay = data[1] | (data[2] << 8);
      if (label === 0xFF && data.toString('latin1').startsWith('NETSCAPE2.0') && data[11] === 1) loops = true;
    } else if (kind === 0x2C) {
      if (u16(pos + 4) !== width || u16(pos + 6) !== height || b[pos + 8] & 0x80) throw new Error('unexpected image descriptor');
      const min = b[pos + 9];
      pos += 10;
      frames.push({ delay, pixels: lzwDecode(subBlocks(), min) });
    } else throw new Error('unexpected block 0x' + kind.toString(16));
  }
  return { width, height, loops, palette, frames };
}

// Decodes a QR code from palette-index pixels (0 = white, 1 = black).
export function readQr(pixels, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i++) rgba.set(pixels[i] ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  return jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' })?.data;
}
