import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/build.mjs';
import { keygen } from '../tools/encode.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'qrboot-build-'));

test('build pins the given keys and ships only the loader files', async () => {
  const [a, b] = [(await keygen()).publicKey, (await keygen()).publicKey];
  const out = await tmp();
  await build({ out, keys: [a, b] });

  const html = await readFile(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes(`const TRUSTED_KEYS = ['${a}', '${b}'];`));
  assert.ok(!html.includes('const TRUSTED_KEYS = [];'));
  assert.deepEqual((await readdir(out)).sort(),
    ['fountain.js', 'icon-192.png', 'icon-512.png', 'index.html', 'manifest.json', 'sw.js']);
});

test('build refuses missing or malformed keys', async () => {
  const out = await tmp();
  await assert.rejects(build({ out, keys: [] }), /no trusted keys/);
  for (const bad of ['short', "x'];alert(1);//" + 'A'.repeat(43), 'A'.repeat(44), '=' + 'A'.repeat(42)]) {
    await assert.rejects(build({ out, keys: [bad] }), /invalid trusted key/, bad);
  }
  assert.deepEqual(await readdir(out), []); // nothing was written
});

test('build refuses to write into the source tree or above it', async () => {
  const { publicKey } = await keygen();
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const out of [root, dirname(root.replace(/[\\/]$/, ''))]) {
    await assert.rejects(build({ out, keys: [publicKey] }), /source tree/, out);
  }
});
