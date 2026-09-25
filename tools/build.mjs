#!/usr/bin/env node
// Assembles the deployable loader into <out> (default: dist/), pinning the trusted keys.
//
//   TRUSTED_KEYS="<key1>,<key2>" node tools/build.mjs [out]
//
// Keys are base64url Ed25519 public keys, as printed by `encode.mjs keygen`. Only the files
// the loader needs are copied; tools, tests and examples are not deployed.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['index.html', 'fountain.js', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const PLACEHOLDER = 'const TRUSTED_KEYS = [];';
const KEY = /^[A-Za-z0-9_-]{43}$/; // 32 raw bytes, base64url

export async function build({ out, keys }) {
  if (!keys.length) {
    throw new Error('no trusted keys: set TRUSTED_KEYS to comma-separated base64url Ed25519 public keys');
  }
  if (keys.some(k => !KEY.test(k))) throw new Error('invalid trusted key: expected 43 base64url characters');
  const dest = resolve(out);
  if (dest === resolve(root) || resolve(root).startsWith(dest + sep)) throw new Error('refusing to build into the source tree');

  await mkdir(dest, { recursive: true });
  for (const f of FILES) await copyFile(join(root, f), join(dest, f));

  const page = join(dest, 'index.html'), html = await readFile(page, 'utf8');
  if (!html.includes(PLACEHOLDER)) throw new Error(`index.html no longer contains "${PLACEHOLDER}"`);
  await writeFile(page, html.replace(PLACEHOLDER, `const TRUSTED_KEYS = [${keys.map(k => `'${k}'`).join(', ')}];`));
  return dest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = (process.env.TRUSTED_KEYS ?? '').split(/[\s,]+/).filter(Boolean);
  build({ out: process.argv[2] ?? 'dist', keys })
    .then(dir => console.log(`built ${FILES.length} files into ${dir} with ${keys.length} trusted key(s)`))
    .catch(e => { console.error('build failed: ' + e.message); process.exit(1); });
}
