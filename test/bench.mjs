// Throughput benchmark (optional; needs Playwright like test/e2e.mjs):
//   node test/bench.mjs [seconds=3] [slowdown=3]
//
// Simulates a telephone camera filming a telephone screen that shows the transmit view, and
// measures how many distinct symbols per second reach the receiver for each combination of
// bytes per code, codes per image and images per second. The model:
//   - geometry: the sender's portrait screen (390 x 844 CSS pixels, laid out as core.js does)
//     fills 70 % of the height of a 1920 x 1080 camera image;
//   - optics: a Gaussian blur of 0.8 px, contrast reduced to the range 40..215, noise of +-12;
//   - timing: the camera takes 30 images per second with a rolling shutter that reads out
//     top to bottom over 25 ms, so an image straddling a display change is torn at the row
//     where the change happened;
//   - decoding: zxing-wasm, as in decode-worker.js. The receiver takes the next camera image
//     only when idle, and its decoding time is the measured time multiplied by `slowdown`,
//     to stand for a telephone's slower processor.
// Real cameras add motion, focus and moiré, so absolute figures are optimistic; the ranking of
// settings is what the defaults are based on.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const { chromium } = await import('playwright');
const [T = 3, SLOW = 3] = process.argv.slice(2).map(Number);
const root = new URL('..', import.meta.url);
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0] === '/' ? '/test/bench.html' : req.url.split('?')[0];
  const type = { js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', html: 'text/html' }[p.split('.').pop()];
  if (p === '/test/bench.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><body>');
  try { res.writeHead(200, { 'content-type': type ?? 'application/octet-stream' }).end(await readFile(new URL('.' + p, root))); }
  catch { res.writeHead(404).end(); }
}).listen(0);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => m.type() === 'error' && console.error(m.text()));
await page.goto(`http://localhost:${server.address().port}/`);
console.log(`| bytes/code | QR version | codes/image | images/s | offered codes/s | received codes/s | KB/s | decode ms (desktop) |`);
console.log(`|---:|---:|---:|---:|---:|---:|---:|---:|`);
await page.exposeFunction('report', r => console.log(`| ${r.block} | ${r.version} | ${r.codes} | ${r.fps} | ${r.offered} | ${r.received} | ${r.kbps} | ${r.decodeMs} |`));

const rows = await page.evaluate(async ({ T, SLOW }) => {
  const F = await import('/fountain.js'), G = await import('/gif.js');
  const z = await import('/vendor/zxing/reader/index.js');
  z.prepareZXingModule({ overrides: { locateFile: p => '/vendor/zxing/reader/' + p } });
  await z.getZXingModule();
  const opts = { formats: ['QRCode'], maxNumberOfSymbols: 8, tryHarder: false, tryInvert: false, tryDownscale: true };

  const container = crypto.getRandomValues(new Uint8Array(60000));
  const W = 1920, H = 1080, screenH = H * 0.7, k = screenH / 844, screenW = 390 * k, x0 = (W - screenW) / 2, y0 = (H - screenH) / 2;
  const cam = new OffscreenCanvas(W, H), cg = cam.getContext('2d', { willReadFrequently: true });
  const scr = new OffscreenCanvas(Math.round(screenW), Math.round(screenH)), sg = scr.getContext('2d');

  // Draws one displayed image (the codes laid out as core.js does in portrait) onto `scr`.
  const layoutOf = codes => {
    const cols = codes === 4 ? 2 : 1, rows = Math.ceil(codes / cols);
    return { cols, rows, size: Math.floor(Math.min((390 - 40) / cols, (844 - 170) / rows) - 12) };
  };
  const bitmaps = new Map();
  async function display(texts, codes) {
    const { cols, size } = layoutOf(codes), img = G.renderFrames(texts, { scale: 1, ecc: 'L' });
    sg.fillStyle = '#050805';
    sg.fillRect(0, 0, scr.width, scr.height);
    sg.imageSmoothingEnabled = false;
    for (let i = 0; i < texts.length; i++) {
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'), d = g.createImageData(img.width, img.height);
      img.frames[i].forEach((v, p) => { d.data.fill(v ? 0 : 255, p * 4, p * 4 + 3); d.data[p * 4 + 3] = 255; });
      g.putImageData(d, 0, 0);
      const x = (20 + (i % cols) * (size + 12)) * k, y = (20 + Math.floor(i / cols) * (size + 12)) * k;
      sg.drawImage(c, x, y, size * k, size * k);
    }
    return createImageBitmap(scr);
  }

  // A camera image taken at time t: rows read out top to bottom over `readout` seconds.
  async function capture(frameAt, t, readout = 0.025) {
    const a = frameAt(t), b = frameAt(t + readout);
    cg.fillStyle = '#222';
    cg.fillRect(0, 0, W, H);
    cg.filter = 'blur(0.8px)';
    const ia = await a.bmp, ib = await b.bmp;
    if (a.i === b.i) cg.drawImage(ia, x0, y0);
    else { // torn: the change happened part-way through the readout
      const split = Math.round(((b.switchAt - t) / readout) * H);
      cg.save(); cg.beginPath(); cg.rect(0, 0, W, split); cg.clip(); cg.drawImage(ia, x0, y0); cg.restore();
      cg.save(); cg.beginPath(); cg.rect(0, split, W, H - split); cg.clip(); cg.drawImage(ib, x0, y0); cg.restore();
    }
    cg.filter = 'none';
    const im = cg.getImageData(0, 0, W, H), d = im.data;
    for (let p = 0; p < d.length; p += 4) {
      const v = 40 + d[p] * 0.7 + (Math.random() - 0.5) * 24;
      d[p] = d[p + 1] = d[p + 2] = v;
    }
    return im;
  }

  const out = [];
  for (const block of [700, 1200, 2000]) {
    const enc = await F.encoder(container, block);
    for (const codes of [1, 2]) {
      for (const fps of [8, 12, 20]) {
        let seed = 1;
        const shown = [];
        const frameAt = t => {
          const i = Math.floor(t * fps);
          while (shown.length <= i) {
            const texts = Array.from({ length: codes }, () => enc.frame(seed++));
            shown.push({ i: shown.length, texts, switchAt: shown.length / fps, bmp: display(texts, codes) });
          }
          return shown[i];
        };
        const got = new Set();
        let busyUntil = 0, decodes = 0, ms = 0;
        for (let t = 0; t < T; t += 1 / 30) {
          if (t < busyUntil) continue;
          const im = await capture(frameAt, t);
          const t0 = performance.now(), res = await z.readBarcodes(im, opts), dt = performance.now() - t0;
          decodes++;
          ms += dt;
          busyUntil = t + (dt * SLOW) / 1000;
          for (const r of res) if (r.isValid) got.add(r.text.split('/')[4]);
        }
        const symbols = got.size / T;
        const row = { block: enc.b, version: G.renderFrames([enc.frame(1)], { scale: 1 }).version, codes, fps, offered: codes * fps, received: +symbols.toFixed(1), kbps: +(symbols * enc.b / 1024).toFixed(1), decodeMs: Math.round(ms / decodes) };
        out.push(row);
        await window.report(row);
        shown.forEach(s => s.bmp.then(b => b.close()));
      }
    }
  }
  return out;
}, { T, SLOW });

const best = rows.reduce((a, b) => (b.kbps > a.kbps ? b : a));
console.log(`\nbest: ${best.block} B/code, ${best.codes} codes/image, ${best.fps} images/s -> ${best.kbps} KB/s`);
await browser.close();
server.close();
