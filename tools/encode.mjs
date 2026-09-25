#!/usr/bin/env node
// Signs a payload and turns it into an endless-ish stream of QB1 frames.
//
//   node tools/encode.mjs keygen [signing-key.json]
//   node tools/encode.mjs sign <file> --id <name> [--type mjs|html|json] [--key signing-key.json]
//                              [--block 200] [--frames N] [--html player.html]
//
// `sign` prints one frame per line, or writes a self-contained animated-QR player with --html.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { MAX_B, MAX_LEN, MAX_N, frame, mask, xor } from '../fountain.js';

const TYPES = ['mjs', 'html', 'json'];
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const concat = (...parts) => Uint8Array.from(Buffer.concat(parts));

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Returns { jwk, publicKey } where publicKey is the base64url string to pin in index.html.
export async function keygen() {
  const { privateKey } = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return { jwk, publicKey: jwk.x };
}

// container = signature (64 B) || deflate-raw("<type> <id>\n" + payload), signed over the compressed part
export async function seal(jwk, { type, id, payload }) {
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES}`);
  if (!/^[\w.-]+$/.test(id)) throw new Error('id may only contain letters, digits, _ . -');
  const key = await crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign']);
  const body = await deflate(concat(Buffer.from(`${type} ${id}\n`), payload));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, body));
  return concat(sig, body);
}

// Fresh random-subset symbols for seeds 1..count. Any n+2 or so distinct ones decode.
export function makeFrames(container, { block = 200, count } = {}) {
  const len = container.length, n = Math.ceil(len / block), b = Math.ceil(len / n);
  if (len > MAX_LEN || n > MAX_N || b > MAX_B) {
    throw new Error(`container is ${len} B (${n} blocks of ${b} B); limits are ${MAX_LEN} B, ${MAX_N} blocks, ${MAX_B} B/block`);
  }
  const padded = new Uint8Array(n * b);
  padded.set(container);
  const id = createHash('sha256').update(container).digest('hex').slice(0, 16).toUpperCase();
  count ??= Math.ceil(n * 1.5) + 8;
  const out = [];
  for (let seed = 1; seed <= count; seed++) {
    const m = mask(seed, n), sym = new Uint8Array(b);
    for (let j = 0; j < n; j++) if (m[j]) xor(sym, padded.subarray(j * b, (j + 1) * b));
    out.push(frame(id, n, len, seed, sym));
  }
  return { id, n, b, len, frames: out };
}

const PLAYER = frames => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QB1 player</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;font:14px system-ui,sans-serif;color:#555}
canvas{width:min(90vw,90vh - 40px);height:auto;image-rendering:pixelated}p{margin:0;text-align:center}</style></head>
<body><div><canvas id="c"></canvas><p id="s"></p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<script>
const frames = ${JSON.stringify(frames)};
const fps = +new URLSearchParams(location.search).get('fps') || 6;
const c = document.getElementById('c'), s = document.getElementById('s');
let i = 0;
function show() {
  const qr = qrcode(0, 'M'); qr.addData(frames[i], 'Alphanumeric'); qr.make();
  const m = qr.getModuleCount(), q = 4, px = 8, ctx = c.getContext('2d');
  c.width = c.height = (m + 2 * q) * px;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#000';
  for (let r = 0; r < m; r++) for (let k = 0; k < m; k++) if (qr.isDark(r, k)) ctx.fillRect((k + q) * px, (r + q) * px, px, px);
  s.textContent = (i + 1) + ' / ' + frames.length + '  (?fps=N to change speed)';
  i = (i + 1) % frames.length;
}
show(); setInterval(show, 1000 / fps);
</script></body></html>
`;

async function main([cmd, ...argv]) {
  const opt = {}, pos = [];
  for (let i = 0; i < argv.length; i++) argv[i].startsWith('--') ? opt[argv[i].slice(2)] = argv[++i] : pos.push(argv[i]);

  if (cmd === 'keygen') {
    const file = pos[0] ?? 'signing-key.json', { jwk, publicKey } = await keygen();
    await writeFile(file, JSON.stringify(jwk), { mode: 0o600 });
    console.log(`Private key written to ${file} (keep it secret, it is gitignored).`);
    console.log(`Pin this public key in index.html -> TRUSTED_KEYS:\n  '${publicKey}'`);
  } else if (cmd === 'sign' && pos[0] && opt.id) {
    const jwk = JSON.parse(await readFile(opt.key ?? 'signing-key.json', 'utf8'));
    const type = opt.type ?? pos[0].split('.').pop();
    const container = await seal(jwk, { type, id: opt.id, payload: await readFile(pos[0]) });
    const { id, n, b, len, frames } = makeFrames(container, { block: +opt.block || 200, count: +opt.frames || undefined });
    console.error(`stream ${id}: ${len} B signed+compressed, ${n} blocks x ${b} B, ${frames.length} frames`);
    if (opt.html) await writeFile(opt.html, PLAYER(frames));
    else console.log(frames.join('\n'));
  } else {
    console.error('usage: encode.mjs keygen [file] | sign <file> --id <name> [--type t] [--key f] [--block B] [--frames N] [--html out.html]');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
