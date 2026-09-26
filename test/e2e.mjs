// Browser end-to-end test (optional, not part of `npm test`):
//   npm i --no-save playwright && npx playwright install chromium && node test/e2e.mjs [screenshot-dir]
//
// Every page gets a fake camera: a canvas whose stream the loader reads like a real camera. The test
// draws QR codes on it, so decoding runs through the real worker and zxing-wasm. Frames can also be
// given to the worker as text, which is quicker for the policy checks.
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { keygen, makeFrames, seal } from '../tools/encode.mjs';
import { decodeGif, encodeGif, renderFrames } from '../gif.js';
import { readQr } from './helpers/gif.mjs';

const { chromium } = await import('playwright').catch(() => {
  console.error('playwright is not installed: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
});

const root = new URL('..', import.meta.url);
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

const signer = await keygen(), otherSigner = await keygen(), stranger = await keygen();
let BUNDLED = 100; // changed mid-test to stand for a new deployment
const stream = async (who, type, id, payload, version, block = 400) =>
  makeFrames(await seal(who.jwk, { type, id, payload: Buffer.from(payload), version }), { block, count: 80 });
const lossy = frames => frames.filter(() => Math.random() > 0.3).sort(() => Math.random() - 0.5);

const mod = (who, version) => stream(who, 'mjs', 'demo', `export function init(ctx) { window.__ran = (window.__ran || 0) + 1; window.__ctx = Object.keys(ctx).join(); }`, version);
const evil = await stream(stranger, 'mjs', 'evil', 'export function init() { window.__pwned = 1 }', 1);
const snake = await stream(signer, 'html', 'snake', await readFile(new URL('examples/snake.html', root)), 1);
const tetris = await stream(signer, 'html', 'tetris', await readFile(new URL('examples/tetris.html', root)), 1);
const coreSrc = await readFile(new URL('core.js', root), 'utf8');
const coreAt = (v, extra = '') => coreSrc.replace('export const VERSION = 0;', `export const VERSION = ${v};`)
  .replace('export async function start(boot) {', `export async function start(boot) {\n${extra}`);
const core200 = await stream(signer, 'mjs', 'loader', coreAt(200, 'globalThis.__core = 200;'), 200, 1200);
const core300 = await stream(signer, 'mjs', 'loader', coreAt(300, 'throw new Error("broken core");'), 300, 1200);
const snakeGif = encodeGif(renderFrames(snake.frames.slice(0, 40), { scale: 4 }), { delay: 10 });
const snake2Gif = encodeGif(renderFrames((await stream(signer, 'html', 'snake', await readFile(new URL('examples/snake.html', root)), 2)).frames.slice(0, 40), { scale: 4 }), { delay: 10 });

const MIME = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', png: 'image/png', wasm: 'application/wasm' };
const trusted = [signer, otherSigner].map(k => `'${k.publicKey}'`).join(', ');
const bundledQb = Buffer.from(await seal(signer.jwk, { type: 'mjs', id: 'loader', payload: Buffer.from(coreAt(BUNDLED)), version: BUNDLED }));
const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    let body = path === '/core.bin' ? bundledQb : await readFile(new URL('.' + path, root));
    if (path === '/boot.js') body = body.toString().replace('const TRUSTED_KEYS = [];', `const TRUSTED_KEYS = [${trusted}];`);
    if (path === '/core.js') body = coreAt(BUNDLED);
    res.writeHead(200, { 'content-type': MIME[path.split('.').pop()] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const URL_ = `http://localhost:${server.address().port}/`;

// A canvas camera. __show(dataUrls) draws images side by side on it.
function fakeCamera() {
  const cam = document.createElement('canvas');
  cam.width = 1280; cam.height = 720;
  const g = cam.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cam.width, cam.height);
  let t = 0; // a canvas stream only emits frames when the canvas changes
  setInterval(() => { g.fillStyle = ++t % 2 ? '#fefefe' : '#fff'; g.fillRect(0, 0, 1, 1); }, 33);
  window.__show = async urls => {
    const imgs = await Promise.all(urls.map(u => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = u; })));
    g.fillStyle = '#fff'; g.fillRect(1, 1, cam.width, cam.height);
    g.imageSmoothingEnabled = false;
    const cols = imgs.length > 2 ? 2 : imgs.length, rows = Math.ceil(imgs.length / cols);
    const s = Math.min((cam.height - 20) / rows - 20, (cam.width - 20) / cols - 20);
    imgs.forEach((im, i) => g.drawImage(im, 20 + (i % cols) * (s + 20), 20 + Math.floor(i / cols) * (s + 20), s, s));
  };
  navigator.mediaDevices.getUserMedia = window.__noCamera
    ? async () => { throw new DOMException('no camera', 'NotFoundError'); }
    : async () => { window.__camAsked = (window.__camAsked ?? 0) + 1; return cam.captureStream(30); };
}

const browser = await chromium.launch();
const errors = [];
const ready = page => page.waitForFunction(() => /DECODER READY/.test(document.getElementById('log')?.textContent ?? ''), null, { timeout: 20000 });
async function open(opts = {}, init) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  if (init) await page.addInitScript(init);
  await page.addInitScript(fakeCamera);
  await page.goto(URL_ + '#scan'); // as when arriving from a countdown frame
  await ready(page);
  return { ctx, page };
}

let failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); failed += !ok; };
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const logText = page => page.evaluate(() => document.getElementById('log').textContent);
const logHas = (page, re) => page.waitForFunction(r => new RegExp(r, 'i').test(document.getElementById('log').textContent), re.source, { timeout: 15000 });
const text = (page, frames) => page.evaluate(fs => fs.forEach(text => window.qrboot.worker.postMessage({ text })), frames);
const dialog = page => page.waitForSelector('#dlg:not(.hidden)', { timeout: 20000 }).then(() => page.textContent('#dlg h2'));
const answer = async (page, key) => { await page.keyboard.press(key); await page.waitForSelector('#dlg', { state: 'hidden' }); };
const ran = page => page.evaluate(() => window.__ran ?? 0);

// ---- 1. Boot, policy and signed code ---------------------------------------------------------
const { ctx: ctxA, page: A } = await open({ viewport: { width: 1000, height: 760 } });
const log0 = await logText(A);
check('boots the bundled core and reports protocol, keys, decoder and camera',
  /CORE 100 \(BUNDLED\)/.test(log0) && /PROTOCOL [0-9A-F]{8}/.test(log0) && /CAMERA 1280X720/.test(log0), log0.split('\n').slice(0, 7).join(' | '));
await shot(A, 'boot-log');

await text(A, evil.frames);
await logHas(A, /REJECTED: BAD SIGNATURE/);
check('code from an untrusted signer is rejected, not run', !(await A.evaluate(() => window.__pwned)));

await text(A, lossy((await mod(signer, 1)).frames));
check('the first run of an id asks', /RUN "DEMO" V1\?/i.test(await dialog(A)));
await shot(A, 'dialog');
await answer(A, 'n');
check('N declines, and nothing runs', (await ran(A)) === 0);

await text(A, lossy((await mod(signer, 2)).frames));
await dialog(A);
await answer(A, 'y');
await A.waitForFunction(() => window.__ran === 1);
check('Y runs the module once, with the documented API', (await A.evaluate(() => window.__ctx)) === 'id,modules,log,startScanner,stopScanner');
await text(A, lossy((await mod(signer, 3)).frames));
await A.waitForFunction(() => window.__ran === 2, null, { timeout: 10000 });
check('a newer version from the same signer runs without asking', await A.locator('#dlg').isHidden());
await text(A, (await mod(signer, 0)).frames);
await logHas(A, /REFUSED "DEMO" V0: OLDER THAN V3/);
check('an older version is refused', (await ran(A)) === 2);
await text(A, lossy((await mod(otherSigner, 4)).frames));
await dialog(A);
await answer(A, 'Escape');
check('the same id from another signer asks again, and Escape declines', (await ran(A)) === 2);

// ---- 2. Snake through real pixels: codes drawn on the fake camera, decoded by zxing ------------
async function showFrames(page, frames, perImage, until) {
  for (let i = 0; i < frames.length; i += perImage) {
    await page.evaluate(async fs => {
      const { renderFrames } = await import('/gif.js');
      const urls = fs.map(f => {
        const im = renderFrames([f], { scale: 3 }), c = document.createElement('canvas'), g = c.getContext('2d');
        c.width = im.width; c.height = im.height;
        const d = g.createImageData(im.width, im.height);
        im.frames[0].forEach((v, p) => { d.data.fill(v ? 0 : 255, p * 4, p * 4 + 3); d.data[p * 4 + 3] = 255; });
        g.putImageData(d, 0, 0);
        return c.toDataURL();
      });
      await window.__show(urls);
    }, frames.slice(i, i + perImage));
    await page.waitForTimeout(120);
    if (await until()) return;
  }
}
await showFrames(A, lossy(snake.frames), 2, () => A.locator('#dlg').isVisible());
check('snake received through camera pixels, two codes per image', /RUN "SNAKE"/i.test(await dialog(A)));
await answer(A, 'y');
const game = await (await A.waitForSelector('#app iframe')).contentFrame();
await game.waitForSelector('canvas');
const probe = await game.evaluate(() => {
  const attempt = f => { try { f(); return 'accessible'; } catch (e) { return e.name; } };
  return { origin: window.origin, parent: attempt(() => parent.document.title), storage: attempt(() => localStorage.length) };
});
check('no scanlines over a running app', await A.locator('#lines').isHidden());
check('HTML runs sandboxed: opaque origin, no access to the loader', probe.origin === 'null' && probe.parent === 'SecurityError' && probe.storage === 'SecurityError', JSON.stringify(probe));
const snakeCells = f => f.evaluate(() => {
  const g = document.getElementById('c').getContext('2d'), out = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const [r, gr, b] = g.getImageData(x * 20 + 10, y * 20 + 10, 1, 1).data;
    if (r === 0x33 && gr === 0xff && b === 0x66) out.push([x, y]);
  }
  return out;
});
await A.keyboard.press('ArrowDown');
await A.waitForTimeout(250);
const s1 = await snakeCells(game);
await A.waitForTimeout(250);
const s2 = await snakeCells(game);
check('snake responds to the keyboard inside the sandbox', s1.length > 0 && JSON.stringify(s1) !== JSON.stringify(s2) && new Set(s2.map(c => c[0])).size === 1, `${JSON.stringify(s1)} -> ${JSON.stringify(s2)}`);
await shot(A, 'snake');
await A.click('#app .bar button');

// ---- 3. Library, transmission to a second device, file transfer -------------------------------
await A.keyboard.press('l');
await A.waitForSelector('#lib:not(.hidden)');
const dir = await A.textContent('#lib');
check('the library lists the loader and the received apps', /MJS V100 BUNDLED/.test(dir) && /snake/i.test(dir) && /demo/i.test(dir) && /TX: TRANSMIT/.test(dir) && !/AMBER/.test(dir) && (await A.locator('#lib button[data-a="reset"]').count()) === 0, dir.replace(/\s+/g, ' ').slice(0, 160));
await shot(A, 'library');
await A.click('#lib button[data-a="close"]');
check('tapping CLOSE closes the library', await A.locator('#lib').isHidden());
await A.click('#b-lib');
await A.waitForSelector('#lib:not(.hidden)');

const { page: B } = await open({ viewport: { width: 1000, height: 760 } });
// Copies what A shows on screen onto B's camera until B reacts.
async function relay(until, max = 500) {
  for (let i = 0; i < max; i++) {
    const urls = await A.evaluate(() => [...document.querySelectorAll('#codes canvas')].filter(c => c.width).map(c => c.toDataURL()));
    if (urls.length) await B.evaluate(u => window.__show(u), urls);
    await B.waitForTimeout(90);
    if (await until()) return i;
  }
  return -1;
}
await A.click('#lib button[data-a="tx"][data-k="app:snake"]');
await A.waitForSelector('#tx:not(.hidden)');
check('TX shows one code per frame by default', (await A.locator('#codes canvas').count()) === 1);
await A.keyboard.press('c'); // 1 -> 2 codes per frame
check('C switches to two codes per frame', (await A.locator('#codes canvas').count()) === 2);
await A.waitForTimeout(300);
await shot(A, 'transmit');
let hops = await relay(() => B.locator('#dlg').isVisible());
check('a second device receives snake from the first one\'s screen', hops >= 0 && /RUN "SNAKE"/i.test(await dialog(B)), `after ${hops} images`);
await answer(B, 'n');

await A.keyboard.press('c'); // 2 -> 4 codes per frame
check('C switches to four codes per frame', (await A.locator('#codes canvas').count()) === 4);
await A.keyboard.press('Escape');
await A.click('#b-lib');
await A.click('#lib button[data-a="tx"][data-k="app:demo"]');
await A.waitForSelector('#tx:not(.hidden)');
await B.evaluate(() => window.qrboot.worker.postMessage({ hold: '', ms: 0 }));
hops = await relay(() => B.locator('#dlg').isVisible());
check('four codes per frame decode too', hops >= 0 && /RUN "DEMO"/i.test(await dialog(B)), `after ${hops} images`);
await answer(B, 'n');
await A.keyboard.press('c'); // 4 -> 1
check('and back to one', (await A.locator('#codes canvas').count()) === 1);
await A.keyboard.press('Escape');

// A file, from A to B
const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(Array.from({ length: 30000 }, (_, i) => (i * 7919 + (i >> 5)) & 255))]);
await A.setInputFiles('#f-send', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
await A.waitForSelector('#tx:not(.hidden)');
const fh = await relay(() => B.locator('#dlg').isVisible());
check('a file travels from one screen to the other camera (one code per frame)', fh >= 0 && /FILE "photo.jpg"/i.test(await dialog(B)), `after ${fh} images`);
check('an image file is previewed', (await B.locator('#dlg img.media').count()) === 1);
await B.keyboard.press('k');
await B.waitForFunction(() => document.querySelector('#dlg h2').textContent === 'FILE READY'); // the save prompt follows
await answer(B, 'Escape');
const kept = await B.evaluate(async () => {
  const [f] = await window.qrboot.boot.db.list('file:');
  const { openFile } = await import('/fountain.js');
  return f && [...(await openFile(f.container)).bytes];
});
check('the kept file has the same bytes', !!kept && Buffer.from(kept).equals(photo));
await A.keyboard.press('Escape');

await A.setInputFiles('#f-send', { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>parent.__owned=1</script><h1>hi</h1>') });
await A.waitForSelector('#tx:not(.hidden)');
await relay(() => B.locator('#dlg').isVisible());
check('an HTML file is announced as a file', /FILE "page.html"/i.test(await dialog(B)));
check('and is never rendered', (await B.locator('#dlg .media, #dlg iframe, #app').count()) === 0 && !(await B.evaluate(() => window.__owned)));
await B.keyboard.press('n');
await B.waitForFunction(() => document.querySelector('#dlg h2').textContent === 'FILE READY');
await answer(B, 'Escape');
await A.keyboard.press('Escape');

// ---- 4. Self-update over QR, and rollback --------------------------------------------------
await text(A, lossy((await stream(signer, 'mjs', 'loader', coreAt(BUNDLED), BUNDLED, 1200)).frames));
check('receiving the loader already running says it is up to date', /LOADER UP TO DATE/.test(await dialog(A)));
await answer(A, 'Enter');
check('and stores nothing', !(await A.evaluate(() => window.qrboot.boot.db.get('app:loader'))));
await text(A, lossy((await stream(signer, 'mjs', 'loader', coreAt(50), 50, 1200)).frames));
check('an older loader is ignored, visibly', /OLDER LOADER IGNORED/.test(await dialog(A)));
await answer(A, 'Enter');

await text(A, lossy(core200.frames));
check('a loader update asks first', /UPDATE THE LOADER TO V200/i.test(await dialog(A)));
await Promise.all([A.waitForNavigation({ timeout: 10000 }), A.keyboard.press('y')]);
await ready(A);
check('after the restart the new core runs', /CORE 200 \(STORED\)/.test(await logText(A)) && (await A.evaluate(() => globalThis.__core)) === 200);
await shot(A, 'updated');

await Promise.all([A.waitForNavigation({ timeout: 15000 }), text(A, lossy(core300.frames))]);
check('a later update from the same signer installs and restarts by itself', true);
await ready(A);
await A.keyboard.press('l');
await A.waitForSelector('#lib:not(.hidden)');
const dir2 = await A.textContent('#lib');
check('a core that fails to start is marked bad and the built-in one returns', /V100 BUNDLED, FAILED: 300/i.test(dir2), dir2.replace(/\s+/g, ' ').slice(0, 160));
check('RESET sits in the loader\'s row', (await A.locator('#lib .item').first().locator('button[data-a="reset"]').count()) === 1);
await A.click('#lib button[data-a="reset"]');
check('RESET LOADER asks first', /RESET LOADER/.test(await dialog(A)));
await Promise.all([A.waitForNavigation(), A.keyboard.press('r')]);
await ready(A);
await A.click('#b-lib');
await A.waitForSelector('#lib:not(.hidden)');
check('and then the stored loader is gone', !/FAILED/.test(await A.textContent('#lib')) && (await A.locator('#lib button[data-a="reset"]').count()) === 0);
await A.click('#lib button[data-a="close"]');

// A new deployment appears on the first reload, not the second
BUNDLED = 101;
await A.reload();
await ready(A);
check('a new deployment shows on the first reload', /CORE 101 \(BUNDLED\)/.test(await logText(A)), (await logText(A)).split('\n').find(l => /CORE/.test(l)));

// Offline: the service worker serves everything, and stored apps still run
await ctxA.setOffline(true);
await A.reload();
await ready(A);
await A.keyboard.press('l');
await A.click('#lib button[data-a="open"][data-k="app:snake"]');
await A.waitForSelector('#app iframe');
check('offline: the loader starts and runs snake from the library', true);
await ctxA.setOffline(false);

// ---- 5. Landing: a plain visit shows the loader's own stream; closing it starts the scanner --------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const P = await ctx.newPage();
  await P.addInitScript(fakeCamera);
  await P.goto(URL_);
  await P.waitForSelector('#tx:not(.hidden)');
  await P.waitForTimeout(500);
  check('a plain visit shows the loader\'s own stream, without asking for the camera', /TX "LOADER"/i.test(await P.textContent('#tx .st')) && !(await P.evaluate(() => window.__camAsked)));
  const seen = await P.evaluate(async () => {
    const bmp = await createImageBitmap(document.querySelector('#codes canvas')), w = window.qrboot.worker;
    return new Promise(r => { const h = e => { if (e.data.codes) { w.removeEventListener('message', h); r(e.data.codes.map(c => c.text)); } }; w.addEventListener('message', h); w.postMessage({ image: bmp }, [bmp]); });
  });
  check('each cycle opens with a countdown to the #scan address', /COUNTDOWN [1-3]/.test(await P.textContent('#tx .st')) && seen[0] === URL_ + '#scan', JSON.stringify(seen));
  await shot(P, 'landing');
  await P.waitForFunction(() => !/COUNTDOWN/.test(document.querySelector('#tx .st').textContent), null, { timeout: 8000 });
  check('then the data frames follow', /15 FPS x 1 CODES/i.test(await P.textContent('#tx .st')));
  await P.click('#tx button[data-k="x"]');
  await P.waitForFunction(() => /CAMERA 1280X720/.test(document.getElementById('log').textContent));
  check('closing it starts the scanner', true);
  await P.evaluate(fs => fs.forEach(text => window.qrboot.worker.postMessage({ text })), snake.frames.slice(0, 2));
  await P.waitForFunction(() => /% \[/.test(document.getElementById('status').textContent));
  const fit = await P.evaluate(() => {
    const st = document.getElementById('status'), term = document.getElementById('term');
    return { status: st.scrollWidth <= st.clientWidth, panel: term.getBoundingClientRect().height / innerHeight };
  });
  check('phone: the progress line is not cut off, and the panel leaves most of the screen to the camera', fit.status && fit.panel < 0.4, JSON.stringify(fit));
  await shot(P, 'scanning-phone');
  await ctx.close();
}

// ---- 6. One phone: open a GIF or a video instead of scanning ----------------------------------
const { page: C } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, () => { window.__noCamera = true; });
check('without a camera the loader says so and suggests opening a file', /CAMERA UNAVAILABLE[\s\S]*OPEN GIF/.test(await logText(C)));
await C.setInputFiles('#f-open', { name: 'snake.gif', mimeType: 'image/gif', buffer: Buffer.from(snakeGif) });
check('a GIF opened from the phone\'s files is decoded without a camera', /RUN "SNAKE"/i.test(await dialog(C)));
await shot(C, 'phone');
await answer(C, 'n');

const webm = await C.evaluate(async fs => { // records the Tetris stream as a video, as a screen recording would be
  const { renderFrames } = await import('/gif.js');
  const c = document.createElement('canvas'), g = c.getContext('2d'), img = renderFrames(fs, { scale: 3 });
  c.width = c.height = img.width;
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm', videoBitsPerSecond: 8e6 }), parts = [];
  rec.ondataavailable = e => parts.push(e.data);
  rec.start();
  for (const f of img.frames) {
    const d = g.createImageData(c.width, c.height);
    f.forEach((v, p) => { d.data.fill(v ? 0 : 255, p * 4, p * 4 + 3); d.data[p * 4 + 3] = 255; });
    g.putImageData(d, 0, 0);
    await new Promise(r => setTimeout(r, 150));
  }
  rec.stop();
  await new Promise(r => { rec.onstop = r; });
  const b = new Uint8Array(await new Blob(parts).arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}, tetris.frames.slice(0, 60));
await C.setInputFiles('#f-open', { name: 'recording.webm', mimeType: 'video/webm', buffer: Buffer.from(webm, 'base64') });
check('a screen recording opened from files is decoded too', /RUN "TETRIS"/i.test(await dialog(C)));
await answer(C, 'y');
const tf = await (await C.waitForSelector('#app iframe')).contentFrame();
await tf.waitForSelector('#board');
const fits = await tf.evaluate(() => ['#board', '#pad', '#side'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
check('tetris fits a 390x844 phone with its buttons', fits.every(Boolean), JSON.stringify(fits));
const barOk = await C.evaluate(() => document.querySelector('#app .bar button').getBoundingClientRect().bottom <= document.querySelector('#app iframe').getBoundingClientRect().top);
check('the close button sits in its own bar, above the app, not over it', barOk);
check('its X is underlined like the other shortcuts', await C.evaluate(() => getComputedStyle(document.querySelector('#app .bar button b')).textDecorationLine === 'underline'));
check('tetris: the pad is just the four arrows', (await tf.locator('#pad button').count()) === 4);
const padStyle = f => f.evaluate(() => [...document.querySelectorAll('#pad button')].map(b => { const r = b.getBoundingClientRect(), c = getComputedStyle(b); return [b.textContent, Math.round(r.width), Math.round(r.height), c.fontSize, c.borderTopWidth, c.color]; }).sort().join('|'));
const tetrisPad = await padStyle(tf);
await tf.locator('button[aria-label="Down"]').tap();
await tf.locator('button[aria-label="Down"]').tap();
await C.waitForTimeout(150);
check('tetris: a double tap on ▼ drops the piece and scores', /^Tetris [1-9]/.test(await tf.title()), await tf.title());
await shot(C, 'tetris-phone');
await C.click('#app .bar button');
await C.setInputFiles('#f-open', { name: 'snake2.gif', mimeType: 'image/gif', buffer: Buffer.from(snake2Gif) });
await dialog(C);
await answer(C, 'y');
const sf = await (await C.waitForSelector('#app iframe')).contentFrame();
await sf.waitForSelector('#pad');
const snakePad = await padStyle(sf);
check('snake and tetris use the same arrow pad', snakePad === tetrisPad, snakePad === tetrisPad ? '' : `${snakePad} vs ${tetrisPad}`);
const snakeFits = await sf.evaluate(() => ['#c', '#pad', '#info'].every(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
check('snake fits a 390x844 phone with its arrows', snakeFits);
await shot(C, 'snake-phone');
await C.click('#app .bar button');

// A small phone with Safari's toolbars (375 x 560 visible): nothing cut off, the board gets most of the height
{
  const { page: S } = await open({ viewport: { width: 375, height: 560 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, () => { window.__noCamera = true; });
  await text(S, tetris.frames);
  await dialog(S);
  await answer(S, 'y');
  const f = await (await S.waitForSelector('#app iframe')).contentFrame();
  await f.waitForSelector('#board');
  await S.waitForTimeout(200);
  const m = await f.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect(), inside = s => { const b = r(s); return b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth; };
    return { fits: ['#side', '#board', '#pad'].every(inside), share: r('#board').height / innerHeight, shape: r('#board').height / r('#board').width };
  });
  check('small phone: tetris fits entirely, the board takes over half the height and keeps its shape', m.fits && m.share > 0.5 && Math.abs(m.shape - 2) < 0.05, JSON.stringify(m));
  await shot(S, 'tetris-small-phone');
  await S.context().close();
}

// Phone: the transmit view fits, and a GIF can be exported
await C.click('#b-lib');
await C.click('#lib button[data-a="tx"][data-k="loader"]');
await C.waitForSelector('#tx:not(.hidden)');
await C.waitForTimeout(300);
const inView = await C.evaluate(() => [...document.querySelectorAll('#codes canvas, #tx button')].every(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
check('phone: the loader itself can be transmitted, and everything fits on screen', inView);
await shot(C, 'transmit-phone');
await C.keyboard.press('Escape');
await C.click('#b-lib');
await C.click('#lib button[data-a="gif"][data-k="app:tetris"]');
await dialog(C);
const [download] = await Promise.all([C.waitForEvent('download', { timeout: 30000 }), C.click('#dlg button[data-v="1"]')]);
const g = decodeGif(new Uint8Array(await readFile(await download.path())));
check('phone: GIF export produces a readable GIF', g.frames.length > 10, `${g.frames.length} frames, ${g.width} px`);
check('phone: the saved GIF opens with a 3-second countdown to #scan', [0, 1, 2].every(i => readQr(g.frames[i], g.width, g.height) === URL_ + '#scan') && readQr(g.frames[3], g.width, g.height) !== URL_ + '#scan');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
