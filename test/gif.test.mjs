import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Receiver, loadKey } from '../fountain.js';
import { encodeGif, renderFrames, renderIntro } from '../tools/gif.mjs';
import { keygen, makeFrames, seal } from '../tools/encode.mjs';
import { parseGif, readQr } from './helpers/gif.mjs';

const URL_ = 'https://lucas-ebi.github.io/qr-bootstrap/';
const enc = s => new TextEncoder().encode(s);
const source = Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i * 7919 % 1000};`).join('\n');

test('GIF structure: size, palette, looping and per-frame delays', () => {
  const img = renderFrames(['QB1/0123456789ABCDEF/9/999/1/HELLO', 'QB1/0123456789ABCDEF/9/999/2/WORLD'], { scale: 4 });
  const intro = renderIntro(URL_, [3, 2, 1], img.width);
  const gif = parseGif(encodeGif({ ...img, frames: [...intro, ...img.frames] }, { delay: 17, delays: [100, 100, 100] }));
  assert.deepEqual([gif.width, gif.height, gif.loops], [img.width, img.height, true]);
  assert.deepEqual(gif.palette, [[255, 255, 255], [0, 0, 0]]);
  assert.deepEqual(gif.frames.map(f => f.delay), [100, 100, 100, 17, 17]);
});

test('the GIF encoder is lossless: decoding every frame gives back the exact pixels', () => {
  const texts = ['QB1/0123456789ABCDEF/9/999/1/HELLO', 'QB1/0123456789ABCDEF/9/999/2/' + 'ABC 123 $%*+-./:'.repeat(6)];
  const img = renderFrames(texts, { scale: 5 });
  const intro = renderIntro(URL_, [5, 0], img.width);
  const all = [...intro, ...img.frames];
  const gif = parseGif(encodeGif({ ...img, frames: all }));
  gif.frames.forEach((f, i) => assert.deepEqual(f.pixels, all[i], `frame ${i}`));
});

test('all frames share one size even when their texts differ in length', () => {
  const img = renderFrames(['QB1/AAAAAAAAAAAAAAAA/9/999/1/A', 'QB1/AAAAAAAAAAAAAAAA/9/999/2/' + 'B'.repeat(200)], { scale: 3 });
  assert.equal(img.frames.length, 2);
  assert.ok(img.frames.every(f => f.length === img.width * img.height));
});

test('every countdown digit still scans as the loader URL', () => {
  const side = 552;
  const frames = renderIntro(URL_, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], side);
  frames.forEach((px, digit) => assert.equal(readQr(px, side, side), URL_, `digit ${digit}`));
});

test('a signed stream survives the trip through the GIF: frames scan, verify and open', async () => {
  const { jwk, publicKey } = await keygen();
  const container = await seal(jwk, { type: 'mjs', id: 'demo', payload: enc(source), version: 5 });
  const { frames } = makeFrames(container, { block: 200, count: 60 });
  const img = renderFrames(frames, { scale: 5 });
  const intro = renderIntro(URL_, [3, 2, 1], img.width);
  const gif = parseGif(encodeGif({ ...img, frames: [...intro, ...img.frames] }));

  const scanned = gif.frames.map(f => readQr(f.pixels, gif.width, gif.height));
  assert.deepEqual(scanned.slice(0, 3), [URL_, URL_, URL_]);
  assert.deepEqual(scanned.slice(3), frames, 'data frames scan back to exactly what the encoder produced');

  const rx = new Receiver([await loadKey(publicKey)]);
  let r;
  for (const text of scanned.filter((_, i) => i % 3 !== 1)) if ((r = await rx.push(text))?.opened || r?.error) break; // the URL frames are ignored; a third is lost
  assert.ok(r?.opened, JSON.stringify(r));
  assert.deepEqual([r.opened.id, r.opened.version, new TextDecoder().decode(r.opened.payload)], ['demo', 5, source]);
});
