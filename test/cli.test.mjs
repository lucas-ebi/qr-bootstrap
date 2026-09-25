import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Receiver, loadKey } from '../fountain.js';
import { parseGif, readQr } from './helpers/gif.mjs';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);
const cli = new URL('../tools/encode.mjs', import.meta.url).pathname;
const snake = new URL('../examples/snake.html', import.meta.url).pathname;
const node = (args, env = {}, cwd) => run(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, cwd });

test('keygen - prints the private key to stdout, the public key to stderr, and writes no file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qrboot-cli-'));
  const { stdout, stderr } = await node(['keygen', '-'], {}, cwd);
  const jwk = JSON.parse(stdout);
  assert.ok(jwk.d && jwk.x, 'private JWK on stdout');
  assert.ok(stderr.includes(jwk.x), 'public key on stderr');
  assert.ok(!stderr.includes(jwk.d), 'private key never on stderr');
  assert.deepEqual(await readdir(cwd), []);
});

test('sign uses QB_SIGNING_KEY (as in CI), and the frames decode under the public key', async () => {
  const { stdout: key } = await node(['keygen', '-']);
  const publicKey = JSON.parse(key).x;
  const { stdout, stderr: log } = await node(['sign', snake, '--id', 'snake', '--version', '7'], { QB_SIGNING_KEY: key });
  assert.ok(!log.includes(JSON.parse(key).d), 'log never contains the private key');

  const rx = new Receiver([await loadKey(publicKey)]);
  let r;
  for (const f of stdout.trim().split('\n')) if ((r = await rx.push(f))?.opened || r?.error) break;
  assert.deepEqual([r.opened?.id, r.opened?.version, r.opened?.type], ['snake', 7, 'html'], JSON.stringify(r));
});

test('sign with no key anywhere fails instead of signing with something else', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qrboot-cli-'));
  await assert.rejects(node(['sign', snake, '--id', 'snake'], { QB_SIGNING_KEY: '' }, cwd), /ENOENT|signing-key/);
});

test('sign --gif writes a standalone looping GIF with a countdown to --url', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qrboot-cli-'));
  const { stdout: key } = await node(['keygen', '-']);
  const url = 'https://example.github.io/qr-bootstrap/';
  const { stderr } = await node(['sign', snake, '--id', 'snake', '--gif', join(dir, 's.gif'), '--url', url, '--intro', '3', '--scale', '5'], { QB_SIGNING_KEY: key });
  assert.match(stderr, /3 s countdown/);
  const gif = parseGif(new Uint8Array(await readFile(join(dir, 's.gif'))));
  assert.ok(gif.loops && gif.frames.length > 3);
  assert.deepEqual(gif.frames.slice(0, 3).map(f => f.delay), [100, 100, 100]);
  assert.equal(readQr(gif.frames[0].pixels, gif.width, gif.height), url);
  assert.match(readQr(gif.frames[3].pixels, gif.width, gif.height), /^QB1\//);
  assert.deepEqual(await readdir(dir), ['s.gif']);
});

test('--gif options are validated before anything is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qrboot-cli-'));
  const { stdout: key } = await node(['keygen', '-']);
  const sign = extra => node(['sign', snake, '--id', 'snake', '--gif', join(dir, 'x.gif'), ...extra], { QB_SIGNING_KEY: key });
  await assert.rejects(sign(['--intro', '3']), /--intro needs --url/);
  await assert.rejects(sign(['--url', 'ftp://example.com']), /http\(s\) URL/);
  for (const bad of ['x', '10', '-1', '2.5', '']) await assert.rejects(sign(['--url', 'https://example.com/', '--intro', bad]), /--intro must be/, `intro ${JSON.stringify(bad)}`);
  assert.deepEqual(await readdir(dir), []);
});
