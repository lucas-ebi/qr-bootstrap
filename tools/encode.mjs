#!/usr/bin/env node
// Signs a payload and turns it into a stream of frames (docs/PROTOCOL.md).
//
//   node tools/encode.mjs keygen [signing-key.json | -]
//   node tools/encode.mjs sign <file> --id <name> [--type mjs|html|json] [--version N]
//                              [--key signing-key.json] [--block 700] [--frames N]
//                              [--gif out.gif [--scale 8] [--fps 10] [--ecc L] [--url <loader URL> [--intro 5]]]
//
// `keygen -` prints the private key to stdout instead of a file (so it can be piped straight into
// `gh secret set`) and the public key to stderr.
// `sign` reads the private key from --key, else the QR_BOOTSTRAP_SIGNING_KEY environment variable (used by
// CI), else ./signing-key.json.
// --version defaults to the current Unix time, so later builds are always newer.
//
// `sign` prints one frame per line, or with --gif writes a standalone animated GIF of QR codes: it
// plays offline in any viewer or browser and can be shared as a file. With --url, each loop starts
// with --intro seconds (default 3, max 9) of countdown frames: QR codes of that URL with a counter
// in the middle, so a phone's camera app can open the loader before the data frames begin.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { encodeGif, renderFrames, renderIntro } from '../gif.js';
import { CODE, DOMAIN, concat, deflate, encoder } from '../fountain.js';

const TYPES = ['mjs', 'html', 'json'];

// The countdown opens the loader straight on its scanner (a plain visit shows the loader's own stream).
export const scanUrl = url => url.replace(/#.*$/, '') + '#scan';

// Returns { jwk, publicKey } where publicKey is the base64url string to pin in index.html.
export async function keygen() {
  const { privateKey } = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return { jwk, publicKey: jwk.x };
}

// container = 0x01 || signature (64 B) || deflate-raw("<type> <id> <version>\n" + payload)
// The signature covers DOMAIN || the compressed part. Loaders refuse a version lower than one they ran.
export async function seal(jwk, { type, id, payload, version = Math.floor(Date.now() / 1000) }) {
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES}`);
  if (!/^[\w.-]+$/.test(id)) throw new Error('id may only contain letters, digits, _ . -');
  if (!Number.isSafeInteger(version) || version < 0 || version > 999999999999999) throw new Error('version must be a non-negative integer');
  const key = await crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign']);
  const body = await deflate(concat(new TextEncoder().encode(`${type} ${id} ${version}\n`), payload));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, concat(DOMAIN, body)));
  return concat([CODE], sig, body);
}

// Symbols for seeds start .. start+count-1 (default: enough for a looping GIF). Any n+2 or so
// distinct ones decode.
export async function makeFrames(container, { block = 700, count, start = 1 } = {}) {
  const e = await encoder(container, block);
  count ??= Math.ceil(e.n * 1.5) + 8;
  return { ...e, frames: Array.from({ length: count }, (_, i) => e.frame(start + i)) };
}

// A looping GIF of the frames, preceded by `intro` seconds of countdown to `url` when given.
export function makeGif(frames, { url, intro = 3, scale = 8, fps = 10, ecc = 'L' } = {}) {
  const img = renderFrames(frames, { scale, ecc });
  const secs = url ? intro : 0;
  const lead = secs ? renderIntro(scanUrl(url), Array.from({ length: secs }, (_, i) => secs - i), img.width) : [];
  const gif = encodeGif({ ...img, frames: [...lead, ...img.frames] }, { delay: Math.round(100 / fps), delays: lead.map(() => 100) });
  return { gif, img, secs };
}

async function main([cmd, ...argv]) {
  const opt = {}, pos = [];
  for (let i = 0; i < argv.length; i++) argv[i].startsWith('--') ? opt[argv[i].slice(2)] = argv[++i] : pos.push(argv[i]);

  if (cmd === 'keygen') {
    const file = pos[0] ?? 'signing-key.json', { jwk, publicKey } = await keygen();
    if (file === '-') {
      process.stdout.write(JSON.stringify(jwk));
    } else {
      await writeFile(file, JSON.stringify(jwk), { mode: 0o600 });
      console.error(`Private key written to ${file} (keep it secret; it is gitignored).`);
    }
    console.error(`Public key (set it as the TRUSTED_KEYS variable, see README):\n  ${publicKey}`);
  } else if (cmd === 'sign' && pos[0] && opt.id) {
    const fromEnv = !opt.key && process.env.QR_BOOTSTRAP_SIGNING_KEY;
    const jwk = JSON.parse(fromEnv || await readFile(opt.key ?? 'signing-key.json', 'utf8'));
    const type = opt.type ?? pos[0].split('.').pop();
    const container = await seal(jwk, { type, id: opt.id, payload: await readFile(pos[0]), version: opt.version === undefined ? undefined : +opt.version });
    const { id, n, b, len, frames } = await makeFrames(container, { block: +opt.block || undefined, count: +opt.frames || undefined });
    console.error(`stream ${id}: ${len} B signed+compressed, ${n} blocks x ${b} B, ${frames.length} frames`);
    if (opt.gif) {
      if (opt.intro !== undefined && !opt.url) throw new Error('--intro needs --url <loader URL>');
      if (opt.intro !== undefined && !/^[0-9]$/.test(opt.intro)) throw new Error('--intro must be a whole number of seconds from 0 to 9');
      if (opt.url && !/^https?:\/\/\S+$/.test(opt.url)) throw new Error('--url must be an http(s) URL');
      const { gif, img, secs } = makeGif(frames, { url: opt.url, intro: opt.intro === undefined ? 3 : +opt.intro, scale: +opt.scale || 8, fps: +opt.fps || 10, ecc: opt.ecc ?? 'L' });
      await writeFile(opt.gif, gif);
      console.error(`${opt.gif}: ${img.width}x${img.height} px, QR version ${img.version}, ${frames.length} data frames` +
        (secs ? ` after a ${secs} s countdown to ${scanUrl(opt.url)}` : '') + `, ${(gif.length / 1024).toFixed(0)} KiB`);
    } else console.log(frames.join('\n'));
  } else {
    console.error('usage: encode.mjs keygen [file | -] | sign <file> --id <name> [--type t] [--version N] [--key f] [--block B] [--frames N] [--gif out.gif] [--scale S] [--fps F] [--ecc L|M|Q|H] [--url U] [--intro SECS]');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
