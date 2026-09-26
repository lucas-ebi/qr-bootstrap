import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { boot } from '../boot.js';
import { keygen, seal } from '../tools/encode.mjs';

const enc = s => new TextEncoder().encode(s);
const memdb = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, del: async k => { m.delete(k); } };
};
// A stored core records that it ran; `body` can make it throw or hang.
const core = (v, body = '') => enc(`export const VERSION = ${v};\nexport async function start(b) { globalThis.ran.push(${v}); ${body} }`);

async function setup({ bundled = 5, stored, storedBody, signer, state } = {}) {
  globalThis.ran = [];
  const me = await keygen(), db = memdb(state ? { boot: state } : {});
  if (stored !== undefined) {
    const container = await seal((signer ?? me).jwk, { type: 'mjs', id: 'loader', payload: core(stored, storedBody), version: stored });
    db.m.set('app:loader', { container });
  }
  const reloads = [];
  const load = async url => url.startsWith('blob:')
    ? import('data:text/javascript,' + encodeURIComponent(await resolveObjectURL(url).text()))
    : { VERSION: bundled, start: async () => { globalThis.ran.push(bundled); } };
  const run = () => boot({ db, keys: [me.publicKey], load, reload: () => reloads.push(1) });
  return { db, run, reloads };
}

test('a newer stored core is chosen over the bundled one, and pending is cleared after start', async () => {
  const { db, run } = await setup({ bundled: 5, stored: 9 });
  const api = await run();
  assert.deepEqual([ran, api.version, api.source], [[9], 9, 'stored']);
  assert.equal(db.m.get('boot').pending, null);
});

test('an older or equal stored core loses to the bundled one', async () => {
  for (const stored of [4, 5]) {
    const { run } = await setup({ bundled: 5, stored });
    assert.equal((await run()).source, 'bundled', `stored ${stored}`);
  }
});

test('a core that throws while starting is marked bad and the page reloads into the bundled one', async () => {
  const { db, run, reloads } = await setup({ bundled: 5, stored: 9, storedBody: 'throw new Error("broken")' });
  await run();
  assert.deepEqual([db.m.get('boot').bad, reloads.length], [[9], 1]);
  globalThis.ran = [];
  const api = await run();
  assert.deepEqual([api.source, ran], ['bundled', [5]]);
});

test('a start that never completed is marked bad on the next launch', async () => {
  const { db, run } = await setup({ bundled: 5, stored: 9, state: { bad: [], pending: 9 } });
  const api = await run();
  assert.deepEqual([api.source, db.m.get('boot').bad], ['bundled', [9]]);
});

test('a tampered stored core, or one signed by an untrusted key, is refused', async () => {
  const { db, run } = await setup({ bundled: 5, stored: 9 });
  db.m.get('app:loader').container[80] ^= 1;
  assert.equal((await run()).source, 'bundled');
  const other = await setup({ bundled: 5, stored: 9, signer: await keygen() });
  assert.equal((await other.run()).source, 'bundled');
});

test('reset forgets the stored core and the failure list', async () => {
  const { db, run, reloads } = await setup({ bundled: 5, stored: 9, state: { bad: [7] } });
  await (await run()).reset();
  assert.deepEqual([db.m.has('app:loader'), db.m.get('boot').bad, reloads.length], [false, [], 1]);
});
