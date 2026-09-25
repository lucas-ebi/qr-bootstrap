import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Receiver, loadKey } from '../fountain.js';

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
