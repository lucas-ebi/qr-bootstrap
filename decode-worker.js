// Decoding worker: finds QR codes in images and feeds them to a Receiver, off the main thread.
// In:  { keys: [base64url] }            once, before anything else
//      { image: ImageBitmap }           a camera or video image
//      { gif: Uint8Array }              a whole GIF file, frame by frame
//      { text: string }                 one frame given as text
//      { hold: streamId, ms }           ignore a stream for a while
// Out: { codes: [{ text, box }], ms }   per image, for the viewfinder and statistics
//      { event }                        what Receiver.push returned (progress, opened, file, error)
//      { done: 'gif', frames }          after a GIF
import { Receiver, loadKey } from './fountain.js';
import { decodeGif } from './gif.js';

const base = new URL('./', import.meta.url).href;
let receiver, reader, canvas, ctx;

// Browser detector (Chrome on Android and macOS), else zxing-wasm (several codes per image, fast),
// else jsQR (one code per image). Each returns [{ text, box: { x, y, width, height } }].
async function makeReader() {
  if ('BarcodeDetector' in self) {
    try {
      const d = new BarcodeDetector({ formats: ['qr_code'] });
      return async img => (await d.detect(img)).map(c => ({ text: c.rawValue, box: c.boundingBox }));
    } catch {}
  }
  const pixels = img => {
    if (img.data) return img; // already ImageData
    if (!canvas || canvas.width !== img.width || canvas.height !== img.height) {
      canvas = new OffscreenCanvas(img.width, img.height);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };
  const box = pts => {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  try {
    const z = await import(base + 'vendor/zxing/reader/index.js');
    z.prepareZXingModule({ overrides: { locateFile: (p, pre) => p.endsWith('.wasm') ? base + 'vendor/zxing/reader/' + p : pre + p } });
    await z.getZXingModule();
    const opts = { formats: ['QRCode'], maxNumberOfSymbols: 8, tryHarder: false, tryInvert: false, tryDownscale: true };
    return async img => (await z.readBarcodes(pixels(img), opts)).filter(r => r.isValid)
      .map(r => ({ text: r.text, box: box([r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft]) }));
  } catch (e) {
    console.warn('zxing unavailable, using jsQR', e);
  }
  const src = await (await fetch(base + 'vendor/jsQR.js')).text();
  const jsQR = new Function('self', src + '\nreturn self.jsQR;')({});
  return async img => {
    const { data, width, height } = pixels(img), c = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    return c ? [{ text: c.data, box: box([c.location.topLeftCorner, c.location.topRightCorner, c.location.bottomRightCorner, c.location.bottomLeftCorner]) }] : [];
  };
}

async function feed(text) {
  const event = await receiver.push(text);
  if (!event) return;
  const transfer = event.container ? [event.container.buffer] : [];
  if (event.file) transfer.push(event.file.bytes.buffer);
  postMessage({ event }, transfer.filter((b, i, a) => a.indexOf(b) === i));
}

async function scan(img, image = false) {
  const t = performance.now(), codes = await reader(img).catch(() => []);
  postMessage({ codes, ms: performance.now() - t, image });
  for (const c of codes) await feed(c.text);
}

let queue = Promise.resolve();
onmessage = ({ data: m }) => {
  queue = queue.then(async () => {
    if (m.keys) {
      receiver = new Receiver(await Promise.all(m.keys.map(loadKey)));
      reader = await makeReader();
      postMessage({ ready: true });
    } else if (m.image) {
      try { await scan(m.image, true); } finally { m.image.close?.(); }
    } else if (m.gif) {
      const g = decodeGif(m.gif), rgba = new Uint8ClampedArray(g.width * g.height * 4);
      for (const f of g.frames) {
        for (let i = 0; i < f.length; i++) {
          const k = f[i] * 3, v = (g.palette[k] + g.palette[k + 1] + g.palette[k + 2]) / 3;
          rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
          rgba[i * 4 + 3] = 255;
        }
        await scan(new ImageData(rgba, g.width, g.height));
      }
      postMessage({ done: 'gif', frames: g.frames.length });
    } else if (m.text) {
      await feed(m.text);
    } else if (m.hold) {
      receiver.hold(m.hold, m.ms);
    }
  }).catch(e => postMessage({ failed: e.message }));
};
