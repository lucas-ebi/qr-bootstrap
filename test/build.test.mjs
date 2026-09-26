import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, build } from '../tools/build.mjs';
import { keygen } from '../tools/encode.mjs';
import { loadKey, open } from '../fountain.js';

const tmp = () => mkdtemp(join(tmpdir(), 'qrboot-build-'));
const tree = async dir => (await readdir(dir, { recursive: true, withFileTypes: true })).filter(e => e.isFile())
  .map(e => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1)).sort();

test('build pins the keys in boot.js, stamps the core version and ships only the loader files', async () => {
  const [a, b] = [(await keygen()).publicKey, (await keygen()).publicKey];
  const out = await tmp();
  await build({ out, keys: [a, b], version: 1234 });
  assert.ok((await readFile(join(out, 'boot.js'), 'utf8')).includes(`const TRUSTED_KEYS = ['${a}', '${b}'];`));
  assert.ok((await readFile(join(out, 'core.js'), 'utf8')).includes('export const VERSION = 1234;'));
  assert.deepEqual(await tree(out), [...FILES].sort(), 'no core.bin without a signing key');
});

test('with a signing key, core.bin is the signed core with the same version', async () => {
  const k = await keygen(), out = await tmp();
  await build({ out, keys: [k.publicKey], jwk: k.jwk, version: 77 });
  const o = await open(new Uint8Array(await readFile(join(out, 'core.bin'))), [await loadKey(k.publicKey)]);
  assert.deepEqual([o.id, o.type, o.version], ['loader', 'mjs', 77]);
  assert.equal(new TextDecoder().decode(o.payload), await readFile(join(out, 'core.js'), 'utf8'));
});

test('every file the service worker precaches is shipped', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const assets = JSON.parse(/const ASSETS = (\[[\s\S]*?\]);/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const a of assets.filter(a => a !== './')) assert.ok(FILES.includes(a), a);
});

test('build refuses missing or malformed keys', async () => {
  const out = await tmp();
  await assert.rejects(build({ out, keys: [] }), /no trusted keys/);
  for (const bad of ['short', "x'];alert(1);//" + 'A'.repeat(43), 'A'.repeat(44), '=' + 'A'.repeat(42)]) {
    await assert.rejects(build({ out, keys: [bad] }), /invalid trusted key/, bad);
  }
  assert.deepEqual(await readdir(out), []);
});

test('build refuses to write into the source tree or above it', async () => {
  const { publicKey } = await keygen();
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const out of [root, dirname(root.replace(/[\\/]$/, ''))]) {
    await assert.rejects(build({ out, keys: [publicKey] }), /source tree/, out);
  }
});
