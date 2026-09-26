#!/usr/bin/env node
// Assembles the deployable loader into <out> (default: dist/).
//
//   TRUSTED_KEYS="<key1>,<key2>" [QR_BOOTSTRAP_SIGNING_KEY=<jwk>] [LOADER_URL=<url>] node tools/build.mjs [out]
//
// Pins the trusted keys in boot.js and stamps the core's VERSION (the build time in Unix seconds).
// With a signing key it also signs the core as the `loader` app into core.bin, so installed loaders
// can pass their own program on over QR; with LOADER_URL as well, it publishes signed, looping GIFs
// of the loader and of the examples in gifs/, each with a countdown to LOADER_URL#scan. Tools and
// tests are not deployed.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFrames, makeGif, seal } from './encode.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const FILES = [
  'index.html', 'boot.js', 'core.js', 'fountain.js', 'gif.js', 'decode-worker.js', 'sw.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'vendor/qrcode.mjs', 'vendor/qrcode.LICENSE', 'vendor/jsQR.js', 'vendor/jsQR.LICENSE',
  'vendor/zxing/share.js', 'vendor/zxing/reader/index.js', 'vendor/zxing/reader/zxing_reader.wasm', 'vendor/zxing/LICENSE',
];
export const GIFS = { snake: 'examples/snake.html', tetris: 'examples/tetris.html' }; // id -> source
const KEYS = 'const TRUSTED_KEYS = [];', VERSION = 'export const VERSION = 0;';
const KEY = /^[A-Za-z0-9_-]{43}$/; // 32 raw bytes, base64url

async function stamp(file, placeholder, value) {
  const text = await readFile(file, 'utf8');
  if (!text.includes(placeholder)) throw new Error(`${file} no longer contains "${placeholder}"`);
  await writeFile(file, text.replace(placeholder, value));
}

export async function build({ out, keys, jwk, url, version = Math.floor(Date.now() / 1000) }) {
  if (url && !jwk) throw new Error('LOADER_URL needs a signing key, to sign the GIFs');
  if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error('LOADER_URL must be an http(s) URL');
  if (!keys.length) throw new Error('no trusted keys: set TRUSTED_KEYS to comma-separated base64url Ed25519 public keys');
  if (keys.some(k => !KEY.test(k))) throw new Error('invalid trusted key: expected 43 base64url characters');
  const dest = resolve(out);
  if (dest === resolve(root) || resolve(root).startsWith(dest + sep)) throw new Error('refusing to build into the source tree');

  await mkdir(dest, { recursive: true });
  for (const f of FILES) {
    await mkdir(dirname(join(dest, f)), { recursive: true });
    await copyFile(join(root, f), join(dest, f));
  }
  await stamp(join(dest, 'boot.js'), KEYS, `const TRUSTED_KEYS = [${keys.map(k => `'${k}'`).join(', ')}];`);
  await stamp(join(dest, 'core.js'), VERSION, `export const VERSION = ${version};`);
  if (jwk) {
    const core = await readFile(join(dest, 'core.js'));
    const loader = await seal(jwk, { type: 'mjs', id: 'loader', payload: core, version });
    await writeFile(join(dest, 'core.bin'), loader);
    if (url) {
      await mkdir(join(dest, 'gifs'), { recursive: true });
      const gif = async (id, container) => writeFile(join(dest, 'gifs', id + '.gif'), makeGif((await makeFrames(container)).frames, { url }).gif);
      await gif('loader', loader);
      for (const [id, src] of Object.entries(GIFS)) {
        await gif(id, await seal(jwk, { type: src.split('.').pop(), id, payload: await readFile(join(root, src)), version }));
      }
    }
  }
  return dest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = (process.env.TRUSTED_KEYS ?? '').split(/[\s,]+/).filter(Boolean);
  const jwk = process.env.QR_BOOTSTRAP_SIGNING_KEY ? JSON.parse(process.env.QR_BOOTSTRAP_SIGNING_KEY) : undefined;
  const url = process.env.LOADER_URL || undefined;
  build({ out: process.argv[2] ?? 'dist', keys, jwk, url })
    .then(dir => console.log(`built into ${dir} with ${keys.length} trusted key(s)` + (jwk ? ', core signed into core.bin' : ', core.bin skipped (no signing key)') +
      (url ? `, GIFs of loader, ${Object.keys(GIFS).join(', ')} in gifs/` : '')))
    .catch(e => { console.error('build failed: ' + e.message); process.exit(1); });
}
