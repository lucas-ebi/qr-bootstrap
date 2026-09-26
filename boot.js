// Boot: the fixed part of the loader (docs/PROTOCOL.md, section 6). It holds the trusted keys and
// the local database, and starts the newest core that has not failed, falling back to the bundled one.
import { loadKey, open } from './fountain.js';

// Ed25519 public keys (base64url) allowed to sign code. Injected by tools/build.mjs.
const TRUSTED_KEYS = [];

export const base = new URL('./', import.meta.url).href;

// A key-value store in IndexedDB. Values are structured-cloned, so containers stay Uint8Arrays.
export function database(name = 'qr-bootstrap') {
  let conn;
  const tx = (mode, fn) => (conn ??= new Promise((ok, fail) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  })).then(db => new Promise((ok, fail) => {
    const t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
    t.oncomplete = () => ok(req.result);
    t.onerror = () => fail(t.error);
  }));
  return {
    get: k => tx('readonly', s => s.get(k)),
    put: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
    list: async prefix => {
      const [keys, values] = await Promise.all([tx('readonly', s => s.getAllKeys()), tx('readonly', s => s.getAll())]);
      return values.filter((_, i) => String(keys[i]).startsWith(prefix));
    },
  };
}

// Picks and starts a core. `load(url)` imports a module; injectable for tests.
export async function boot({ db = database(), keys = TRUSTED_KEYS, load = u => import(u), log = () => {}, reload = () => location.reload() } = {}) {
  const trusted = await Promise.all(keys.map(loadKey));
  const state = (await db.get('boot')) ?? { bad: [] };
  if (state.pending) { // the previous start never completed
    log(`CORE ${state.pending} DID NOT START; MARKED BAD`);
    state.bad.push(state.pending);
    state.pending = null;
  }

  const bundled = await load(base + 'core.js'), cands = [{ version: bundled.VERSION, mod: bundled, source: 'bundled' }];
  const stored = await db.get('app:loader');
  if (stored) {
    try {
      const o = await open(stored.container, trusted);
      if (o.id !== 'loader' || o.type !== 'mjs') throw new Error('not a loader');
      cands.push({ version: o.version, source: 'stored', url: URL.createObjectURL(new Blob([o.payload], { type: 'text/javascript' })) });
    } catch (e) {
      log('STORED CORE REFUSED: ' + e.message);
    }
  }
  cands.sort((a, b) => b.version - a.version);
  const pick = cands.find(c => !state.bad.includes(c.version) || c.source === 'bundled');

  const api = {
    keys, base, db, log, version: pick.version, source: pick.source, bad: state.bad,
    reset: async () => { await db.del('app:loader'); await db.put('boot', { bad: [] }); reload(); },
  };
  await db.put('boot', { ...state, pending: pick.source === 'bundled' ? null : pick.version });
  try {
    const mod = pick.mod ?? await load(pick.url);
    await mod.start(api);
    await db.put('boot', { ...state, pending: null });
  } catch (e) {
    if (pick.source === 'bundled') throw e;
    log(`CORE ${pick.version} FAILED: ${e.message}`);
    await db.put('boot', { bad: [...state.bad, pick.version], pending: null });
    reload();
  }
  return api;
}

if (globalThis.document) {
  navigator.serviceWorker?.register('sw.js').catch(() => {});
  const logEl = document.getElementById('log');
  const log = s => { logEl.textContent += s + '\n'; };
  boot({ log }).catch(e => { log('BOOT FAILED: ' + e.message); console.error(e); });
}
