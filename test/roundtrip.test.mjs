import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { CODE, DOMAIN, Decoder, PROTOCOL, Receiver, b45decode, b45encode, concat, encoder, loadKey, mask, open, openFile, packFile, parseFrame } from '../fountain.js';
import { keygen, makeFrames, seal } from '../tools/encode.mjs';

const enc = s => new TextEncoder().encode(s);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Deterministic-ish "source code" that compresses like real JS.
const source = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i * 7919 % 1000};`).join('\n');

async function setup(payload = enc(source), type = 'mjs', version = 1) {
  const { jwk, publicKey } = await keygen();
  const keys = [await loadKey(publicKey)];
  const container = await seal(jwk, { type, id: 'demo', payload, version });
  return { jwk, publicKey, keys, container };
}

test('base45 matches RFC 9285 vectors and round-trips odd lengths', () => {
  assert.equal(b45encode(enc('ietf!')), 'QED8WEX0');
  assert.equal(b45encode(enc('base-45')), 'UJCLQE7W581');
  assert.equal(b45encode(enc('Hello!!')), '%69 VD92EX0');
  for (let len = 0; len < 12; len++) {
    const x = crypto.getRandomValues(new Uint8Array(len));
    assert.deepEqual(b45decode(b45encode(x)), x);
  }
  assert.throws(() => b45decode('GGW'));  // 65536 > max
  assert.throws(() => b45decode('a'));     // not in the alphabet
});

test('mask matches the wire-format regression vector', () => {
  // Changing mask()/mulberry32() changes the protocol: it must go with a new parameter block.
  assert.equal(mask(12345, 64).join(''), '1010001100011110111100110101111100000000100010101110000101110010');
});

test('round trip with shuffling and 30% loss opens the signed payload', async () => {
  const { keys, container } = await setup();
  const { frames, n } = await makeFrames(container, { block: 200, count: 100 }); // ample supply: the test is about loss
  const rx = new Receiver(keys);
  let result;
  for (const f of shuffle(frames.filter(() => Math.random() > 0.3))) {
    result = await rx.push(f);
    if (result?.opened || result?.error) break;
  }
  assert.ok(result?.opened, `did not complete (${n} blocks): ${JSON.stringify(result)}`);
  assert.equal(new TextDecoder().decode(result.opened.payload), source);
  assert.deepEqual([result.opened.type, result.opened.id, result.opened.version], ['mjs', 'demo', 1]);
});

test('frames are QR alphanumeric-safe and compression shrinks the stream', async () => {
  const { container } = await setup();
  const { frames } = await makeFrames(container);
  assert.ok(frames.every(f => /^[0-9A-Z $%*+\-./:]+$/.test(f)));
  assert.ok(container.length < enc(source).length / 2, `container ${container.length} B`);
});

test('tampering and untrusted signers are rejected', async () => {
  const { keys, container } = await setup();
  const bad = container.slice();
  bad[bad.length - 5] ^= 1;
  for (const [c, k, msg] of [[bad, keys, /bad signature|corrupt|Z_|deflate|incorrect|invalid/i], [container, [await loadKey((await keygen()).publicKey)], /bad signature/]]) {
    const rx = new Receiver(k);
    let r;
    for (const f of (await makeFrames(c)).frames) if ((r = await rx.push(f))?.error || r?.opened) break;
    assert.ok(r?.error, 'expected an error');
    assert.match(r.error, msg);
    assert.equal(r.opened, undefined);
  }
});

test('hostile frames are rejected quickly and never hang', () => {
  const ok = `${PROTOCOL}/0123456789ABCDEF`;
  const cases = [
    `${ok}/0/100/1/AA`, `${ok}/4097/100000/1/AA`, `${ok}/4/100/1/AA` /* wrong data length */,
    `${ok}/4/99999999/1/AA`, `${ok}/4/100/4294967296/AA`, `${ok}/10/9/1/AA` /* n > len */,
    `${ok}/1/100000/1/AA` /* block > MAX_B */, `${PROTOCOL}/short/4/100/1/AA`, 'garbage', '{"i":"x"}',
    `00000000/0123456789ABCDEF/1/4/1/${'0'.repeat(6)}` /* another protocol revision */,
  ];
  const t = performance.now();
  for (const c of cases) assert.equal(parseFrame(c), null, c);
  assert.ok(performance.now() - t < 200);
});

test('mismatched parameters for a known stream are ignored, not merged', async () => {
  const { keys, container } = await setup();
  const { frames } = await makeFrames(container);
  const rx = new Receiver(keys);
  assert.ok(await rx.push(frames[0]));
  const [, id, n, len, seed, data] = frames[1].split('/');
  assert.equal(await rx.push(`${PROTOCOL}/${id}/${+n + 1}/${len}/${seed}/${data}`), null);
});

test('a completed stream opens exactly once, even with concurrent extra symbols', async () => {
  const { keys, container } = await setup();
  const { frames } = await makeFrames(container, { count: 400 });
  const rx = new Receiver(keys);
  const results = await Promise.all(frames.map(f => rx.push(f)));
  assert.equal(results.filter(r => r?.opened).length, 1);
  assert.equal((await rx.push(frames[0])), null);
});

test('decoding overhead is close to n symbols', () => {
  for (const n of [8, 40, 150]) {
    const blocks = Array.from({ length: n }, () => crypto.getRandomValues(new Uint8Array(16)));
    let total = 0;
    const trials = 40;
    for (let t = 0; t < trials; t++) {
      const d = new Decoder(n, n * 16), base = Math.random() * 1e9 | 0;
      let used = 0;
      for (let seed = base; !d.add(seed, (() => {
        const m = mask(seed, n), s = new Uint8Array(16);
        m.forEach((bit, j) => { if (bit) blocks[j].forEach((v, i) => { s[i] ^= v; }); });
        return s;
      })()); seed++) used++;
      used++;
      assert.deepEqual(d.solve(), Uint8Array.from(blocks.flatMap(b => [...b])));
      total += used - n;
    }
    const mean = total / trials;
    console.log(`  n=${n}: mean extra symbols = ${mean.toFixed(2)}`);
    assert.ok(mean < 4, `mean overhead ${mean}`);
  }
});

// Runs every frame of a fresh container through a Receiver and returns the final result.
async function receive(container, rx) {
  let r;
  for (const f of (await makeFrames(container, { count: 100 })).frames) if ((r = await rx.push(f))?.error || r?.opened || r?.file) break;
  return r;
}

test('open reports version and which trusted key signed', async () => {
  const { jwk, publicKey } = await keygen();
  const other = await keygen();
  const container = await seal(jwk, { type: 'json', id: 'cfg', payload: enc('{}'), version: 42 });
  const opened = await open(container, [await loadKey(other.publicKey), await loadKey(publicKey)]);
  assert.deepEqual([opened.type, opened.id, opened.version, opened.signer], ['json', 'cfg', 42, publicKey.slice(0, 8)]);
});

test('seal defaults to a timestamp version and rejects invalid ones', async () => {
  const { jwk, publicKey } = await keygen();
  const before = Math.floor(Date.now() / 1000);
  const opened = await open(await seal(jwk, { type: 'json', id: 'x', payload: enc('1') }), [await loadKey(publicKey)]);
  assert.ok(opened.version >= before && opened.version <= before + 5);
  for (const version of [-1, 1.5, NaN, 1e16]) await assert.rejects(seal(jwk, { type: 'json', id: 'x', payload: enc('1'), version }), /version/);
});

test('signatures are domain-separated: a signature over the bare body is rejected', async () => {
  const { jwk, keys, container } = await setup();
  const body = container.subarray(65);
  const key = await crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign']);
  const bare = concat([CODE], new Uint8Array(await crypto.subtle.sign('Ed25519', key, body)), body);
  await assert.rejects(open(bare, keys), /bad signature/);
  const withDomain = concat([CODE], new Uint8Array(await crypto.subtle.sign('Ed25519', key, concat(DOMAIN, body))), body);
  assert.equal((await open(withDomain, keys)).id, 'demo');
});

test('the accept hook can refuse older versions (replay protection)', async () => {
  const { jwk, publicKey } = await keygen();
  const keys = [await loadKey(publicKey)];
  const newest = 10;
  const accept = o => { if (o.version < newest) throw new Error('older version'); };
  const at = version => seal(jwk, { type: 'json', id: 'app', payload: enc(`{"v":${version}}`), version });

  const old = await receive(await at(9), new Receiver(keys, { accept }));
  assert.equal(old.error, 'older version');
  assert.equal(old.opened, undefined);
  for (const v of [10, 11]) assert.ok((await receive(await at(v), new Receiver(keys, { accept }))).opened, `v${v}`);
});

test('hold() makes a stream ignored for a while', async () => {
  const { keys, container } = await setup();
  const { frames } = await makeFrames(container);
  const rx = new Receiver(keys);
  const { id } = await rx.push(frames[0]);
  rx.hold(id, 60_000);
  assert.equal(await rx.push(frames[1]), null);
});

test('PROTOCOL is the hash of the parameter block in docs/PROTOCOL.md', () => {
  const spec = readFileSync(new URL('../docs/PROTOCOL.md', import.meta.url), 'utf8');
  const block = /<!-- parameters:begin -->\n([\s\S]*?)<!-- parameters:end -->/.exec(spec)[1];
  assert.equal(createHash('sha256').update(block).digest('hex').slice(0, 8).toUpperCase(), PROTOCOL);
  assert.ok(spec.includes(mask(12345, 64).join('')), 'the mask test vector in the spec matches the code');
  for (const [text, b45] of [['ietf!', 'QED8WEX0'], ['base-45', 'UJCLQE7W581']]) {
    assert.ok(spec.includes(`\`${text}\` → \`${b45}\``) && b45encode(enc(text)) === b45);
  }
});

test('any n + a few frames from an arbitrary start seed decode', async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20000));
  const container = await packFile('noise.bin', 'application/octet-stream', bytes);
  const e = await encoder(container, 700), start = Math.random() * 1e9 | 0, rx = new Receiver([]);
  let r;
  for (let s = start; !(r = await rx.push(e.frame(s)))?.file && !r?.error; s += 3);
  assert.ok(r.file, JSON.stringify(r));
  assert.deepEqual(r.file.bytes, bytes);
  assert.deepEqual(r.container, container);
});

test('file containers round-trip, compressed or stored, and never produce `opened`', async () => {
  const text = enc('hello '.repeat(500)), noise = crypto.getRandomValues(new Uint8Array(3000));
  for (const [name, mime, bytes, tag] of [['a b/é.txt', 'text/plain', text, 2], ['x.jpg', 'image/jpeg', noise, 3], ['y', 'bad mime', text, 2]]) {
    const c = await packFile(name, mime, bytes);
    assert.equal(c[0], tag, name);
    const f = await openFile(c);
    assert.deepEqual([f.name, f.mime, f.bytes], [name, mime === 'bad mime' ? 'application/octet-stream' : mime, bytes]);
    const r = await receive(c, new Receiver([]));
    assert.ok(r.file && !r.opened, name);
  }
  await assert.rejects(open(await packFile('a', 'text/html', text), []), /not a code container/);
});

test('code and file streams interleave in one receiver without interfering', async () => {
  const { keys, container } = await setup();
  const file = await packFile('f.bin', 'application/octet-stream', crypto.getRandomValues(new Uint8Array(5000)));
  const [a, b] = [(await makeFrames(container, { block: 300, count: 80 })).frames, (await makeFrames(file, { block: 300, count: 80 })).frames];
  const rx = new Receiver(keys), got = {};
  for (let i = 0; i < 80; i++) for (const f of [a[i], b[i]]) {
    const r = await rx.push(f);
    if (r?.opened) got.code = r.opened.id;
    if (r?.file) got.file = r.file.name;
  }
  assert.deepEqual(got, { code: 'demo', file: 'f.bin' });
});

test('a 4 MiB container in about 3,500 blocks decodes in bounded time', async () => {
  const bytes = new Uint8Array(randomBytes((1 << 22) - 64));
  const container = await packFile('big', 'application/octet-stream', bytes);
  const e = await encoder(container, 1200), d = new Decoder(e.n, e.len);
  assert.ok(e.n > 3400, `n = ${e.n}`);
  const t = performance.now();
  for (let s = 1; !d.add(s, (await import('../fountain.js')).parseFrame(e.frame(s)).data); s++);
  const out = d.solve(), ms = performance.now() - t;
  console.log(`  n=${e.n}: encode + decode ${(ms / 1000).toFixed(1)} s`);
  assert.deepEqual(out, container);
  assert.ok(ms < 120_000);
});
