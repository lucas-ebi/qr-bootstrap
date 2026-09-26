// Size budgets, in the spirit of the machines this project admires: a ZX81 had 1 KB of RAM, and one
// version-40 QR code holds 2,953 bytes. Sizes are deflate-compressed, because that is what crosses
// the optical channel. Vendored decoders are exempt: they are installed, never streamed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const BUDGET = { // bytes, compressed
  'boot.js': 2048, 'core.js': 16384, 'fountain.js': 5120, 'gif.js': 4096, 'decode-worker.js': 2048,
  'examples/snake.html': 4096, 'examples/tetris.html': 6144,
};

for (const [file, max] of Object.entries(BUDGET)) {
  test(`${file} stays within ${max} bytes compressed`, () => {
    const size = deflateRawSync(readFileSync(new URL('../' + file, import.meta.url)), { level: 9 }).length;
    console.log(`  ${file}: ${size} B`);
    assert.ok(size <= max, `${file} is ${size} B compressed; the budget is ${max} B`);
  });
}
