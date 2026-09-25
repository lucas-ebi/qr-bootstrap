// Browser end-to-end test (optional, not part of `npm test`):
//   npm i --no-save playwright && npx playwright install chromium && node test/e2e.mjs [screenshot.png]
//
// Real page, real service worker, real fake camera. Only QR *detection* is stubbed: the test
// hands encoder output to the page as if the camera had scanned it.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { keygen, makeFrames, seal } from '../tools/encode.mjs';

const { chromium } = await import('playwright').catch(() => {
  console.error('playwright is not installed: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
});

const root = new URL('..', import.meta.url);
const { jwk, publicKey } = await keygen();
const untrusted = await keygen();
const shuffledWithLoss = frames => frames.filter(() => Math.random() > 0.3).sort(() => Math.random() - 0.5);
const stream = async (key, type, id, payload) => makeFrames(await seal(key, { type, id, payload: Buffer.from(payload) }), { count: 60 });

const noise = Array.from({ length: 150 }, () => '// ' + Math.random().toString(36).repeat(4)).join('\n');
const mod = await stream(jwk, 'mjs', 'demo', `export function init(ctx) { window.__ran = (window.__ran || 0) + 1; window.__ctx = Object.keys(ctx).join(); }\nexport const hello = 'world';\n${noise}`);
const evil = await stream(untrusted.jwk, 'mjs', 'evil', 'export function init() { window.__pwned = 1 }');
const snake = await stream(jwk, 'html', 'snake', await readFile(new URL('examples/snake.html', root)));

const MIME = { html: 'text/html', js: 'text/javascript', json: 'application/json', png: 'image/png' };
const server = http.createServer(async (req, res) => {
  const path = (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]);
  try {
    let body = await readFile(new URL('.' + path, root));
    if (path === '/index.html') body = body.toString().replace('const TRUSTED_KEYS = [];', `const TRUSTED_KEYS = ['${publicKey}'];`);
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
const state = () => page.locator('#state span').first().innerText();
const until = text => page.waitForFunction(t => document.querySelector('#state span').textContent === t, text, { timeout: 10000 });

await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(() => document.querySelector('#state span').textContent.startsWith('Point at'));
check('starts scanning', true);

await feed(evil.frames);
await until('Rejected');
check('payload from an untrusted signer is rejected, not run', (await page.evaluate(() => window.__pwned)) === undefined);

await feed(shuffledWithLoss(mod.frames));
await until('Running');
await feed(mod.frames); // keep "scanning" the finished stream
await page.waitForTimeout(800);
check(`module (${mod.n} blocks) runs exactly once`, (await page.evaluate(() => window.__ran)) === 1);
check('module init() receives the documented API', (await page.evaluate(() => window.__ctx)) === 'id,modules,log,startScanner,stopScanner');
check('service worker registered', await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));
check('no page errors so far', errors.length === 0, errors.join(' | '));

// The snake game arrives as an HTML payload; the loader navigates to it.
await feed(shuffledWithLoss(snake.frames));
await page.waitForURL(/^blob:/, { timeout: 10000 });
await page.waitForSelector('canvas');
check(`snake (${snake.n} blocks) loaded from QR frames`, /^Snake/.test(await page.title()), await page.title());

// Steer down and check the head really moves along one column.
const cells = () => page.evaluate(() => {
  const g = document.getElementById('c').getContext('2d'), out = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const [r, gr, b] = g.getImageData(x * 20 + 10, y * 20 + 10, 1, 1).data;
    if (r === 0x60 && gr === 0xa5 && b === 0xfa) out.push([x, y]);
  }
  return out;
});
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(250);
const a = await cells();
await page.waitForTimeout(250);
const b = await cells();
check('snake responds to input and moves', a.length > 0 && new Set(b.map(c => c[0])).size === 1 && JSON.stringify(a) !== JSON.stringify(b), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

await browser.close();
server.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
