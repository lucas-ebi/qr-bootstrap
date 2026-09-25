// Browser end-to-end test (optional, not part of `npm test`):
//   npm i --no-save playwright && npx playwright install chromium && node test/e2e.mjs [screenshot-dir]
//
// Scenario 1: real page, real service worker, fake camera. QR *detection* is stubbed: the test
// hands encoder output to the page as if the camera had scanned it.
// Scenario 2: no BarcodeDetector at all, so the loader falls back to jsQR. The "camera" is a
// canvas stream that plays the real GIF made by tools/gif.mjs (countdown intro included), decoded
// by Chromium's own GIF decoder, so real pixels get decoded and the intro frames must be ignored.
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { keygen, makeFrames, seal } from '../tools/encode.mjs';
import { encodeGif, renderFrames, renderIntro } from '../tools/gif.mjs';

const { chromium } = await import('playwright').catch(() => {
  console.error('playwright is not installed: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
});

const root = new URL('..', import.meta.url);
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

const signer = await keygen();
const otherSigner = await keygen(); // also trusted by the loader, to test per-signer approval
const stranger = await keygen();    // not trusted
const shuffledWithLoss = frames => frames.filter(() => Math.random() > 0.3).sort(() => Math.random() - 0.5);
const stream = async (who, type, id, payload, version) =>
  makeFrames(await seal(who.jwk, { type, id, payload: Buffer.from(payload), version }), { count: 60 });

const noise = Array.from({ length: 150 }, () => '// ' + Math.random().toString(36).repeat(4)).join('\n');
const mod = (who, version) => stream(who, 'mjs', 'demo', `export function init(ctx) { window.__ran = (window.__ran || 0) + 1; window.__ctx = Object.keys(ctx).join(); }\nexport const hello = 'world';\n${noise}`, version);
const evil = await stream(stranger, 'mjs', 'evil', 'export function init() { window.__pwned = 1 }', 1);
const snake = await stream(signer, 'html', 'snake', await readFile(new URL('examples/snake.html', root)), 1);

const img = renderFrames(snake.frames.slice(0, 30), { scale: 8 });
const intro = renderIntro('https://lucas-ebi.github.io/qr-bootstrap/', [3, 2, 1], img.width);
const snakeGif = encodeGif({ ...img, frames: [...intro, ...img.frames] }, { delay: 17, delays: [100, 100, 100] });

const MIME = { html: 'text/html', js: 'text/javascript', json: 'application/json', png: 'image/png' };
const trusted = [signer, otherSigner].map(k => `'${k.publicKey}'`).join(', ');
const server = http.createServer(async (req, res) => {
  if (req.url === '/__snake.gif') return res.writeHead(200, { 'content-type': 'image/gif' }).end(snakeGif);
  const path = (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]);
  try {
    let body = await readFile(new URL('.' + path, root));
    if (path === '/index.html') body = body.toString().replace('const TRUSTED_KEYS = [];', `const TRUSTED_KEYS = [${trusted}];`);
    res.writeHead(200, { 'content-type': MIME[path.split('.').pop()] ?? 'text/plain' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await (await browser.newContext({ permissions: ['camera'] })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript(() => {
  window.__queue = [];
  window.BarcodeDetector = class {
    async detect() {
      const raw = window.__queue.shift();
      return raw ? [{ rawValue: raw, boundingBox: { x: 100, y: 80, width: 200, height: 200 } }] : [];
    }
  };
});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); failed += !ok; };
const feed = frames => page.evaluate(q => window.__queue.push(...q), frames);
const ran = () => page.evaluate(() => window.__ran ?? 0);
const dialogOpen = () => page.locator('#ask').isVisible();
const until = (text, count) => page.waitForFunction(([t, c]) => {
  const s = document.querySelectorAll('#state span');
  return s[0].textContent === t && (c === undefined || s[1].textContent === c);
}, [text, count], { timeout: 10000 });
const shot = name => shots && page.screenshot({ path: `${shots}/${name}.png` });

await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(() => document.querySelector('#state span').textContent.startsWith('Point at'));
check('starts scanning', true);

// 1. A signer we do not trust
await feed(evil.frames);
await until('Rejected', 'bad signature');
check('payload from an untrusted signer is rejected, not run', (await page.evaluate(() => window.__pwned)) === undefined);

// 2. First run of an app id asks; Cancel means it does not run
await feed(shuffledWithLoss((await mod(signer, 1)).frames));
await until('Waiting for confirmation');
check('first run asks for confirmation', await dialogOpen());
await shot('confirm-dialog');
await page.click('#ask-no');
await until('Cancelled');
check('Cancel does not run the payload', (await ran()) === 0 && !(await dialogOpen()));

// 3. Run: runs exactly once, even while the finished stream keeps being scanned
const v2 = await mod(signer, 2);
await feed(shuffledWithLoss(v2.frames));
await until('Waiting for confirmation');
await page.click('#ask-yes');
await until('Running', 'demo');
await feed(v2.frames);
await page.waitForTimeout(800);
check(`approved module (${v2.n} blocks) runs exactly once`, (await ran()) === 1);
check('module init() receives the documented API', (await page.evaluate(() => window.__ctx)) === 'id,modules,log,startScanner,stopScanner');

// 4. A newer version from the same signer updates silently
await feed(shuffledWithLoss((await mod(signer, 3)).frames));
await page.waitForFunction(() => window.__ran === 2, null, { timeout: 10000 });
check('newer version from the same signer runs without asking', !(await dialogOpen()));

// 5. Replay of an older validly signed version is refused
await feed((await mod(signer, 0)).frames); // version 0 < 3
await until('Rejected', 'older version');
check('older version is refused (replay protection)', (await ran()) === 2);

// 6. Same app id from a different trusted signer asks again
await feed(shuffledWithLoss((await mod(otherSigner, 4)).frames));
await until('Waiting for confirmation');
check('same id from a different signer asks again', await dialogOpen());
await page.click('#ask-no');
await until('Cancelled');
check('and declining keeps it from running', (await ran()) === 2);

check('service worker registered', await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));
check('no page errors so far', errors.length === 0, errors.join(' | '));

// 7. The snake game (HTML payload) runs inside a sandboxed iframe
await feed(shuffledWithLoss(snake.frames));
await until('Waiting for confirmation');
await page.click('#ask-yes');
await page.waitForSelector('#app iframe');
const frame = await (await page.$('#app iframe')).contentFrame();
await frame.waitForSelector('canvas');
check(`snake (${snake.n} blocks) loaded from QR frames`, /^Snake/.test(await frame.title()), await frame.title());

const probe = await frame.evaluate(() => {
  const attempt = f => { try { f(); return 'accessible'; } catch (e) { return e.name; } };
  return {
    origin: window.origin,
    parent: attempt(() => parent.document.title),
    storage: attempt(() => localStorage.length),
  };
});
check('sandboxed: opaque origin, no access to the loader or its storage',
  probe.origin === 'null' && probe.parent === 'SecurityError' && probe.storage === 'SecurityError', JSON.stringify(probe));

const snakeCells = f => f.evaluate(() => {
  const g = document.getElementById('c').getContext('2d'), out = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const [r, gr, b] = g.getImageData(x * 20 + 10, y * 20 + 10, 1, 1).data;
    if (r === 0x60 && gr === 0xa5 && b === 0xfa) out.push([x, y]);
  }
  return out;
});
const cells = () => snakeCells(frame);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(250);
const a = await cells();
await page.waitForTimeout(250);
const b = await cells();
check('snake responds to keyboard input inside the sandbox', a.length > 0 && new Set(b.map(c => c[0])).size === 1 && JSON.stringify(a) !== JSON.stringify(b), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
await shot('snake-sandboxed');

await page.click('#app button');
await page.waitForFunction(() => !document.getElementById('app') && document.querySelector('#state span').textContent.startsWith('Point at'));
check('close button returns to scanning', true);

// ---- Scenario 2: no BarcodeDetector -> jsQR fallback, fed by the real GIF -------------------------
{
  // Emulate a phone (touch, coarse pointer, portrait) so the on-screen controls are exercised too.
  const ctx2 = await browser.newContext({ permissions: ['camera'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => errors.push(e.message));
  await page2.addInitScript(() => {
    delete window.BarcodeDetector; // as on desktop Linux/Windows Chrome, Firefox and Safari
    const cam = document.createElement('canvas');
    cam.width = 640; cam.height = 480;
    const g = cam.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cam.width, cam.height);
    // A canvas stream only emits frames when the canvas changes, and a <video> still waiting for
    // its first frame holds up "load". Toggle a corner pixel (inside the QR's white quiet zone).
    let t = 0;
    setInterval(() => { g.fillStyle = ++t % 2 ? '#fefefe' : '#fff'; g.fillRect(0, 0, 1, 1); }, 40);
    window.__cam = cam;
    navigator.mediaDevices.getUserMedia = async () => cam.captureStream(30);
  });
  await page2.goto(`http://localhost:${server.address().port}/`);
  const started = Date.now();
  const gifInfo = await page2.evaluate(async () => { // play the GIF's frames on the "camera", 10 per second, forever
    const cam = window.__cam, g = cam.getContext('2d');
    const decoder = new ImageDecoder({ data: await (await fetch('/__snake.gif')).arrayBuffer(), type: 'image/gif' });
    await decoder.tracks.ready;
    const n = decoder.tracks.selectedTrack.frameCount, frames = [];
    for (let i = 0; i < n; i++) frames.push(await createImageBitmap((await decoder.decode({ frameIndex: i })).image));
    let i = 0;
    const draw = () => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, cam.width, cam.height);
      g.drawImage(frames[i++ % n], (cam.width - cam.height) / 2, 0, cam.height, cam.height);
    };
    draw();
    setInterval(draw, 100);
    return { frames: n, loops: decoder.tracks.selectedTrack.animated };
  });
  check('fallback: Chromium decodes the standalone GIF (intro + data frames)', gifInfo.frames === 3 + 30, JSON.stringify(gifInfo));

  await page2.waitForSelector('#ask:not(.hidden)', { timeout: 30000 });
  const info = await page2.evaluate(() => ({ nativeDetector: 'BarcodeDetector' in window, jsQR: typeof window.jsQR }));
  check('fallback: jsQR loaded and used instead of BarcodeDetector', !info.nativeDetector && info.jsQR === 'function', JSON.stringify(info));
  check('fallback: frames scanned from the GIF form a signed stream, asking for confirmation', true, `(${Date.now() - started} ms from first frame)`);
  await page2.click('#ask-yes');
  await page2.waitForSelector('#app iframe');
  const game = await (await page2.$('#app iframe')).contentFrame();
  await game.waitForSelector('canvas');
  check('fallback: the snake game runs after being received through jsQR', /^Snake/.test(await game.title()), await game.title());

  // Touch controls, on the emulated phone
  check('touch: on-screen D-pad is shown on a touch device', await game.locator('#pad').isVisible());
  await game.locator('button[aria-label="Down"]').tap();
  await page2.waitForTimeout(250);
  const d1 = await snakeCells(game);
  await page2.waitForTimeout(250);
  const d2 = await snakeCells(game);
  check('touch: tapping a D-pad button steers the snake', d1.length > 0 && new Set(d2.map(c => c[0])).size === 1 && JSON.stringify(d1) !== JSON.stringify(d2), `${JSON.stringify(d1)} -> ${JSON.stringify(d2)}`);

  const cdp = await ctx2.newCDPSession(page2);
  const touchAt = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 0 }] });
  await touchAt('touchStart', 100, 300);
  await touchAt('touchMove', 200, 300);
  await touchAt('touchMove', 300, 300);
  await touchAt('touchEnd');
  await page2.waitForTimeout(300);
  const r1 = await snakeCells(game);
  await page2.waitForTimeout(250);
  const r2 = await snakeCells(game);
  check('touch: a swipe right steers the snake', r1.length > 0 && new Set(r2.map(c => c[1])).size === 1 && JSON.stringify(r1) !== JSON.stringify(r2), `${JSON.stringify(r1)} -> ${JSON.stringify(r2)}`);
  await page2.screenshot({ path: shots ? `${shots}/snake-mobile.png` : undefined });
}

await browser.close();
server.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
